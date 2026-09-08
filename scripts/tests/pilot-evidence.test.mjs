import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  PILOT_INPUT_SCHEMA,
  PilotEvidenceError,
  buildPilotReport,
  parsePilotInput,
  runPilotEvidence,
} from '../pilot-evidence.mjs';

const execFile = promisify(execFileCallback);
const pilotScript = fileURLToPath(new URL('../pilot-evidence.mjs', import.meta.url));

function session(sessionToken, netValueSeconds, overrides = {}) {
  return {
    sessionToken,
    status: 'completed',
    lifecycle: { consentGranted: true, previewObserved: true, commitObserved: true, revokeObserved: true, retentionObserved: 'revoked' },
    outcome: 'edited',
    correctionSeconds: 18,
    netValueSeconds,
    ...overrides,
  };
}

function input(participantCount = 2) {
  return {
    schemaVersion: PILOT_INPUT_SCHEMA,
    studyId: 'm2-readonly-pilot-v1',
    sourceAdapter: 'readonly-test-results',
    reviewerToken: 'reviewer-1',
    participants: Array.from({ length: participantCount }, (_, index) => ({
      participantToken: `participant-${index + 1}`,
      sessions: [session(`session-${index + 1}-a`, 30 + index), session(`session-${index + 1}-b`, 10 + index)],
    })),
  };
}

test('pilot input is strict and contains no free text or raw source fields', () => {
  const parsed = parsePilotInput(input());
  assert.equal(parsed.participants.length, 2);
  assert.throws(() => parsePilotInput({ ...input(), participants: [{ ...input(1).participants[0], name: 'secret person' }] }), (error) => error instanceof PilotEvidenceError && error.code === 'ERR_PILOT_FIELD_FORBIDDEN');
  assert.throws(() => parsePilotInput({ ...input(), reviewerToken: 'reviewer with pii' }), (error) => error instanceof PilotEvidenceError && error.code === 'ERR_PILOT_TOKEN_INVALID');
});

test('report computes participant-level NetValue summary and a deterministic confidence interval', () => {
  const value = input(3);
  const first = buildPilotReport(value, { generatedAt: '2026-09-08T00:00:00.000Z', inputHash: `sha256:${'a'.repeat(64)}` });
  const second = buildPilotReport(value, { generatedAt: '2026-09-08T00:00:00.000Z', inputHash: `sha256:${'a'.repeat(64)}` });
  assert.deepEqual(first, second);
  assert.equal(first.status, 'RECORDED');
  assert.equal(first.decision, 'CONDITIONAL');
  assert.equal(first.sample.eligibleParticipantCount, 3);
  assert.equal(first.sample.eligibleSessionCount, 6);
  assert.equal(first.netValueSeconds.medianSeconds, 21);
  assert.equal(first.netValueConfidence95.sampleUnit, 'participant-mean');
  assert.equal(first.traceBinding.result, 'NOT_RUN');
});

test('not-run sessions remain explicit and cannot become a pilot pass', () => {
  const value = input(1);
  value.participants[0].sessions[1] = {
    sessionToken: 'session-not-run', status: 'not-run', lifecycle: { consentGranted: false, previewObserved: false, commitObserved: false, revokeObserved: false, retentionObserved: 'not-run' },
    outcome: 'not-run', correctionSeconds: null, netValueSeconds: null,
  };
  const report = buildPilotReport(value, { generatedAt: '2026-09-08T00:00:00.000Z' });
  assert.equal(report.status, 'RECORDED');
  assert.equal(report.decision, 'CONDITIONAL');
  assert.ok(report.decisionReasons.includes('INSUFFICIENT_SAMPLE'));
  assert.equal(report.sample.eligibleSessionCount, 1);
});

test('runner writes report, hash binding, and a payload-free log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proagi-pilot-'));
  try {
    const inputPath = join(root, 'input.json');
    const outputDir = join(root, 'out');
    await writeFile(inputPath, `${JSON.stringify(input(2))}\n`, 'utf8');
    const result = await runPilotEvidence({ inputPath, outputDir, generatedAt: '2026-09-08T00:00:00.000Z' });
    const binding = JSON.parse(await readFile(result.bindingPath, 'utf8'));
    const log = await readFile(result.logPath, 'utf8');
    assert.match(result.artifactHash, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(binding.artifactHashes[0], result.artifactHash);
    assert.match(log, /traceResult=NOT_RUN/u);
    assert.equal(log.includes('participant-1'), false);
    assert.equal(log.includes('session-1-a'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI emits a machine-readable result without exposing input values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proagi-pilot-cli-'));
  try {
    const inputPath = join(root, 'input.json');
    const outputDir = join(root, 'out');
    await writeFile(inputPath, `${JSON.stringify(input(1))}\n`, 'utf8');
    const result = await execFile(process.execPath, [pilotScript, '--input', inputPath, '--output', outputDir, '--generated-at', '2026-09-08T00:00:00.000Z'], { encoding: 'utf8' });
    assert.match(result.stdout, /M2_PILOT_EVIDENCE status=RECORDED decision=CONDITIONAL artifactHash=sha256:/u);
    assert.equal(result.stdout.includes('participant-1'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid input writes only a safe failure code to the log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proagi-pilot-invalid-'));
  try {
    const inputPath = join(root, 'input.json');
    const outputDir = join(root, 'out');
    await writeFile(inputPath, JSON.stringify({ ...input(1), secret: 'canary-value' }), 'utf8');
    await assert.rejects(runPilotEvidence({ inputPath, outputDir }), (error) => error instanceof PilotEvidenceError && error.code === 'ERR_PILOT_FIELD_FORBIDDEN');
    const log = await readFile(join(outputDir, 'pilot-evidence.log'), 'utf8');
    assert.match(log, /code=ERR_PILOT_FIELD_FORBIDDEN/u);
    assert.equal(log.includes('canary-value'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
