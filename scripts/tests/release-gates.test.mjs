import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile, access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_GITHUB_ARTIFACT_RETENTION_DAYS, validateStructuredReport, validateSuiteSources, VERIFICATION_REGISTRY, verificationCommandsForTier, verificationRetentionDaysForTier } from '../check-suites.mjs';
import { runCommand } from '../verify-tier.mjs';

const execFile = promisify(execFileCallback);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function fixture() {
  return mkdtemp(join(tmpdir(), 'proagi-gate-'));
}

test('verification registry provides executable commands and retention policy for every tier', () => {
  for (const tier of ['pr', 'nightly', 'release']) {
    const commands = verificationCommandsForTier(tier);
    assert.ok(commands.length > 0);
    const retentionDays = verificationRetentionDaysForTier(tier);
    assert.equal(Number.isSafeInteger(retentionDays), true);
    assert.ok(retentionDays >= 1 && retentionDays <= MAX_GITHUB_ARTIFACT_RETENTION_DAYS);
    commands.forEach((command) => {
      assert.equal(typeof command.executable, 'string');
      assert.ok(Array.isArray(command.args));
      assert.equal(Number.isSafeInteger(command.timeoutMs), true);
      assert.ok(command.timeoutMs > 0);
      assert.equal('shell' in command, false);
    });
  }
  assert.equal(verificationRetentionDaysForTier('release'), MAX_GITHUB_ARTIFACT_RETENTION_DAYS);
  assert.deepEqual(verificationCommandsForTier('nightly').slice(0, verificationCommandsForTier('pr').length), verificationCommandsForTier('pr'));
  assert.deepEqual(Object.keys(VERIFICATION_REGISTRY.tiers).sort(), ['nightly', 'pr', 'release']);
});

test('application runtime core stays independent from browser composition and adapters', async () => {
  const runtimeSource = await readFile(join(repoRoot, 'src/application/browserInsightRuntime.ts'), 'utf8');
  const storagePortSource = await readFile(join(repoRoot, 'src/application/storagePort.ts'), 'utf8');
  assert.equal(runtimeSource.includes('browserRuntimeComposition'), false);
  assert.equal(runtimeSource.includes('../adapters/'), false);
  assert.equal(storagePortSource.includes('../adapters/'), false);
  assert.equal(storagePortSource.includes('IDBValidKey'), false);
});

test('verification commands time out and terminate their process group', { skip: process.platform === 'win32' }, async () => {
  const root = await fixture();
  const scriptPath = join(root, 'never-exits.mjs');
  const heartbeatPath = join(root, 'heartbeat.log');
  const descendantPidPath = join(root, 'descendant.pid');
  try {
    await writeFile(scriptPath, `
      import { appendFileSync, writeFileSync } from 'node:fs';
      import { spawn } from 'node:child_process';
      const [mode, heartbeatPath, descendantPidPath] = process.argv.slice(2);
      process.on('SIGTERM', () => {});
      if (mode === 'parent') {
        const descendant = spawn(process.execPath, [process.argv[1], 'descendant', heartbeatPath, descendantPidPath], { stdio: 'ignore' });
        writeFileSync(descendantPidPath, String(descendant.pid));
      }
      setInterval(() => appendFileSync(heartbeatPath, mode), 20);
    `);

    const startedAt = Date.now();
    const result = await runCommand(
      { executable: process.execPath, args: [scriptPath, 'parent', heartbeatPath, descendantPidPath], timeoutMs: 250 },
      { terminationGraceMs: 100 },
    );
    assert.deepEqual(result, { status: 'timed-out', code: null, signal: 'SIGKILL', timeoutMs: 250 });
    assert.ok(Date.now() - startedAt < 2_000);

    const heartbeatAtExit = await readFile(heartbeatPath, 'utf8');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    assert.equal(await readFile(heartbeatPath, 'utf8'), heartbeatAtExit);
    assert.match(heartbeatAtExit, /parent/);
    assert.match(heartbeatAtExit, /descendant/);
  } finally {
    const descendantPid = await readFile(descendantPidPath, 'utf8').catch(() => undefined);
    if (descendantPid) {
      try { process.kill(Number(descendantPid), 'SIGKILL'); } catch { /* best-effort cleanup */ }
    }
    await rm(root, { recursive: true, force: true });
  }
});

const validVitest = {
  success: true,
  numTotalTestSuites: 1,
  numPassedTestSuites: 1,
  numFailedTestSuites: 0,
  numPendingTestSuites: 0,
  numTodoTests: 0,
  numTotalTests: 1,
  numPassedTests: 1,
  numFailedTests: 0,
  numPendingTests: 0,
  testResults: [{ name: 'tests/unit/gate.test.ts', status: 'passed', assertionResults: [{ status: 'passed' }] }],
};

test('suite source validation rejects only, skip, and todo modifiers', async () => {
  for (const modifier of ['only', 'skip', 'todo']) {
    const root = await fixture();
    try {
      await mkdir(join(root, 'tests', 'unit'), { recursive: true });
      await writeFile(join(root, 'tests', 'unit', 'gate.test.ts'), `test.${modifier}('blocked', () => {});\n`);
      await assert.rejects(validateSuiteSources(root, ['unit']), new RegExp(`\\.${modifier}`));
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('structured Vitest reports reject malformed, zero, and skipped results', async () => {
  const root = await fixture();
  try {
    for (const [name, value, message] of [
      ['malformed.json', '{', /malformed JSON/],
      ['zero.json', JSON.stringify({ ...validVitest, numTotalTests: 0, numPassedTests: 0, testResults: [] }), /zero results/],
      ['skip.json', JSON.stringify({ ...validVitest, numPassedTests: 0, numPendingTests: 1, testResults: [{ name: 'tests/unit/gate.test.ts', assertionResults: [{ status: 'skipped' }] }] }), /not passed|skipped\/todo/],
    ]) {
      const path = join(root, name);
      await writeFile(path, value);
      await assert.rejects(validateStructuredReport(path, 'vitest', root), message);
    }
    await mkdir(join(root, 'tests', 'privacy'), { recursive: true });
    await writeFile(join(root, 'tests', 'privacy', 'gate.test.ts'), "test('gate', () => {});\n");
    const missingSuite = join(root, 'missing-suite.json');
    await writeFile(missingSuite, JSON.stringify({ ...validVitest, testResults: [{ name: `${root}/tests/unit/a.test.ts`, status: 'passed', assertionResults: [{ status: 'passed' }] }] }));
    await assert.rejects(validateStructuredReport(missingSuite, 'vitest', root, ['privacy']), /missing required suite: privacy/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('structured Playwright reports require every registry spec and project attempt', async () => {
  const root = await fixture();
  try {
    await mkdir(join(root, 'tests', 'e2e'), { recursive: true });
    await writeFile(join(root, 'tests', 'e2e', 'app.spec.ts'), "test('renders the canonical AppShell order and eight-part Orb', async () => {});\n");
    const reports = join(root, 'reports');
    await mkdir(reports, { recursive: true });
    const testFor = (projectName) => ({ projectName, expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed', errors: [] }] });
    const valid = {
      config: { projects: [{ name: 'chromium-desktop' }, { name: 'chromium-320' }] },
      suites: [{ file: 'tests/e2e/app.spec.ts', specs: [{ title: 'renders the canonical AppShell order and eight-part Orb', ok: true, tests: [testFor('chromium-desktop'), testFor('chromium-320')] }] }],
      stats: { expected: 2, skipped: 0, unexpected: 0, flaky: 0 }, errors: [],
    };
    const validPath = join(reports, 'valid.json');
    await writeFile(validPath, JSON.stringify(valid));
    await assert.doesNotReject(validateStructuredReport(validPath, 'playwright', root, ['e2e'], { requiredProjects: ['chromium-desktop', 'chromium-320'], requireAllE2E: true }));

    const cases = [
      [{ ...valid, stats: { ...valid.stats, unexpected: 1 } }, /stats/],
      [{ ...valid, suites: [{ ...valid.suites[0], specs: [{ ...valid.suites[0].specs[0], tests: [testFor('chromium-desktop')] }] }] }, /every required project/],
      [{ ...valid, suites: [{ ...valid.suites[0], specs: [{ ...valid.suites[0].specs[0], ok: false }] }] }, /not ok/],
    ];
    for (const [index, [value, message]] of cases.entries()) {
      const path = join(reports, `invalid-${index}.json`);
      await writeFile(path, JSON.stringify(value));
      await assert.rejects(validateStructuredReport(path, 'playwright', root, ['e2e'], { requiredProjects: ['chromium-desktop', 'chromium-320'], requireAllE2E: true }), message);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('artifact scanner emits a payload-free quarantine receipt and destroys canary payloads', async () => {
  const runId = `scan-canary-${Date.now()}`;
  const root = await mkdtemp(join(repoRoot, '.artifact-scan-test-'));
  const quarantine = join(repoRoot, '.artifact-scan-quarantine-test-' + Date.now());
  try {
    await writeFile(join(root, 'leak.log'), 'restricted-canary-test-value\n');
    await assert.rejects(
      execFile(process.execPath, [resolve(repoRoot, 'scripts/scan-artifacts.mjs'), '--root', root, '--quarantine', quarantine], {
        cwd: repoRoot,
        env: { ...process.env, EVIDENCE_RUN_ID: runId, EVIDENCE_TIER: 'pr', EVIDENCE_CANARY_VALUES: 'restricted-canary-test-value' },
        encoding: 'utf8',
      }),
      (error) => error?.code === 1,
    );
    const receipt = JSON.parse(await readFile(join(quarantine, 'scan-receipt.json'), 'utf8'));
    assert.equal(receipt.status, 'QUARANTINED');
    assert.equal(receipt.payloadDestroyed, true);
    assert.equal(JSON.stringify(receipt).includes('restricted-canary-test-value'), false);
    assert.equal(await access(root).then(() => true, () => false), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(quarantine, { recursive: true, force: true });
  }
});

test('clean artifact scan is explicit and writes a separate receipt without mutating the pack', async () => {
  const runId = `scan-clean-${Date.now()}`;
  const root = await mkdtemp(join(repoRoot, '.artifact-scan-test-'));
  const report = join(repoRoot, `.artifact-scan-report-${Date.now()}.json`);
  try {
    await writeFile(join(root, 'summary.json'), JSON.stringify({ status: 'CLEAN' }));
    const result = await execFile(process.execPath, [resolve(repoRoot, 'scripts/scan-artifacts.mjs'), '--root', root, '--report', report], {
      cwd: repoRoot,
      env: { ...process.env, EVIDENCE_RUN_ID: runId, EVIDENCE_TIER: 'pr' },
      encoding: 'utf8',
    });
    const parsed = JSON.parse(await readFile(report, 'utf8'));
    assert.equal(parsed.status, 'CLEAN');
    assert.equal(parsed.treeDigest.length, 64);
    assert.equal(result.stdout.includes('CLEAN'), true);
    assert.equal(await access(root).then(() => true, () => false), true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(report, { force: true });
  }
});

test('structured report path must remain inside repository root', async () => {
  const root = await fixture();
  const outside = resolve(root, '..', `outside-${Date.now()}.json`);
  try {
    await writeFile(outside, JSON.stringify(validVitest));
    await assert.rejects(validateStructuredReport(outside, 'vitest', root), /escapes repository root/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});
