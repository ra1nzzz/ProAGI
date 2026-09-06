import { createHash } from 'node:crypto';
import { access, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import process from 'node:process';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const args = process.argv.slice(2);
const valueFor = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const rootArg = valueFor('--root') ?? process.env.EVIDENCE_SCAN_ROOT;
const quarantineArg = valueFor('--quarantine') ?? process.env.EVIDENCE_QUARANTINE_ROOT;
const reportArg = valueFor('--report');
const runId = process.env.EVIDENCE_RUN_ID ?? 'unscoped';
const tier = process.env.EVIDENCE_TIER ?? 'unknown';
const scannerVersion = 'artifact-scan-v1';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
if (!rootArg) throw new Error('Usage: scan-artifacts.mjs --root <evidence-pack> [--quarantine <dir>] [--report <file>]');
if (!SAFE_ID.test(runId)) throw new Error('EVIDENCE_RUN_ID contains unsafe characters');
const root = resolve(repoRoot, rootArg);
const quarantine = quarantineArg ? resolve(repoRoot, quarantineArg) : resolve(repoRoot, 'evidence', 'quarantine', runId);
if (!root.startsWith(`${repoRoot}/`) || !quarantine.startsWith(`${repoRoot}/`)) throw new Error('Artifact paths must remain inside repository root');

const explicitCanaries = (process.env.EVIDENCE_CANARY_VALUES ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value.length >= 8)
  .map((value) => ({ kind: 'configured-canary', digest: createHash('sha256').update(value).digest('hex'), value }));
const markerPatterns = Object.freeze([
  { kind: 'deleted-canary', pattern: /\b(?:DELETED|PURGED)[_-]CANARY(?:[_-][A-Za-z0-9]+)?\b/gi },
  { kind: 'restricted-canary', pattern: /\bRESTRICTED[_-]CANARY(?:[_-][A-Za-z0-9]+)?\b/gi },
  { kind: 'prohibited-canary', pattern: /\bPROHIBITED[_-]CANARY(?:[_-][A-Za-z0-9]+)?\b/gi },
  { kind: 'secret-canary', pattern: /\bSECRET[_-]CANARY(?:[_-][A-Za-z0-9]+)?\b/gi },
  { kind: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { kind: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
]);

async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}
async function walk(path, base = root, output = []) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`Artifact tree contains a symbolic link: ${relative(repoRoot, path)}`);
  if (info.isDirectory()) {
    for (const entry of (await readdir(path)).sort()) await walk(resolve(path, entry), base, output);
  } else if (info.isFile()) {
    output.push({ absolute: path, path: relative(base, path).replaceAll('\\', '/') });
  } else throw new Error(`Artifact tree contains unsupported file: ${relative(repoRoot, path)}`);
  return output;
}
function classification(path) {
  if (/\.json$/i.test(path)) return 'reporter';
  if (/\.(png|jpe?g|webp|gif)$/i.test(path)) return 'screenshot';
  if (/\.(zip|trace)$/i.test(path)) return 'trace';
  if (/\.(har)$/i.test(path)) return 'HAR';
  if (/\.(mp4|webm)$/i.test(path)) return 'video';
  if (/\.map$/i.test(path)) return 'source-map';
  if (/\.log$/i.test(path)) return 'console';
  if (/\.md$/i.test(path)) return 'summary';
  return 'CI-upload';
}
function redactedFinding(file, kind, bytes, occurrenceCount) {
  return { path: file.path, classification: classification(file.path), kind, sha256: createHash('sha256').update(bytes).digest('hex'), occurrenceCount };
}
async function scanArtifactTree() {
  if (!(await exists(root))) return { schemaVersion: '1.0.0', scannerVersion, status: 'MISSING', runId, tier, root: relative(repoRoot, root), files: [], findings: [], scannedBytes: 0 };
  const files = await walk(root);
  const findings = [];
  const fileResults = [];
  let scannedBytes = 0;
  for (const file of files) {
    const bytes = await readFile(file.absolute);
    scannedBytes += bytes.length;
    const text = bytes.toString('utf8');
    const fileFindings = [];
    for (const configured of explicitCanaries) {
      let start = 0; let count = 0;
      while ((start = text.indexOf(configured.value, start)) !== -1) { count += 1; start += configured.value.length; }
      if (count) fileFindings.push(redactedFinding(file, configured.kind, bytes, count));
    }
    for (const marker of markerPatterns) {
      marker.pattern.lastIndex = 0;
      const matches = text.match(marker.pattern);
      if (matches?.length) fileFindings.push(redactedFinding(file, marker.kind, bytes, matches.length));
    }
    findings.push(...fileFindings);
    fileResults.push({ path: file.path, classification: classification(file.path), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), status: fileFindings.length ? 'QUARANTINED' : 'CLEAN' });
  }
  return { schemaVersion: '1.0.0', scannerVersion, status: findings.length ? 'QUARANTINED' : 'CLEAN', runId, tier, root: relative(repoRoot, root), scannedAt: new Date().toISOString(), fileCount: files.length, scannedBytes, treeDigest: createHash('sha256').update(JSON.stringify(fileResults)).digest('hex'), files: fileResults, findings };
}

const result = await scanArtifactTree();
const reportPath = reportArg ? resolve(repoRoot, reportArg) : (await exists(root) ? resolve(root, 'artifact-scan.json') : undefined);
if (reportPath && !reportPath.startsWith(`${repoRoot}/`)) throw new Error('Artifact scan report must remain inside repository root');
if (result.status === 'QUARANTINED' || result.status === 'MISSING') {
  await mkdir(quarantine, { recursive: true });
  const receipt = {
    schemaVersion: '1.0.0', scannerVersion, status: result.status, runId, tier,
    sourceRoot: relative(repoRoot, root), quarantineRoot: relative(repoRoot, quarantine),
    findings: result.findings.map(({ path, classification, kind, sha256, occurrenceCount }) => ({ path, classification, kind, sha256, occurrenceCount })),
    payloadDestroyed: result.status === 'QUARANTINED', destroyedAt: new Date().toISOString(), destruction: 'evidence-pack-removed-before-upload',
    reason: result.status === 'MISSING' ? 'evidence-pack-missing' : 'canary-or-secret-marker-detected',
  };
  await writeFile(resolve(quarantine, 'scan-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  if (await exists(root)) await rm(root, { recursive: true, force: true });
  console.error(JSON.stringify(receipt));
  process.exitCode = 1;
} else {
  if (reportPath) {
    await mkdir(dirname(reportPath), { recursive: true });
    if (await exists(reportPath)) {
      const existing = JSON.parse(await readFile(reportPath, 'utf8'));
      if (existing.scannerVersion !== scannerVersion || existing.status !== 'CLEAN' || existing.runId !== runId) throw new Error('Existing artifact-scan.json is not a matching clean scan');
    } else await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  }
  console.log(JSON.stringify(result));
}

export { scanArtifactTree };
