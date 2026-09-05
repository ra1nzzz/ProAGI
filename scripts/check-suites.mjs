import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const required = ['unit', 'integration', 'fixtures', 'privacy', 'replay', 'worker', 'projection', 'evaluator', 'a11y', 'visual', 'e2e'];
const missing = [];
for (const suite of required) {
  try {
    const entries = await readdir(resolve('tests', suite), { recursive: true });
    if (!entries.some((entry) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(String(entry)))) missing.push(suite);
  } catch {
    missing.push(suite);
  }
}
if (missing.length) {
  console.error(`Required test suites are empty or absent: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`Verified ${required.length} non-empty required suites.`);
