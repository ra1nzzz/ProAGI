import { randomBytes } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { validateStructuredReport, VERIFICATION_REGISTRY } from './check-suites.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function safeId(value, label) {
  if (!SAFE_ID.test(value)) throw new Error(`${label} must match ${SAFE_ID}`);
  return value;
}

async function mustNotExist(path) {
  try {
    await access(path);
    throw new Error(`Refusing to overwrite existing test output: ${path}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function run(command, args, env) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, env, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
}

const [runner, ...rawArgs] = process.argv.slice(2);
if (!['vitest', 'playwright'].includes(runner)) {
  throw new Error('Usage: run-test-report.mjs <vitest|playwright> --lane <lane> [-- runner arguments]');
}
const laneIndex = rawArgs.indexOf('--lane');
if (laneIndex === -1 || !rawArgs[laneIndex + 1]) throw new Error('--lane is required');
const lane = safeId(rawArgs[laneIndex + 1], 'lane');
const separator = rawArgs.indexOf('--');
const runnerArgs = separator === -1 ? [] : rawArgs.slice(separator + 1);
const generatedRunId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${process.pid}-${randomBytes(4).toString('hex')}`;
const runId = safeId(process.env.EVIDENCE_RUN_ID ?? process.env.TEST_RUN_ID ?? generatedRunId, 'run id');
const outputRoot = resolve(repoRoot, 'test-results', runId, lane);
const reportPath = resolve(outputRoot, `${runner}-report.json`);
await mustNotExist(outputRoot);
await mkdir(outputRoot, { recursive: true });

const executable = resolve(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? `${runner}.cmd` : runner);
let args;
const env = { ...process.env, TEST_RUN_ID: runId, TEST_LANE: lane };
if (runner === 'vitest') {
  args = ['run', ...runnerArgs, '--reporter=default', '--reporter=json', `--outputFile=${reportPath}`];
} else {
  env.PLAYWRIGHT_JSON_OUTPUT_FILE = reportPath;
  env.PLAYWRIGHT_OUTPUT_DIR = resolve(outputRoot, 'artifacts');
  args = ['test', ...runnerArgs];
}
const result = await run(executable, args, env);
if (result.code !== 0) throw new Error(`${runner} exited with ${result.code ?? `signal ${result.signal}`}`);
const laneSpec = VERIFICATION_REGISTRY.lanes[lane];
if (!laneSpec || laneSpec.runner !== runner) throw new Error(`Lane ${lane} is not registered for ${runner}`);
const expectedSuites = laneSpec.suites;
const reportOptions = laneSpec.options ?? {};
const summary = await validateStructuredReport(reportPath, runner, repoRoot, expectedSuites, reportOptions);
console.log(`Trusted structured report: ${JSON.stringify(summary)}`);
