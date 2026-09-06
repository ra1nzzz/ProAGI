import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateStructuredReport, validateSuiteSources } from '../check-suites.mjs';

async function fixture() {
  return mkdtemp(join(tmpdir(), 'proagi-gate-'));
}

const validVitest = {
  success: true,
  numTotalTestSuites: 1,
  numPassedTestSuites: 1,
  numFailedTestSuites: 0,
  numPendingTestSuites: 0,
  numTodoTests: 0,
  numTotalTests: 1,
  numPassedTests: 1,
  numFailedTests: 0,
  numPendingTests: 0,
  testResults: [{ name: 'tests/unit/gate.test.ts', assertionResults: [{ status: 'passed' }] }],
};

test('suite source validation rejects only, skip, and todo modifiers', async () => {
  for (const modifier of ['only', 'skip', 'todo']) {
    const root = await fixture();
    try {
      await mkdir(join(root, 'tests', 'unit'), { recursive: true });
      await writeFile(join(root, 'tests', 'unit', 'gate.test.ts'), `test.${modifier}('blocked', () => {});\n`);
      await assert.rejects(validateSuiteSources(root, ['unit']), new RegExp(`\\.${modifier}`));
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('structured Vitest reports reject malformed, zero, and skipped results', async () => {
  const root = await fixture();
  try {
    for (const [name, value, message] of [
      ['malformed.json', '{', /malformed JSON/],
      ['zero.json', JSON.stringify({ ...validVitest, numTotalTests: 0, numPassedTests: 0, testResults: [] }), /zero results/],
      ['skip.json', JSON.stringify({ ...validVitest, numPassedTests: 0, numPendingTests: 1, testResults: [{ name: 'tests/unit/gate.test.ts', assertionResults: [{ status: 'skipped' }] }] }), /skipped\/todo/],
    ]) {
      const path = join(root, name);
      await writeFile(path, value);
      await assert.rejects(validateStructuredReport(path, 'vitest', root), message);
    }
    await mkdir(join(root, 'tests', 'privacy'), { recursive: true });
    await writeFile(join(root, 'tests', 'privacy', 'gate.test.ts'), "test('gate', () => {});\n");
    const missingSuite = join(root, 'missing-suite.json');
    await writeFile(missingSuite, JSON.stringify({ ...validVitest, testResults: [{ name: `${root}/tests/unit/a.test.ts`, assertionResults: [{ status: 'passed' }] }] }));
    await assert.rejects(validateStructuredReport(missingSuite, 'vitest', root, ['privacy']), /missing required suite: privacy/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('structured report path must remain inside repository root', async () => {
  const root = await fixture();
  const outside = resolve(root, '..', `outside-${Date.now()}.json`);
  try {
    await writeFile(outside, JSON.stringify(validVitest));
    await assert.rejects(validateStructuredReport(outside, 'vitest', root), /escapes repository root/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});
