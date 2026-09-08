import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const sourceIndex = args.indexOf('--source');
const modeIndex = args.indexOf('--mode');
if (args[sourceIndex + 1] !== 'real-readonly' || args[modeIndex + 1] !== 'shadow') {
  throw new Error('Usage: npm run eval -- --source real-readonly --mode shadow');
}

const child = spawn(process.execPath, [
  resolve('node_modules/vitest/vitest.mjs'), 'run',
  'tests/fixtures/m2-noise.test.ts', 'tests/privacy/m2-consent.test.ts',
], { stdio: 'inherit', shell: false });
const code = await new Promise((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', (exitCode, signal) => resolveExit(exitCode ?? (signal ? 1 : 0)));
});
if (code !== 0) process.exit(code);

const runId = new Date().toISOString().replaceAll(/[:.]/g, '-');
const outputDir = resolve('test-results', 'm2', runId);
await mkdir(outputDir, { recursive: true });
await writeFile(resolve(outputDir, 'gate-2.json'), JSON.stringify({
  schemaVersion: '1.0.0', gate: 'M2', source: 'real-readonly', mode: 'shadow',
  automatedChecks: 'PASS', pilot: 'NOT_RUN', decision: 'CONDITIONAL',
  reason: 'A real participant pilot with pre-registered NetValue evidence is still required before Gate 2 PASS.',
}, null, 2) + '\n', 'utf8');
console.log(`Gate 2 decision: CONDITIONAL (automated checks passed; pilot evidence required)`);
