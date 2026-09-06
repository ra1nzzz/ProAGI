import { createHash, randomBytes } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { access, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { assertContained, validateStructuredReport } from './check-suites.mjs';

const execFile = promisify(execFileCallback);
const repoRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const runId = process.env.EVIDENCE_RUN_ID ?? new Date().toISOString().replaceAll(/[:.]/g, '-');
const tier = process.env.EVIDENCE_TIER ?? 'pr';
const requestedStatus = process.env.EVIDENCE_STATUS ?? 'NOT_RUN';
if (!SAFE_ID.test(runId)) throw new Error('EVIDENCE_RUN_ID contains unsafe characters');
if (!['pr', 'nightly', 'release'].includes(tier)) throw new Error('EVIDENCE_TIER must be pr, nightly, or release');
if (!['NOT_RUN', 'CONDITIONAL', 'PASS', 'FAIL'].includes(requestedStatus)) throw new Error('Invalid EVIDENCE_STATUS');
if (requestedStatus === 'PASS') throw new Error('PASS requires manual NVDA and visual approvals; this automated pack is capped at CONDITIONAL');

async function git(...args) {
  return (await execFile('git', args, { cwd: repoRoot, encoding: 'utf8' })).stdout.trim();
}

async function hashFile(path) {
  const bytes = await readFile(path);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

async function walkFiles(root, base = root, output = []) {
  const info = await lstat(root);
  if (info.isSymbolicLink()) throw new Error(`Symbolic links are not accepted in evidence: ${relative(repoRoot, root)}`);
  if (info.isFile()) {
    output.push({ absolute: root, path: relative(base, root) });
    return output;
  }
  if (!info.isDirectory()) throw new Error(`Unsupported evidence file type: ${root}`);
  for (const entry of (await readdir(root)).sort()) await walkFiles(join(root, entry), base, output);
  return output;
}

async function hashTree(root, base = root) {
  const files = await walkFiles(root, base);
  return Promise.all(files.map(async ({ absolute, path }) => ({ path, ...await hashFile(absolute) })));
}

async function trackedSourceArtifacts() {
  const names = (await git('ls-files', '-z')).split('\0').filter(Boolean).sort();
  if (names.length === 0) throw new Error('Git returned no tracked source files');
  return Promise.all(names.map(async (name) => {
    const absolute = await realpath(resolve(repoRoot, name));
    assertContained(repoRoot, absolute, name);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Tracked source is not a regular file: ${name}`);
    return { path: name, ...await hashFile(absolute) };
  }));
}

async function absent(path) {
  try { await access(path); return false; } catch (error) { if (error?.code === 'ENOENT') return true; throw error; }
}

const head = await git('rev-parse', 'HEAD');
const ref = await git('symbolic-ref', '-q', '--short', 'HEAD').catch(() => git('describe', '--tags', '--exact-match', 'HEAD'));
const expectedSha = process.env.EVIDENCE_TARGET_SHA;
if (expectedSha && expectedSha !== head) throw new Error(`EVIDENCE_TARGET_SHA ${expectedSha} does not match HEAD ${head}`);
const statusBefore = await git('status', '--porcelain=v1', '--untracked-files=all');
const sourceArtifacts = await trackedSourceArtifacts();
const sourceIdentity = createHash('sha256').update(JSON.stringify(sourceArtifacts)).digest('hex');

const resultRoot = resolve(repoRoot, 'test-results', runId);
assertContained(repoRoot, resultRoot, 'test result root');
const expectedReports = [
  ['pr-vitest/vitest-report.json', 'vitest', ['unit', 'integration', 'fixtures', 'privacy', 'replay', 'worker', 'projection', 'evaluator', 'a11y', 'visual']],
  ['pr-e2e/playwright-report.json', 'playwright', []],
  ['pr-smoke/playwright-report.json', 'playwright', []],
];
if (['nightly', 'release'].includes(tier)) expectedReports.push(
  ['nightly-privacy/vitest-report.json', 'vitest', ['privacy']],
  ['nightly-worker/vitest-report.json', 'vitest', ['worker']],
);
const reportSummaries = [];
if (requestedStatus === 'CONDITIONAL') {
  for (const [path, type, suites] of expectedReports) reportSummaries.push(await validateStructuredReport(resolve(resultRoot, path), type, repoRoot, suites));
}

const distRoot = resolve(repoRoot, 'dist');
let distArtifacts = [];
if (requestedStatus === 'CONDITIONAL') {
  distArtifacts = await hashTree(distRoot, repoRoot);
  if (distArtifacts.length === 0) throw new Error('dist is missing or empty');
}
const buildIdentity = createHash('sha256').update(JSON.stringify(distArtifacts)).digest('hex');
if (requestedStatus === 'CONDITIONAL' && statusBefore) throw new Error(`Candidate evidence requires a clean worktree:\n${statusBefore}`);
if (requestedStatus === 'CONDITIONAL' && tier === 'release') {
  const bindingPath = resolve(resultRoot, 'release', 'release-binding.json');
  let binding;
  try { binding = JSON.parse(await readFile(bindingPath, 'utf8')); } catch (error) {
    throw new Error(`Release binding is missing or malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (binding?.schemaVersion !== '1.0.0' || binding.runId !== runId || binding.tier !== 'release' || binding.head !== head || binding.clean !== true || binding.buildIdentity !== buildIdentity) {
    throw new Error('Release binding does not match this clean ref, run, and dist build');
  }
}

const evidenceParent = resolve(repoRoot, 'evidence', 'M1');
const destination = resolve(evidenceParent, runId);
assertContained(evidenceParent, destination, 'evidence destination');
if (!(await absent(destination))) throw new Error(`Refusing to overwrite immutable evidence run: ${destination}`);
await mkdir(evidenceParent, { recursive: true });
const temporary = resolve(evidenceParent, `.tmp-${runId}-${process.pid}-${randomBytes(4).toString('hex')}`);
await mkdir(temporary, { recursive: false });
try {
  const copiedResults = join(temporary, 'test-results');
  if (!(await absent(resultRoot))) await cp(resultRoot, copiedResults, { recursive: true, errorOnExist: true });
  const logSource = resolve(repoRoot, 'evidence-logs', `${tier}.log`);
  if (!(await absent(logSource))) await cp(logSource, join(temporary, `${tier}.log`), { errorOnExist: true });

  const environment = {
    schemaVersion: '1.0.0', node: process.version, platform: process.platform, arch: process.arch,
    githubActions: process.env.GITHUB_ACTIONS === 'true',
  };
  await writeFile(join(temporary, 'environment.json'), `${JSON.stringify(environment, null, 2)}\n`, { flag: 'wx' });
  const decision = requestedStatus === 'PASS' ? 'CONDITIONAL' : requestedStatus;
  const gateStatus = {
    schemaVersion: '2.0.0', gate: 'Gate 1', decision, tier,
    automated: reportSummaries,
    manual: { nvda: 'NOT_RUN', humanVisualApproval: 'NOT_RUN' },
    limitations: [
      'Automated evidence cannot raise Gate 1 above CONDITIONAL without NVDA and human visual approvals.',
      'M1 is bundled synthetic-only; no real desktop capture, live actions, Runtime, cloud, Tauri, Rust, or UIA.',
      'Cross-tab deletion/PURGE remains NOT_RUN.',
    ],
  };
  await writeFile(join(temporary, 'gate-status.json'), `${JSON.stringify(gateStatus, null, 2)}\n`, { flag: 'wx' });

  const payloads = await hashTree(temporary, temporary);
  const manifest = {
    schemaVersion: '2.0.0', milestone: 'M1', runId, tier, createdAt: new Date().toISOString(),
    repository: { rootName: repoRoot.split('/').at(-1), head, ref, clean: statusBefore === '', expectedSha: expectedSha ?? null },
    sourceIdentity, buildIdentity, status: decision,
    sourceArtifacts, distArtifacts, reports: reportSummaries, evidencePayloads: payloads,
  };
  const manifestPath = join(temporary, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  const manifestDigest = await hashFile(manifestPath);
  await writeFile(join(temporary, 'MANIFEST.sha256'), `${manifestDigest.sha256}  manifest.json\n`, { flag: 'wx' });

  const statusAfter = await git('status', '--porcelain=v1', '--untracked-files=all');
  const sourceAfter = createHash('sha256').update(JSON.stringify(await trackedSourceArtifacts())).digest('hex');
  if (statusAfter !== statusBefore || sourceAfter !== sourceIdentity) throw new Error('Repository changed while evidence was being assembled');
  await rename(temporary, destination);
} catch (error) {
  await rm(temporary, { recursive: true, force: true });
  throw error;
}
console.log(relative(repoRoot, destination));
