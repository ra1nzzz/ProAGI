import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const PILOT_INPUT_SCHEMA = 'm2-pilot-evidence-v1';
export const PILOT_REPORT_SCHEMA = 'm2-pilot-report-v1';
export const TRACE_BINDING_SCHEMA = 'trace-binding-v1';
export const PILOT_CASE_ID = 'M2.pilot';
export const PILOT_SOURCE_ADAPTER = 'readonly-test-results';
export const PILOT_TARGET_PARTICIPANTS = 12;
export const PILOT_TARGET_SESSIONS = 2;
const BOOTSTRAP_RESAMPLES = 2_000;
const TOKEN_PATTERN = /^[A-Za-z0-9._-]{1,80}$/u;
const RETENTION_STATES = new Set(['revoked', 'expired', 'cleared', 'not-run']);
const SESSION_STATUSES = new Set(['completed', 'withdrawn', 'not-run']);
const OUTCOMES = new Set(['accepted', 'edited', 'rejected', 'ignored', 'exited', 'not-run']);

export class PilotEvidenceError extends Error {
  constructor(code, path) {
    super(`${code}:${path}`);
    this.name = 'PilotEvidenceError';
    this.code = code;
    this.path = path;
  }
}

export function parsePilotInput(value) {
  const root = object(value, '$');
  exactKeys(root, ['schemaVersion', 'studyId', 'sourceAdapter', 'reviewerToken', 'participants'], '$');
  exactString(root.schemaVersion, PILOT_INPUT_SCHEMA, '$.schemaVersion');
  exactString(root.studyId, 'm2-readonly-pilot-v1', '$.studyId');
  exactString(root.sourceAdapter, PILOT_SOURCE_ADAPTER, '$.sourceAdapter');
  token(root.reviewerToken, '$.reviewerToken');
  if (!Array.isArray(root.participants) || root.participants.length > 1_000) fail('ERR_PILOT_ARRAY_INVALID', '$.participants');

  const participantTokens = new Set();
  const participants = root.participants.map((participant, participantIndex) => {
    const participantPath = `$.participants[${participantIndex}]`;
    const item = object(participant, participantPath);
    exactKeys(item, ['participantToken', 'sessions'], participantPath);
    const participantToken = token(item.participantToken, `${participantPath}.participantToken`);
    if (participantTokens.has(participantToken)) fail('ERR_PILOT_DUPLICATE_TOKEN', `${participantPath}.participantToken`);
    participantTokens.add(participantToken);
    if (!Array.isArray(item.sessions) || item.sessions.length < 1 || item.sessions.length > 10) fail('ERR_PILOT_ARRAY_INVALID', `${participantPath}.sessions`);
    const sessionTokens = new Set();
    const sessions = item.sessions.map((session, sessionIndex) => {
      const sessionPath = `${participantPath}.sessions[${sessionIndex}]`;
      const value = object(session, sessionPath);
      exactKeys(value, ['sessionToken', 'status', 'lifecycle', 'outcome', 'correctionSeconds', 'netValueSeconds'], sessionPath);
      const sessionToken = token(value.sessionToken, `${sessionPath}.sessionToken`);
      if (sessionTokens.has(sessionToken)) fail('ERR_PILOT_DUPLICATE_TOKEN', `${sessionPath}.sessionToken`);
      sessionTokens.add(sessionToken);
      const status = enumeration(value.status, SESSION_STATUSES, `${sessionPath}.status`);
      const lifecycle = parseLifecycle(value.lifecycle, `${sessionPath}.lifecycle`);
      const outcome = enumeration(value.outcome, OUTCOMES, `${sessionPath}.outcome`);
      const correctionSeconds = nullableInteger(value.correctionSeconds, `${sessionPath}.correctionSeconds`, 0, 3_600);
      const netValueSeconds = nullableInteger(value.netValueSeconds, `${sessionPath}.netValueSeconds`, -86_400, 86_400);
      if (status === 'not-run' && (outcome !== 'not-run' || correctionSeconds !== null || netValueSeconds !== null)) {
        fail('ERR_PILOT_STATUS_MISMATCH', sessionPath);
      }
      if (status === 'completed' && (!lifecycle.consentGranted || !lifecycle.previewObserved || !lifecycle.commitObserved || outcome === 'not-run' || netValueSeconds === null)) {
        fail('ERR_PILOT_LIFECYCLE_INCOMPLETE', sessionPath);
      }
      if (['accepted', 'edited', 'rejected'].includes(outcome) && correctionSeconds === null) {
        fail('ERR_PILOT_CORRECTION_MISSING', `${sessionPath}.correctionSeconds`);
      }
      if (['ignored', 'exited', 'not-run'].includes(outcome) && correctionSeconds !== null) {
        fail('ERR_PILOT_CORRECTION_UNEXPECTED', `${sessionPath}.correctionSeconds`);
      }
      return { sessionToken, status, lifecycle, outcome, correctionSeconds, netValueSeconds };
    });
    sessions.sort((left, right) => left.sessionToken.localeCompare(right.sessionToken));
    return { participantToken, sessions };
  });
  participants.sort((left, right) => left.participantToken.localeCompare(right.participantToken));
  return { schemaVersion: PILOT_INPUT_SCHEMA, studyId: 'm2-readonly-pilot-v1', sourceAdapter: PILOT_SOURCE_ADAPTER, reviewerToken: root.reviewerToken, participants };
}

export function buildPilotReport(value, options = {}) {
  const input = parsePilotInput(value);
  const generatedAt = iso(options.generatedAt ?? new Date().toISOString(), '$.generatedAt');
  const inputHash = options.inputHash ?? `sha256:${sha256(stableStringify(input))}`;
  if (!/^sha256:[0-9a-f]{64}$/u.test(inputHash)) fail('ERR_PILOT_HASH_INVALID', '$.inputHash');
  const sessions = input.participants.flatMap((participant) => participant.sessions.map((session) => ({ ...session, participantToken: participant.participantToken })));
  const eligible = sessions.filter((session) => session.status === 'completed' && session.lifecycle.consentGranted && session.lifecycle.previewObserved && session.lifecycle.commitObserved && session.netValueSeconds !== null);
  const eligibleByParticipant = new Map();
  for (const session of eligible) {
    const values = eligibleByParticipant.get(session.participantToken) ?? [];
    values.push(session.netValueSeconds);
    eligibleByParticipant.set(session.participantToken, values);
  }
  const participantMeans = [...eligibleByParticipant.values()].map((values) => mean(values)).sort((left, right) => left - right);
  const lifecycle = {
    consentGranted: sessions.filter((session) => session.lifecycle.consentGranted).length,
    previewObserved: sessions.filter((session) => session.lifecycle.previewObserved).length,
    commitObserved: sessions.filter((session) => session.lifecycle.commitObserved).length,
    revokeObserved: sessions.filter((session) => session.lifecycle.revokeObserved).length,
    retentionObserved: sessions.filter((session) => session.lifecycle.retentionObserved !== 'not-run').length,
  };
  const participantsWithTwoSessions = [...eligibleByParticipant.values()].filter((values) => values.length >= PILOT_TARGET_SESSIONS).length;
  const minimumTargetMet = participantsWithTwoSessions >= PILOT_TARGET_PARTICIPANTS;
  const allLifecycleObserved = sessions.length > 0 && sessions.every((session) => session.lifecycle.consentGranted && session.lifecycle.previewObserved && session.lifecycle.commitObserved && session.lifecycle.revokeObserved && session.lifecycle.retentionObserved !== 'not-run');
  const netValueSummary = summary(participantMeans);
  const correctionValues = eligible.map((session) => session.correctionSeconds).filter((value) => value !== null);
  const reasons = [];
  if (eligible.length === 0) reasons.push('NO_ELIGIBLE_SESSIONS');
  if (!minimumTargetMet) reasons.push('INSUFFICIENT_SAMPLE');
  if (!allLifecycleObserved) reasons.push('LIFECYCLE_EVIDENCE_INCOMPLETE');
  if (netValueSummary.medianSeconds !== null && netValueSummary.medianSeconds <= 0) reasons.push('NET_VALUE_NOT_POSITIVE');
  if (eligible.length > 0) reasons.push('MANUAL_REVIEW_REQUIRED');
  const reportBase = {
    schemaVersion: PILOT_REPORT_SCHEMA,
    studyId: input.studyId,
    sourceAdapter: input.sourceAdapter,
    generatedAt,
    inputHash,
    status: eligible.length > 0 ? 'RECORDED' : 'NOT_RUN',
    decision: eligible.length > 0 ? 'CONDITIONAL' : 'NOT_RUN',
    decisionReasons: reasons,
    sample: {
      participantCount: input.participants.length,
      eligibleParticipantCount: participantMeans.length,
      sessionCount: sessions.length,
      eligibleSessionCount: eligible.length,
      participantsWithAtLeastTwoEligibleSessions: participantsWithTwoSessions,
      targetParticipants: PILOT_TARGET_PARTICIPANTS,
      targetSessionsPerParticipant: PILOT_TARGET_SESSIONS,
      minimumTargetMet,
    },
    lifecycle,
    reviewOutcomeCounts: Object.fromEntries([...OUTCOMES].map((outcome) => [outcome, sessions.filter((session) => session.outcome === outcome).length])),
    correctionSeconds: summary(correctionValues),
    netValueSeconds: netValueSummary,
    netValueConfidence95: bootstrapMedianConfidence(participantMeans),
    traceBinding: {
      caseId: PILOT_CASE_ID,
      stepId: 'pilot-report-review',
      reviewerId: input.reviewerToken,
      result: 'NOT_RUN',
    },
  };
  return { ...reportBase, contentHash: `sha256:${sha256(stableStringify(reportBase))}` };
}

export async function runPilotEvidence({ inputPath, outputDir, generatedAt } = {}) {
  if (typeof inputPath !== 'string' || typeof outputDir !== 'string') throw new Error('Usage: pilot-evidence --input <path> --output <dir> [--generated-at <ISO>]');
  await mkdir(resolve(outputDir), { recursive: true });
  let inputBytes;
  try {
    inputBytes = await readFile(resolve(inputPath));
  } catch {
    await writeLog(outputDir, ['event=pilot-evidence', 'status=FAIL', 'code=ERR_PILOT_INPUT_READ']);
    throw new PilotEvidenceError('ERR_PILOT_INPUT_READ', '$.input');
  }
  try {
    const input = JSON.parse(inputBytes.toString('utf8'));
    const report = buildPilotReport(input, { generatedAt, inputHash: `sha256:${sha256(inputBytes)}` });
    const reportPath = resolve(outputDir, 'pilot-report.json');
    const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(reportPath, reportBytes, { flag: 'wx' });
    const artifactHash = `sha256:${sha256(reportBytes)}`;
    const binding = {
      schemaVersion: TRACE_BINDING_SCHEMA,
      caseId: PILOT_CASE_ID,
      stepId: report.traceBinding.stepId,
      reviewerId: report.traceBinding.reviewerId,
      result: 'NOT_RUN',
      artifactHashes: [artifactHash],
      reportContentHash: report.contentHash,
    };
    await writeFile(resolve(outputDir, 'pilot-trace-binding.json'), `${JSON.stringify(binding, null, 2)}\n`, { flag: 'wx' });
    await writeLog(outputDir, [
      'event=pilot-evidence',
      `status=${report.status}`,
      `decision=${report.decision}`,
      `participants=${report.sample.participantCount}`,
      `eligibleParticipants=${report.sample.eligibleParticipantCount}`,
      `sessions=${report.sample.sessionCount}`,
      `eligibleSessions=${report.sample.eligibleSessionCount}`,
      `artifactHash=${artifactHash}`,
      'traceResult=NOT_RUN',
    ]);
    return { report, binding, artifactHash, reportPath, bindingPath: resolve(outputDir, 'pilot-trace-binding.json'), logPath: resolve(outputDir, 'pilot-evidence.log') };
  } catch (error) {
    const code = error instanceof PilotEvidenceError ? error.code : error instanceof SyntaxError ? 'ERR_PILOT_JSON_INVALID' : 'ERR_PILOT_OUTPUT_WRITE';
    const path = error instanceof PilotEvidenceError ? error.path : '$.input';
    await writeLog(outputDir, ['event=pilot-evidence', 'status=FAIL', `code=${code}`, `path=${path}`]);
    if (error instanceof PilotEvidenceError) throw error;
    if (error instanceof SyntaxError) throw new PilotEvidenceError(code, path);
    throw error;
  }
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function parseLifecycle(value, path) {
  const lifecycle = object(value, path);
  exactKeys(lifecycle, ['consentGranted', 'previewObserved', 'commitObserved', 'revokeObserved', 'retentionObserved'], path);
  return {
    consentGranted: boolean(lifecycle.consentGranted, `${path}.consentGranted`),
    previewObserved: boolean(lifecycle.previewObserved, `${path}.previewObserved`),
    commitObserved: boolean(lifecycle.commitObserved, `${path}.commitObserved`),
    revokeObserved: boolean(lifecycle.revokeObserved, `${path}.revokeObserved`),
    retentionObserved: enumeration(lifecycle.retentionObserved, RETENTION_STATES, `${path}.retentionObserved`),
  };
}

function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('ERR_PILOT_OBJECT_INVALID', path);
  return value;
}

function exactKeys(value, allowed, path) {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) if (!keys.has(key)) fail('ERR_PILOT_FIELD_FORBIDDEN', `${path}.${key}`);
}

function exactString(value, expected, path) {
  if (value !== expected) fail('ERR_PILOT_VALUE_INVALID', path);
  return value;
}

function token(value, path) {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) fail('ERR_PILOT_TOKEN_INVALID', path);
  return value;
}

function boolean(value, path) {
  if (typeof value !== 'boolean') fail('ERR_PILOT_BOOLEAN_INVALID', path);
  return value;
}

function enumeration(value, choices, path) {
  if (typeof value !== 'string' || !choices.has(value)) fail('ERR_PILOT_ENUM_INVALID', path);
  return value;
}

function nullableInteger(value, path, minimum, maximum) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail('ERR_PILOT_INTEGER_INVALID', path);
  return value;
}

function iso(value, path) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail('ERR_PILOT_TIMESTAMP_INVALID', path);
  return new Date(Date.parse(value)).toISOString();
}

function fail(code, path) {
  throw new PilotEvidenceError(code, path);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function mean(values) {
  if (values.length === 0) return null;
  return round(values.reduce((total, value) => total + value, 0) / values.length);
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]);
}

function summary(values) {
  if (values.length === 0) return { n: 0, meanSeconds: null, medianSeconds: null, minSeconds: null, maxSeconds: null };
  return { n: values.length, meanSeconds: mean(values), medianSeconds: median(values), minSeconds: Math.min(...values), maxSeconds: Math.max(...values) };
}

function bootstrapMedianConfidence(values) {
  if (values.length < 2) return { method: 'deterministic-percentile-bootstrap', sampleUnit: 'participant-mean', resamples: BOOTSTRAP_RESAMPLES, lowSeconds: null, highSeconds: null, reason: 'INSUFFICIENT_PARTICIPANTS' };
  let state = 0x6d326c31;
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
  const medians = [];
  for (let sample = 0; sample < BOOTSTRAP_RESAMPLES; sample += 1) {
    const resample = [];
    for (let index = 0; index < values.length; index += 1) resample.push(values[Math.floor(next() * values.length)]);
    medians.push(median(resample));
  }
  medians.sort((left, right) => left - right);
  return {
    method: 'deterministic-percentile-bootstrap', sampleUnit: 'participant-mean', resamples: BOOTSTRAP_RESAMPLES,
    lowSeconds: round(percentile(medians, 0.025)), highSeconds: round(percentile(medians, 0.975)),
  };
}

function percentile(sorted, probability) {
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

async function writeLog(outputDir, lines) {
  await writeFile(resolve(outputDir, 'pilot-evidence.log'), `${lines.join('\n')}\n`, { flag: 'w' });
}

function cliOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!['--input', '--output', '--generated-at'].includes(flag) || typeof args[index + 1] !== 'string') throw new Error('Usage: pilot-evidence --input <path> --output <dir> [--generated-at <ISO>]');
    options[flag.slice(2).replace('-', '')] = args[++index];
  }
  if (!options.input || !options.output) throw new Error('Usage: pilot-evidence --input <path> --output <dir> [--generated-at <ISO>]');
  return { inputPath: options.input, outputDir: options.output, generatedAt: options.generatedat };
}

async function main() {
  try {
    const result = await runPilotEvidence(cliOptions(process.argv.slice(2)));
    console.log(`M2_PILOT_EVIDENCE status=${result.report.status} decision=${result.report.decision} artifactHash=${result.artifactHash}`);
  } catch (error) {
    const code = error instanceof PilotEvidenceError ? error.code : 'ERR_PILOT_FAILED';
    console.error(`M2_PILOT_EVIDENCE status=FAIL code=${code}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
