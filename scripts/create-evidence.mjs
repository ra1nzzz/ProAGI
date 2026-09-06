import { createHash, randomBytes } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { access, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, homedir, hostname, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { assertContained, validateStructuredReport, verificationReportsForTier, verificationRetentionDaysForTier } from './check-suites.mjs';

const execFile = promisify(execFileCallback);
const repoRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const startedAt = new Date().toISOString();
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const runId = process.env.EVIDENCE_RUN_ID ?? new Date().toISOString().replaceAll(/[:.]/g, '-');
const tier = process.env.EVIDENCE_TIER ?? 'pr';
const requestedStatus = process.env.EVIDENCE_STATUS ?? 'NOT_RUN';
const cancelled = process.env.EVIDENCE_CANCELLED === 'true';
const randomSeed = process.env.EVIDENCE_RANDOM_SEED ?? 'NOT_RUN';
const failureReason = process.env.EVIDENCE_REASON ?? (cancelled ? 'workflow-cancelled' : requestedStatus === 'FAIL' ? 'verification-failed' : 'not-applicable');
if (!SAFE_ID.test(runId)) throw new Error('EVIDENCE_RUN_ID contains unsafe characters');
if (!['pr', 'nightly', 'release'].includes(tier)) throw new Error('EVIDENCE_TIER must be pr, nightly, or release');
if (!['NOT_RUN', 'CONDITIONAL', 'PASS', 'FAIL'].includes(requestedStatus)) throw new Error('Invalid EVIDENCE_STATUS');
if (requestedStatus === 'PASS') throw new Error('PASS requires independent NVDA and human visual approvals; automated evidence is capped at CONDITIONAL');

const retentionDays = verificationRetentionDaysForTier(tier);
const expectedReports = verificationReportsForTier(tier);

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
    output.push({ absolute: root, path: relative(base, root).replaceAll('\\', '/') });
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

async function copyStrict(source, destination) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error(`Symbolic links are not accepted in evidence: ${relative(repoRoot, source)}`);
  if (info.isFile()) {
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { errorOnExist: true, force: false });
    await regularFile(destination, destination);
    return;
  }
  const files = await walkFiles(source);
  await mkdir(destination, { recursive: true });
  for (const file of files) {
    const target = join(destination, file.path);
    await mkdir(dirname(target), { recursive: true });
    await cp(file.absolute, target, { errorOnExist: true, force: false });
  }
  await walkFiles(destination);
}

async function absent(path) {
  try { await access(path); return false; } catch (error) { if (error?.code === 'ENOENT') return true; throw error; }
}

async function regularFile(path, label) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  return path;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

function sourceDescriptor(sourceArtifacts, paths, owner, classification) {
  return paths.map((path) => {
    const artifact = sourceArtifacts.find((item) => item.path === path);
    if (!artifact) throw new Error(`Required source artifact is not tracked: ${path}`);
    return { path, owner, classification, sha256: artifact.sha256, bytes: artifact.bytes };
  });
}

function reportOptions(report) {
  return report.options ?? {};
}

const head = await git('rev-parse', 'HEAD');
const ref = await git('symbolic-ref', '-q', '--short', 'HEAD').catch(() => git('describe', '--tags', '--exact-match', 'HEAD').then((tag) => `refs/tags/${tag}`).catch(() => ''));
const expectedSha = process.env.EVIDENCE_TARGET_SHA;
if (expectedSha && expectedSha !== head) throw new Error(`EVIDENCE_TARGET_SHA ${expectedSha} does not match HEAD ${head}`);
const statusBefore = await git('status', '--porcelain=v1', '--untracked-files=all');
if (requestedStatus === 'CONDITIONAL' && statusBefore) throw new Error(`Conditional evidence requires a clean worktree:\n${statusBefore}`);
const sourceArtifacts = await (async () => {
  const names = (await git('ls-files', '-z')).split('\0').filter(Boolean).sort();
  if (names.length === 0) throw new Error('Git returned no tracked source files');
  return Promise.all(names.map(async (name) => {
    const absolute = await realpath(resolve(repoRoot, name));
    assertContained(repoRoot, absolute, name);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Tracked source is not a regular file: ${name}`);
    return { path: name, ...await hashFile(absolute) };
  }));
})();
const sourceIdentity = createHash('sha256').update(JSON.stringify(sourceArtifacts)).digest('hex');
const resultRoot = resolve(repoRoot, 'test-results', runId);
assertContained(repoRoot, resultRoot, 'test result root');
const distRoot = resolve(repoRoot, 'dist');
const evidenceParent = resolve(repoRoot, 'evidence', 'M1');
const destination = resolve(evidenceParent, runId);
assertContained(evidenceParent, destination, 'evidence destination');
if (!(await absent(destination))) throw new Error(`Refusing to overwrite immutable evidence run: ${destination}`);

if (requestedStatus === 'CONDITIONAL') {
  await Promise.all(expectedReports.map((report) => regularFile(resolve(resultRoot, report.path), report.path)));
  await walkFiles(distRoot);
}

const temporary = resolve(evidenceParent, `.tmp-${runId}-${process.pid}-${randomBytes(4).toString('hex')}`);
await mkdir(evidenceParent, { recursive: true });
await mkdir(temporary, { recursive: false });
try {
  const copiedResults = join(temporary, 'test-results', runId);
  if (!(await absent(resultRoot))) await copyStrict(resultRoot, copiedResults);
  const copiedDist = join(temporary, 'dist');
  if (!(await absent(distRoot))) await copyStrict(distRoot, copiedDist);
  if (requestedStatus === 'CONDITIONAL' && (await absent(copiedDist))) throw new Error('dist is missing from staged evidence');

  const reportSummaries = [];
  const reportArtifacts = [];
  for (const report of expectedReports) {
    const stagedPath = resolve(copiedResults, report.path);
    if (await absent(stagedPath)) {
      if (requestedStatus === 'CONDITIONAL') throw new Error(`Required staged report is missing: ${report.path}`);
      continue;
    }
    await regularFile(stagedPath, report.path);
    if (requestedStatus === 'CONDITIONAL') {
      const summary = await validateStructuredReport(stagedPath, report.type, repoRoot, report.suites, reportOptions(report));
      const digest = await hashFile(stagedPath);
      reportSummaries.push({ ...summary, path: `test-results/${runId}/${report.path}`, sha256: digest.sha256, bytes: digest.bytes, validation: 'staged-bytes' });
      reportArtifacts.push({ path: `test-results/${runId}/${report.path}`, ...digest });
    } else {
      reportArtifacts.push({ path: `test-results/${runId}/${report.path}`, ...await hashFile(stagedPath) });
    }
  }
  if (requestedStatus === 'CONDITIONAL' && reportSummaries.length !== expectedReports.length) throw new Error('Not all required reports were staged and validated');

  const distArtifacts = (await absent(copiedDist)) ? [] : await hashTree(copiedDist, temporary);
  if (requestedStatus === 'CONDITIONAL' && distArtifacts.length === 0) throw new Error('dist is missing or empty');
  const buildIdentity = createHash('sha256').update(JSON.stringify(distArtifacts)).digest('hex');

  let releaseBinding = null;
  if (requestedStatus === 'CONDITIONAL' && tier === 'release') {
    const bindingPath = resolve(copiedResults, 'release', 'release-binding.json');
    let binding;
    try { binding = JSON.parse(await readFile(bindingPath, 'utf8')); } catch (error) {
      throw new Error(`Release binding is missing or malformed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (binding?.schemaVersion !== '1.0.0' || binding.runId !== runId || binding.tier !== 'release' || binding.head !== head || binding.clean !== true || binding.buildIdentity !== buildIdentity) {
      throw new Error('Release binding does not match this clean ref, run, and staged dist build');
    }
    releaseBinding = binding;
  }
  if (tier === 'release' && !(await absent(copiedDist))) {
    // Long-term evidence binds the production build by hash; it must not retain
    // the executable bundle or source maps as an evidence payload.
    await rm(copiedDist, { recursive: true, force: true });
  }

  const sourceGroups = {
    fixture: sourceDescriptor(sourceArtifacts, ['src/fixtures/developerDay.ts', 'tests/fixtures/sample.ts'], 'fixture-owner', 'synthetic-fixture'),
    gold: sourceDescriptor(sourceArtifacts, ['tests/evaluator/gold.ts'], 'gold-owner', 'gold-oracle'),
    evaluator: sourceDescriptor(sourceArtifacts, ['tests/evaluator/referenceEvaluator.ts', 'tests/evaluator/evaluator.test.ts'], 'evaluator-owner', 'evaluator'),
    oracle: sourceDescriptor(sourceArtifacts, ['tests/evaluator/evaluator.test.ts', 'tests/unit/canonical.test.ts'], 'oracle-owner', 'oracle-assertion'),
    mutation: sourceDescriptor(sourceArtifacts, ['tests/unit/preview-guard.test.ts', 'tests/integration/indexedDbM1b.test.ts'], 'mutation-owner', 'mutation-corpus'),
    visual: sourceDescriptor(sourceArtifacts, ['tests/e2e/visual-evidence.spec.ts', 'tests/visual/orb-structure.visual.test.tsx'], 'visual-owner', 'visual-contract'),
    a11y: sourceDescriptor(sourceArtifacts, ['tests/a11y/app-shell.a11y.test.tsx'], 'a11y-owner', 'a11y-contract'),
  };

  const sourceGroupHashes = Object.fromEntries(Object.entries(sourceGroups).map(([name, artifacts]) => [name, createHash('sha256').update(JSON.stringify(artifacts)).digest('hex')]));
  const resultFiles = (await absent(copiedResults)) ? [] : await walkFiles(copiedResults, temporary);
  const screenshotFiles = resultFiles.filter((file) => /\.(png|jpe?g|webp|gif)$/i.test(file.path) && /(^|\/)visual\.png$/i.test(file.path));
  if (requestedStatus === 'CONDITIONAL' && screenshotFiles.length < 2) throw new Error('Required visual screenshot artifacts are missing from staged E2E output');
  const screenshotArtifacts = await Promise.all(screenshotFiles.map(async (file) => ({ path: file.path, ...await hashFile(file.absolute), classification: 'synthetic-visual', owner: 'visual-owner', retentionDays })));
  let releaseSanitization = { status: tier === 'release' ? 'SANITIZED' : 'NOT_APPLICABLE', removed: [], distPayloadRemoved: tier === 'release' };
  if (tier === 'release' && resultFiles.length) {
    const nonLongTermFiles = resultFiles.filter((file) => /\.(png|jpe?g|webp|gif|zip|trace|har|mp4|webm|map|log)$/i.test(file.path));
    await Promise.all(nonLongTermFiles.map((file) => rm(file.absolute, { force: true })));
    releaseSanitization = { status: 'SANITIZED', removed: nonLongTermFiles.map((file) => file.path), distPayloadRemoved: true };
  }

  const browserVersions = await (async () => {
    const path = resolve(repoRoot, 'node_modules/playwright-core/browsers.json');
    if (await absent(path)) return { status: 'NOT_RUN', chromium: null };
    const browsers = JSON.parse(await readFile(path, 'utf8')).browsers;
    const chromium = browsers.find((item) => item.name === 'chromium');
    return { status: chromium ? 'RECORDED' : 'NOT_RUN', chromium: chromium ? { revision: chromium.revision, browserVersion: chromium.browserVersion } : null };
  })();
  if (requestedStatus === 'CONDITIONAL' && browserVersions.status !== 'RECORDED') throw new Error('Fixed Chromium revision is missing from staged evidence environment');
  const npmVersion = (await execFile('npm', ['--version'], { cwd: repoRoot, encoding: 'utf8' })).stdout.trim();
  const packageJson = JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8'));
  const environment = {
    schemaVersion: '1.0.0', capturedAt: new Date().toISOString(), node: process.version, npm: npmVersion,
    platform: platform(), osRelease: release(), arch: arch(), hostname, cpuCount: cpus().length, totalMemory: totalmem(), tempDirectory: tmpdir(), homeDirectoryRecorded: Boolean(homedir()),
    randomSeed, githubActions: process.env.GITHUB_ACTIONS === 'true', browser: browserVersions,
  };
  const versions = {
    schemaVersion: '1.0.0', node: process.version, npm: npmVersion, package: { name: packageJson.name, version: packageJson.version },
    playwright: packageJson.devDependencies?.['@playwright/test'] ?? null, chromium: browserVersions.chromium,
    evidencePack: 'evidence-pack-v3', domainSchema: 'domain-types-v1.0.0', fixtureSchema: 'fixture-schema-v1.0.0',
     fixture: 'developer-day-bundled-v1', policy: 'local-sensitive-allowlist-v1', adapter: 'indexed-db-m1b-v3',
     evaluator: 'reference-evaluator-v1', oracle: 'oracle-assertion-v1', mutation: 'mutation-corpus-v1',
     canonicalization: 'canonical-json-v1', visualComparator: 'not-substituted-for-review',
  };
  await writeJson(join(temporary, 'environment.json'), environment);
  await writeJson(join(temporary, 'versions.json'), versions);

  const logSource = resolve(repoRoot, 'evidence-logs', `${tier}.log`);
  const logDigest = !(await absent(logSource)) ? await hashFile(logSource) : null;
  const recordedCommands = logDigest
    ? (await readFile(logSource, 'utf8')).split('\n').filter((line) => line.startsWith('COMMAND_RECORD '))
    : [];
  const commandLines = [
    `evidence tier=${tier} runId=${runId} status=${requestedStatus}`,
    `create-evidence.mjs exitCode=0 retries=0 observedAt=${new Date().toISOString()}`,
    ...recordedCommands,
    ...reportSummaries.map((summary) => `validate ${summary.runner} ${summary.path} exitCode=0 retries=0`),
    logDigest ? `pipeline log source=evidence-logs/${tier}.log sha256=${logDigest.sha256} bytes=${logDigest.bytes}` : `pipeline log source=missing exitCode=${requestedStatus === 'NOT_RUN' ? 'NOT_RUN' : 'UNAVAILABLE'}`,
  ];
  await writeFile(join(temporary, 'commands.log'), `${commandLines.join('\n')}\n`, { flag: 'wx' });
  if (logDigest && tier !== 'release') await copyStrict(logSource, join(temporary, 'logs', `${tier}.log`));

  const automatedAssertionNumerator = reportSummaries.reduce((sum, report) => sum + report.passed, 0);
  const automatedAssertionDenominator = reportSummaries.reduce((sum, report) => sum + report.total, 0);
  const metrics = {
    automatedAssertions: {
      numerator: automatedAssertionNumerator,
      denominator: automatedAssertionDenominator,
      value: automatedAssertionDenominator ? automatedAssertionNumerator / automatedAssertionDenominator : null,
      uncertainty: automatedAssertionDenominator ? 'Deterministic run count; no population-level confidence interval is claimed.' : 'NOT_RUN: no validated structured reports.',
    },
    requiredReports: {
      numerator: reportSummaries.length,
      denominator: expectedReports.length,
      value: expectedReports.length ? reportSummaries.length / expectedReports.length : null,
      uncertainty: requestedStatus === 'CONDITIONAL' ? 'Structural completeness only; not a product-acceptance claim.' : 'NOT_RUN',
    },
  };
  const requirementTrace = [
    { requirementId: 'INV-REPORT-STRUCTURE', source: 'docs/final/CHECKPOINT.md#5.2', assertionIds: reportSummaries.map((report) => `validateStructuredReport:${report.path}`), evidencePaths: reportSummaries.map((report) => report.path), status: requestedStatus === 'CONDITIONAL' ? 'REPORT_BACKED' : 'NOT_RUN', direction: 'requirement-to-assertion-and-assertion-to-report' },
    { requirementId: 'INV-SYNTHETIC-FIXTURE-BOUNDARY', source: 'docs/final/CHECKPOINT.md#5.1', assertionIds: ['fixture-input:developer-day-bundled-v1'], evidencePaths: ['fixture-input/manifest.json', 'fixture-input/content-hashes.json'], status: requestedStatus === 'CONDITIONAL' ? 'RECORDED' : 'NOT_RUN', direction: 'requirement-to-artifact' },
    { requirementId: 'INV-ARTIFACT-NO-CANARY', source: 'docs/final/CHECKPOINT.md#2.2', assertionIds: ['artifact-scan:clean'], evidencePaths: ['artifact-scan.json'], status: requestedStatus === 'CONDITIONAL' ? 'REPORT_BACKED' : 'NOT_RUN', direction: 'requirement-to-scanner-receipt' },
    { requirementId: 'INV-CROSS-TAB-PURGE', source: 'docs/final/CHECKPOINT.md#2.2', assertionIds: [], evidencePaths: [], status: 'NOT_RUN', reason: 'Hosted multi-tab browser deletion/PURGE evidence is not available; crossTabBrowserVerified remains false.', direction: 'unmapped-unexecuted' },
    { requirementId: 'INV-NVDA-AND-VISUAL-APPROVAL', source: 'docs/final/CHECKPOINT.md#5.2', assertionIds: [], evidencePaths: ['a11y/nvda-smoke.json', 'visual/approvals.json'], status: 'NOT_RUN', reason: 'Independent NVDA and human visual approval are not supplied by automation.', direction: 'unmapped-unexecuted' },
  ];
  const reviewMetadata = {
    reviewer: process.env.EVIDENCE_REVIEWER ?? null,
    reviewRound: process.env.EVIDENCE_REVIEW_ROUND ?? 'NOT_RUN',
    decision: 'PENDING_MANUAL_REVIEW',
    accepted: false,
    reason: 'Evidence generation does not approve Gate 1, and no automated result may replace independent review.',
  };
  const decision = requestedStatus;
  const gateStatus = {
    schemaVersion: '3.0.0', gate: 'Gate 1', decision, tier,
    checkpoints: {
      M1a: { decision: requestedStatus === 'CONDITIONAL' ? 'CONDITIONAL' : requestedStatus, evidence: 'automated-suite-reports' },
      M1b: { decision: requestedStatus === 'CONDITIONAL' ? 'CONDITIONAL' : requestedStatus, evidence: 'privacy/integration-reports' },
      M1c: { decision: requestedStatus === 'CONDITIONAL' ? 'CONDITIONAL' : requestedStatus, evidence: 'visual-and-a11y-artifacts', manualApprovalRequired: true },
    },
    automated: reportSummaries,
    manual: { nvda: { status: 'NOT_RUN', approvalId: null, reviewer: null }, humanVisualApproval: { status: 'NOT_RUN', approvalId: null, reviewer: null } },
    limitations: [
      'Automated evidence cannot raise Gate 1 above CONDITIONAL without independent NVDA and human visual approvals.',
      'M1 is bundled synthetic-only; no real desktop capture, live actions, Runtime, cloud, Tauri, Rust, or UIA.',
      'Cross-tab browser deletion/PURGE correctness remains NOT_RUN; BroadcastChannel is only an accelerator.',
    ],
  };
  await writeJson(join(temporary, 'gate-status.json'), gateStatus);

  await mkdir(join(temporary, 'fixture-input'), { recursive: true });
  await mkdir(join(temporary, 'gold'), { recursive: true });
  await mkdir(join(temporary, 'evaluator'), { recursive: true });
  await mkdir(join(temporary, 'oracle'), { recursive: true });
  await mkdir(join(temporary, 'mutation'), { recursive: true });
  await mkdir(join(temporary, 'visual'), { recursive: true });
  await mkdir(join(temporary, 'a11y'), { recursive: true });
  await writeJson(join(temporary, 'fixture-input', 'manifest.json'), { schemaVersion: '1.0.0', status: requestedStatus === 'CONDITIONAL' ? 'RECORDED' : 'NOT_RUN', fixtureId: 'developer-day-bundled-v1', owner: 'fixture-owner', artifacts: sourceGroups.fixture, syntheticOnly: true });
  await writeJson(join(temporary, 'fixture-input', 'content-hashes.json'), { schemaVersion: '1.0.0', artifacts: sourceGroups.fixture });
  await writeJson(join(temporary, 'gold', 'oracle.json'), { schemaVersion: '1.0.0', status: requestedStatus === 'CONDITIONAL' ? 'RECORDED' : 'NOT_RUN', owner: 'gold-owner', artifacts: sourceGroups.gold, independentApproval: 'NOT_RUN' });
  await writeJson(join(temporary, 'gold', 'approval.json'), { schemaVersion: '1.0.0', status: 'NOT_RUN', approvalId: null, reviewer: null, approvedAt: null, reason: 'Human oracle approval is not supplied by automation.' });
  await writeJson(join(temporary, 'evaluator', 'manifest.json'), { schemaVersion: '1.0.0', status: requestedStatus === 'CONDITIONAL' ? 'RECORDED' : 'NOT_RUN', owner: 'evaluator-owner', artifacts: sourceGroups.evaluator, dependencyBoundary: 'application-and-evaluator-are-separately-hashed' });
  await writeJson(join(temporary, 'evaluator', 'dependency-boundary.json'), { schemaVersion: '1.0.0', status: 'RECORDED', implementation: sourceGroups.evaluator, fixture: sourceGroups.fixture, boundary: 'fixture/gold/evaluator owners are distinct' });
  await writeJson(join(temporary, 'oracle', 'assertions.json'), { schemaVersion: '1.0.0', status: requestedStatus === 'CONDITIONAL' ? 'REPORT_BACKED' : 'NOT_RUN', owner: 'oracle-owner', artifacts: sourceGroups.oracle, reports: reportArtifacts });
  await writeJson(join(temporary, 'oracle', 'requirement-trace.json'), { schemaVersion: '1.0.0', status: 'RECORDED', source: 'docs/final/CHECKPOINT.md', directionality: 'every mapped requirement points to an assertion and every assertion points to a staged artifact', requirements: requirementTrace });
  await writeJson(join(temporary, 'mutation', 'corpus-manifest.json'), { schemaVersion: '1.0.0', status: requestedStatus === 'CONDITIONAL' ? 'RECORDED' : 'NOT_RUN', owner: 'mutation-owner', artifacts: sourceGroups.mutation, killedSurvivorPolicy: 'survivors are retained and cannot be silently deleted' });
  await writeJson(join(temporary, 'mutation', 'killed-survivors.json'), { schemaVersion: '1.0.0', status: 'NOT_RUN', killed: null, survivors: null, reason: 'Mutation runner is not a verify:pr lane.' });
  await writeJson(join(temporary, 'visual', 'cases.json'), { schemaVersion: '1.0.0', status: screenshotArtifacts.length ? 'SCREENSHOTS_RECORDED' : 'NOT_RUN', requiredCases: [{ id: 'M1c-appshell-orb', source: 'tests/e2e/visual-evidence.spec.ts', required: true, screenshotCount: screenshotArtifacts.length }], artifacts: sourceGroups.visual });
  await writeJson(join(temporary, 'visual', 'screenshot-hashes.json'), { schemaVersion: '1.0.0', status: screenshotArtifacts.length ? 'RECORDED' : 'NOT_RUN', screenshots: screenshotArtifacts });
  await writeJson(join(temporary, 'visual', 'approvals.json'), { schemaVersion: '1.0.0', status: 'NOT_RUN', approvals: [], reason: 'Human visual approval is required and is not inferred from screenshot generation.' });
  await writeJson(join(temporary, 'a11y', 'axe.json'), { schemaVersion: '1.0.0', status: requestedStatus === 'CONDITIONAL' ? 'REPORT_BACKED' : 'NOT_RUN', source: 'tests/a11y/app-shell.a11y.test.tsx', reports: reportSummaries.filter((summary) => summary.path.includes('pr-vitest')) });
  await writeJson(join(temporary, 'a11y', 'accessibility-tree.json'), { schemaVersion: '1.0.0', status: 'NOT_RUN', reason: 'Browser accessibility-tree artifact is not substituted by an axe result.' });
  await writeJson(join(temporary, 'a11y', 'keyboard-focus-live.json'), { schemaVersion: '1.0.0', status: requestedStatus === 'CONDITIONAL' ? 'REPORT_BACKED' : 'NOT_RUN', source: 'tests/e2e/app.spec.ts' });
  await writeJson(join(temporary, 'a11y', 'nvda-smoke.json'), { schemaVersion: '1.0.0', status: 'NOT_RUN', environment: null, approvalId: null, restriction: 'Do not claim screen-reader or WCAG verification.' });

  await writeJson(join(temporary, 'test-results.json'), { schemaVersion: '1.0.0', status: requestedStatus, runId, tier, reports: reportSummaries, stagedReportArtifacts: reportArtifacts });
  await writeJson(join(temporary, 'eval-results.json'), { schemaVersion: '1.0.0', status: requestedStatus === 'CONDITIONAL' ? 'AUTOMATED_ONLY' : 'NOT_RUN', metrics, reports: reportSummaries, uncertainty: 'No human approval or statistical capacity claim is inferred.' });
  await writeJson(join(temporary, 'ci-tier.json'), { schemaVersion: '1.0.0', tier, runId, retentionDays, status: requestedStatus, requiredReports: expectedReports.map((report) => report.path), fixedNode: '24.15.0', fixedNpm: '11.12.1', randomSeed, chromium: browserVersions.chromium, hostedCi: process.env.GITHUB_ACTIONS === 'true' ? 'RECORDED' : 'NOT_RUN' });
  await writeJson(join(temporary, 'artifact-policy.json'), { schemaVersion: '1.0.0', tier, retention: { days: retentionDays, release: 'long-term-after-approval' }, classes: ['screenshot', 'video', 'HAR', 'trace', 'reporter', 'console', 'source-map', 'CI-upload', 'NVDA-transcript', 'artifact-scan'].map((classification) => ({ classification, scan: 'required-before-upload', canary: 'quarantine-on-hit', payloadRetention: classification === 'NVDA-transcript' ? 'manual-policy' : retentionDays })), sourceLog: logDigest ? { path: tier === 'release' ? null : `logs/${tier}.log`, ...logDigest, retained: tier !== 'release' } : null });
  await writeJson(join(temporary, 'privacy-report.json'), { schemaVersion: '1.0.0', status: requestedStatus === 'CONDITIONAL' ? 'AUTOMATED_ONLY' : 'NOT_RUN', crossTabBrowserVerified: false, purgeCoverage: 'single-browser-in-process', shadowExternalEffectStatus: 'AUTOMATED_TESTED', nvda: 'NOT_RUN', visualApproval: 'NOT_RUN', runtimeDatasetHash: 'NOT_RUN', canonicalOutputHash: 'NOT_RUN', cancellation: cancelled ? { status: 'CANCELLED', reason: failureReason } : { status: 'NOT_CANCELLED' }, canaryScan: 'REQUIRED_BEFORE_UPLOAD' });
  await writeJson(join(temporary, 'provenance-audit.json'), { schemaVersion: '1.0.0', status: requestedStatus === 'CONDITIONAL' ? 'REPORT_BACKED' : 'NOT_RUN', sourceIdentity, sourceArtifactSetHashes: sourceGroupHashes, fixture: sourceGroups.fixture, gold: sourceGroups.gold, evaluator: sourceGroups.evaluator, runtimeDataset: { status: 'NOT_RUN', hash: null }, canonicalOutput: { status: 'NOT_RUN', hash: null } });
  await writeFile(join(temporary, 'known-failures.md'), '# Known limitations\n\n- Gate 1 remains CONDITIONAL: NVDA and human visual approval are NOT_RUN.\n- Cross-tab browser deletion/PURGE is NOT_RUN and is not represented as PASS.\n- This pack contains synthetic fixture evidence only.\n', { flag: 'wx' });
  await writeFile(join(temporary, 'rollback.md'), '# Rollback\n\nRevoke this run by run-id and retain the immutable manifest, command record, hashes, and failure receipt. Do not reuse this run directory; rerun with a new EVIDENCE_RUN_ID.\n', { flag: 'wx' });
  await writeFile(join(temporary, 'review-decisions.md'), '# Review decisions\n\n- yt-dev-review required before commit.\n- Automated reports are bound to staged bytes.\n- No automated path may convert CONDITIONAL to PASS.\n- NVDA, visual approval, hosted CI, and cross-tab PURGE remain explicit limitations.\n', { flag: 'wx' });

  const scanReportPath = join(temporary, 'artifact-scan.json');
  const quarantineRoot = resolve(repoRoot, 'evidence', 'quarantine', runId);
  await execFile(process.execPath, [resolve(repoRoot, 'scripts', 'scan-artifacts.mjs'), '--root', temporary, '--quarantine', quarantineRoot, '--report', scanReportPath], {
    cwd: repoRoot,
    env: { ...process.env, EVIDENCE_RUN_ID: runId, EVIDENCE_TIER: tier },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const artifactScan = JSON.parse(await readFile(scanReportPath, 'utf8'));
  if (artifactScan.status !== 'CLEAN') throw new Error('Staged evidence artifact scan did not finish clean');
  artifactScan.root = `evidence/M1/${runId}`;
  await writeFile(scanReportPath, `${JSON.stringify(artifactScan, null, 2)}\n`, { flag: 'w' });

  const payloads = await hashTree(temporary, temporary);
  const payloadContentHash = createHash('sha256').update(JSON.stringify(payloads)).digest('hex');
  const endedAt = new Date().toISOString();
  const manifest = {
    schemaVersion: '3.0.0', milestone: 'M1', runId, run_id: runId, tier, status: decision, startedAt, endedAt, failureReason,
    repository: { rootName: repoRoot.split('/').at(-1), head, commitHash: head, ref, clean: statusBefore === '', expectedSha: expectedSha ?? null, contentHash: sourceIdentity },
    environment: { node: process.version, npm: npmVersion, os: `${platform()} ${release()}`, browser: browserVersions.chromium, randomSeed },
    sourceIdentity, buildIdentity, releaseBinding, sourceArtifacts, distArtifacts, reports: reportSummaries, reportArtifacts,
    sourceArtifactSetHashes: sourceGroupHashes,
    runtimeDataHashes: {
      datasetHash: { status: 'NOT_RUN', value: null, reason: 'No canonical runtime dataset export is captured by these lanes; source descriptor hashes are not substituted.' },
      canonicalOutputHash: { status: 'NOT_RUN', value: null, reason: 'Structured report validation does not emit a domain output hash.' },
    },
    metrics, requirementTrace, review: reviewMetadata,
    cancellation: { status: cancelled ? 'CANCELLED' : 'NOT_CANCELLED', cancelledAt: cancelled ? endedAt : null, reason: cancelled ? failureReason : null, payloadCleanup: 'staged-payloads-removed-or-scan-quarantined' },
    artifactScan: { path: 'artifact-scan.json', status: artifactScan.status, scannerVersion: artifactScan.scannerVersion, treeDigest: artifactScan.treeDigest ?? null },
    releaseSanitization,
    fixtureInputHash: sourceGroupHashes.fixture,
    goldHash: sourceGroupHashes.gold,
    evaluatorHash: sourceGroupHashes.evaluator,
    oracleHash: sourceGroupHashes.oracle,
    mutationHash: sourceGroupHashes.mutation,
    visual: { screenshotArtifacts, approvalStatus: 'NOT_RUN' },
    a11y: { nvdaStatus: 'NOT_RUN', axeStatus: requestedStatus === 'CONDITIONAL' ? 'REPORT_BACKED' : 'NOT_RUN' },
    commands: { sourceLog: logDigest && tier !== 'release' ? `logs/${tier}.log` : null, sourceLogHash: logDigest?.sha256 ?? null, records: commandLines, failureReason },
    retention: { days: retentionDays, policy: 'artifact-policy.json' },
    payloadContentHash, evidencePayloads: payloads,
  };
  const manifestPath = join(temporary, 'manifest.json');
  await writeJson(manifestPath, manifest);
  const manifestDigest = await hashFile(manifestPath);
  await writeFile(join(temporary, 'MANIFEST.sha256'), `${manifestDigest.sha256}  manifest.json\n`, { flag: 'wx' });

  const statusAfter = await git('status', '--porcelain=v1', '--untracked-files=all');
  const sourceAfter = createHash('sha256').update(JSON.stringify(await (async () => {
    const names = (await git('ls-files', '-z')).split('\0').filter(Boolean).sort();
    return Promise.all(names.map(async (name) => ({ path: name, ...await hashFile(resolve(repoRoot, name)) })));
  })())).digest('hex');
  if (statusAfter !== statusBefore || sourceAfter !== sourceIdentity) throw new Error('Repository changed while evidence was being assembled');
  await rename(temporary, destination);
} catch (error) {
  await rm(temporary, { recursive: true, force: true });
  throw error;
}
console.log(relative(repoRoot, destination));
