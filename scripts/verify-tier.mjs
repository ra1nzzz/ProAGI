import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import { verificationCommandsForTier } from './check-suites.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TERMINATION_GRACE_MS = 1_000;

function assertPositiveMilliseconds(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function signalProcessGroup(child, signal) {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

export function runCommand(spec, { terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS } = {}) {
  assertPositiveMilliseconds(spec.timeoutMs, 'Command timeoutMs');
  assertPositiveMilliseconds(terminationGraceMs, 'Termination grace');

  return new Promise((resolveCommand, reject) => {
    const child = spawn(spec.executable, spec.args, {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    });
    let settled = false;
    let timedOut = false;
    let killSent = false;
    let exitResult;
    let timeoutTimer;
    let terminationTimer;

    const settle = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(terminationTimer);
      handler(value);
    };
    const settleTimedOut = () => settle(resolveCommand, {
      status: 'timed-out',
      code: exitResult?.code ?? null,
      signal: exitResult?.signal ?? 'SIGKILL',
      timeoutMs: spec.timeoutMs,
    });

    child.once('error', (error) => settle(reject, error));
    child.once('exit', (code, signal) => {
      exitResult = { code, signal };
      if (!timedOut) settle(resolveCommand, { status: 'exited', code: code ?? 1, signal });
      else if (killSent) settleTimedOut();
    });

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      try {
        signalProcessGroup(child, 'SIGTERM');
      } catch (error) {
        settle(reject, error);
        return;
      }
      terminationTimer = setTimeout(() => {
        try {
          signalProcessGroup(child, 'SIGKILL');
          killSent = true;
          if (exitResult) settleTimedOut();
        } catch (error) {
          settle(reject, error);
        }
      }, terminationGraceMs);
    }, spec.timeoutMs);
  });
}

async function main(argv) {
  if (argv.length !== 2 || argv[0] !== '--tier' || !['pr', 'nightly', 'release'].includes(argv[1])) {
    throw new Error('Usage: node scripts/verify-tier.mjs --tier pr|nightly|release');
  }
  const tier = argv[1];
  const commands = verificationCommandsForTier(tier);
  for (const [index, command] of commands.entries()) {
    console.log(`\n[verify-tier:${tier}] ${index + 1}/${commands.length}: ${command.executable} ${command.args.join(' ')}`);
    const result = await runCommand(command);
    if (result.status === 'timed-out') throw new Error(`Verification command timed out after ${result.timeoutMs}ms`);
    if (result.code !== 0) throw new Error(`Verification command failed with ${result.code}${result.signal ? ` (${result.signal})` : ''}`);
  }
  console.log(`\n[verify-tier:${tier}] all ${commands.length} registered commands passed`);
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
