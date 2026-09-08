import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';
import { validateStructuredReport } from './check-suites.mjs';

const args = process.argv.slice(2);
const suites = {
  '--source real-readonly --mode shadow': { gate: 'M2', directories: [], files: ['tests/fixtures/m2-noise.test.ts', 'tests/privacy/m2-consent.test.ts'], reason: 'Real participant pilot and pre-registered NetValue evidence remain required.' },
  '--suite runtime-isolation': { gate: 'M3a', directories: ['runtime'], files: ['tests/runtime'], reason: 'Live provider evaluation and M2 participant pilot remain separate evidence requirements.' },
  '--suite projection-isolation': { gate: 'M3b', directories: ['projection'], files: ['tests/projection'], reason: 'M2 participant pilot and browser acceptance remain separate evidence requirements.' },
};
const suite = suites[args.join(' ')];
if (!suite) throw new Error('Usage: eval --source real-readonly --mode shadow | --suite runtime-isolation | --suite projection-isolation');
const runId = new Date().toISOString().replaceAll(/[:.]/g, '-');
const outputDir = resolve('test-results', suite.gate.toLowerCase(), runId);
await mkdir(outputDir, { recursive: true });
const report = resolve(outputDir, 'tests.json');

const child = spawn(process.execPath, [
  resolve('node_modules/vitest/vitest.mjs'), 'run',
  ...suite.files, '--reporter=default', '--reporter=json', `--outputFile=${report}`,
], { stdio: 'inherit', shell: false });
const code = await new Promise((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', (exitCode, signal) => resolveExit(exitCode ?? (signal ? 1 : 0)));
});
if (code !== 0) process.exit(code);

const checks = await validateStructuredReport(report, 'vitest', process.cwd(), suite.directories, { expectedFiles: suite.files.filter((file) => file.endsWith('.test.ts')) });
await writeFile(resolve(outputDir, 'gate.json'), JSON.stringify({
  schemaVersion: '1.0.0', gate: suite.gate, suite: args.join(' '), checks,
  automatedChecks: 'PASS', pilot: 'NOT_RUN', decision: 'CONDITIONAL',
  reason: suite.reason,
}, null, 2) + '\n', 'utf8');
console.log(`${suite.gate}: CONDITIONAL (${checks.passed}/${checks.total} automated checks passed); ${outputDir}`);
