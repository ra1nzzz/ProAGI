import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

const [lane, ...args] = process.argv.slice(2);
const selectors = new Map([
  ['fixtures:--suite:m2-noise', 'tests/fixtures/m2-noise.test.ts'],
  ['privacy:--adapter:real-readonly', 'tests/privacy/m2-consent.test.ts'],
]);
const selector = args.length === 2 ? `${lane}:${args[0]}:${args[1]}` : '';
const target = selectors.get(selector) ?? (args.length === 0 && ['fixtures', 'privacy'].includes(lane) ? `tests/${lane}` : null);
if (!target) throw new Error(`Usage: test:${lane} [--suite m2-noise|--adapter real-readonly]`);

const child = spawn(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', target], { stdio: 'inherit', shell: false });
child.once('error', (error) => { console.error(error); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
