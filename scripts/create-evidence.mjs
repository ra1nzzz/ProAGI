import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import process from 'node:process';

const roots = [
  'src', 'tests', 'docs/final', 'scripts', '.github/workflows',
  'package.json', 'package-lock.json', 'index.html', 'playwright.config.ts',
  'vite.config.ts', 'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json',
];
const files = [];
async function walk(path) {
  const info = await stat(path);
  if (!info.isDirectory()) {
    files.push(path);
    return;
  }
  for (const name of (await readdir(path)).sort()) await walk(join(path, name));
}
for (const root of roots) await walk(root);

const artifacts = [];
for (const file of files.sort()) {
  const bytes = await readFile(file);
  artifacts.push({ path: relative('.', file), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
}
const runId = process.env.EVIDENCE_RUN_ID ?? new Date().toISOString().replaceAll(/[:.]/g, '-');
const out = join('evidence', 'M1', runId);
const requestedStatus = process.env.EVIDENCE_STATUS ?? 'NOT_RUN';
if (!['NOT_RUN', 'CONDITIONAL', 'PASS', 'FAIL'].includes(requestedStatus)) throw new Error('Invalid EVIDENCE_STATUS');
const verifyLog = 'evidence-logs/verify-pr.log';
let verifyLogText = '';
try { verifyLogText = await readFile(verifyLog, 'utf8'); } catch { /* represented as NOT_RUN below */ }
const vitestMatches = [...verifyLogText.matchAll(/Tests\s+(\d+) passed/g)];
const browserMatches = [...verifyLogText.matchAll(/\n\s*(\d+) passed \([\d.]+s\)/g)];
const vitestCount = vitestMatches.at(-1)?.[1];
const browserCount = browserMatches.at(-1)?.[1];
const automatedEvidencePresent = process.env.VERIFY_PR_EXIT_CODE === '0' && Boolean(vitestCount) && Boolean(browserCount);
const status = ['CONDITIONAL', 'PASS'].includes(requestedStatus) && !automatedEvidencePresent ? 'NOT_RUN' : requestedStatus;
await mkdir(out, { recursive: true });

const manifest = {
  schemaVersion: '1.1.0', milestone: 'M1', runId, createdAt: new Date().toISOString(),
  buildIdentity: createHash('sha256').update(JSON.stringify(artifacts)).digest('hex'),
  status, artifacts,
};
await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(join(out, 'environment.json'), `${JSON.stringify({
  node: process.version, platform: process.platform, arch: process.arch,
  githubActions: process.env.GITHUB_ACTIONS === 'true', hostedCi: process.env.GITHUB_ACTIONS === 'true' ? 'RUN_CONTEXT_ONLY' : 'NOT_RUN',
}, null, 2)}\n`);
await writeFile(join(out, 'gate-status.json'), `${JSON.stringify({
  gate: 'Gate 1', decision: status,
  automated: {
    verifyPrExitCode: process.env.VERIFY_PR_EXIT_CODE === undefined ? 'NOT_RECORDED' : Number(process.env.VERIFY_PR_EXIT_CODE),
    vitest: process.env.VERIFY_PR_EXIT_CODE === '0' && vitestCount ? `PASS_${vitestCount}_OF_${vitestCount}` : 'NOT_RUN_OR_SEE_VERIFY_LOG',
    chromium: process.env.VERIFY_PR_EXIT_CODE === '0' && browserCount ? `PASS_${browserCount}_OF_${browserCount}` : 'NOT_RUN_OR_SEE_VERIFY_LOG',
    crossTabPrivacyEpochFence: process.env.VERIFY_PR_EXIT_CODE === '0' && verifyLogText.includes('second tab privacy epoch fences') ? 'PASS' : 'NOT_RUN',
  },
  manual: { nvda: 'NOT_RUN', humanVisualApproval: 'NOT_RUN' },
  limitations: [
    'M1 is bundled synthetic-only; no real desktop capture, live actions, Runtime, cloud, Tauri, Rust, or UIA.',
    'Cross-tab privacy preview fencing is tested; cross-tab deletion/PURGE remains NOT_RUN.',
    'Whole-storage clear enumerates, deletes, and verifies CacheStorage when that browser root exists.',
  ],
}, null, 2)}\n`);

try {
  await copyFile(verifyLog, join(out, 'verify-pr.log'));
} catch {
  await writeFile(join(out, 'verify-pr.log.NOT_RUN'), 'No captured verify:pr log was available.\n');
}
const visualDir = 'test-results/visual';
try {
  const screenshotOut = join(out, 'screenshots');
  await mkdir(screenshotOut, { recursive: true });
  for (const name of (await readdir(visualDir)).filter((value) => value.endsWith('.png')).sort()) {
    await copyFile(join(visualDir, name), join(screenshotOut, basename(name)));
  }
} catch {
  await writeFile(join(out, 'screenshots.NOT_RUN'), 'No visual screenshots were available.\n');
}
console.log(out);
