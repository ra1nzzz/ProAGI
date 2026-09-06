import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const PR_VITEST_SUITES = Object.freeze(['unit', 'integration', 'fixtures', 'privacy', 'replay', 'worker', 'projection', 'evaluator', 'a11y', 'visual']);
const CHROMIUM_PROJECTS = Object.freeze(['chromium-desktop', 'chromium-320']);
const MINUTE_MS = 60_000;
export const MAX_GITHUB_ARTIFACT_RETENTION_DAYS = 90;
const command = (executable, args, timeoutMinutes) => Object.freeze({ executable, args: Object.freeze(args), timeoutMs: timeoutMinutes * MINUTE_MS });
const PR_COMMANDS = Object.freeze([
  command('npm', ['run', 'check:suites'], 2),
  command('npm', ['run', 'test:release-gates'], 3),
  command('npm', ['run', 'typecheck'], 3),
  command('npm', ['run', 'lint'], 3),
  command('npm', ['run', 'verify:csp'], 2),
  command('npm', ['audit', '--audit-level=high'], 3),
  command('npm', ['run', 'test:report'], 8),
  command('npm', ['run', 'build'], 5),
  command('npm', ['run', 'check:production-artifact'], 2),
  command('npm', ['run', 'test:e2e:report'], 10),
  command('npm', ['run', 'smoke'], 5),
]);
const NIGHTLY_COMMANDS = Object.freeze([
  ...PR_COMMANDS,
  command('node', ['scripts/run-test-report.mjs', 'vitest', '--lane', 'nightly-privacy', '--', 'tests/privacy'], 5),
  command('node', ['scripts/run-test-report.mjs', 'vitest', '--lane', 'nightly-worker', '--', 'tests/worker'], 5),
]);
const RELEASE_COMMANDS = Object.freeze([
  ...NIGHTLY_COMMANDS,
  command('node', ['scripts/check-release-candidate.mjs'], 2),
]);

export const VERIFICATION_REGISTRY = Object.freeze({
  // GitHub Actions artifact retention accepts 1–90 days across repository visibility tiers.
  // Any long-term archive must live outside upload-artifact; CI does not claim it here.
  retentionDays: Object.freeze({ pr: 14, nightly: 90, release: MAX_GITHUB_ARTIFACT_RETENTION_DAYS }),
  execution: Object.freeze({ pr: PR_COMMANDS, nightly: NIGHTLY_COMMANDS, release: RELEASE_COMMANDS }),
  tiers: Object.freeze({
    pr: Object.freeze([
      Object.freeze({ path: 'pr-vitest/vitest-report.json', type: 'vitest', suites: PR_VITEST_SUITES }),
      Object.freeze({ path: 'pr-e2e/playwright-report.json', type: 'playwright', suites: Object.freeze([]), options: Object.freeze({ requiredProjects: CHROMIUM_PROJECTS, requireAllE2E: true }) }),
      Object.freeze({ path: 'pr-smoke/playwright-report.json', type: 'playwright', suites: Object.freeze([]), options: Object.freeze({ requiredProjects: CHROMIUM_PROJECTS, expectedSpecs: Object.freeze([{ file: 'tests/e2e/app.spec.ts', title: 'renders the canonical AppShell order and eight-part Orb' }]) }) }),
    ]),
    nightly: Object.freeze([
      Object.freeze({ path: 'pr-vitest/vitest-report.json', type: 'vitest', suites: PR_VITEST_SUITES }),
      Object.freeze({ path: 'pr-e2e/playwright-report.json', type: 'playwright', suites: Object.freeze([]), options: Object.freeze({ requiredProjects: CHROMIUM_PROJECTS, requireAllE2E: true }) }),
      Object.freeze({ path: 'pr-smoke/playwright-report.json', type: 'playwright', suites: Object.freeze([]), options: Object.freeze({ requiredProjects: CHROMIUM_PROJECTS, expectedSpecs: Object.freeze([{ file: 'tests/e2e/app.spec.ts', title: 'renders the canonical AppShell order and eight-part Orb' }]) }) }),
      Object.freeze({ path: 'nightly-privacy/vitest-report.json', type: 'vitest', suites: Object.freeze(['privacy']) }),
      Object.freeze({ path: 'nightly-worker/vitest-report.json', type: 'vitest', suites: Object.freeze(['worker']) }),
    ]),
    release: Object.freeze([
      Object.freeze({ path: 'pr-vitest/vitest-report.json', type: 'vitest', suites: PR_VITEST_SUITES }),
      Object.freeze({ path: 'pr-e2e/playwright-report.json', type: 'playwright', suites: Object.freeze([]), options: Object.freeze({ requiredProjects: CHROMIUM_PROJECTS, requireAllE2E: true }) }),
      Object.freeze({ path: 'pr-smoke/playwright-report.json', type: 'playwright', suites: Object.freeze([]), options: Object.freeze({ requiredProjects: CHROMIUM_PROJECTS, expectedSpecs: Object.freeze([{ file: 'tests/e2e/app.spec.ts', title: 'renders the canonical AppShell order and eight-part Orb' }]) }) }),
      Object.freeze({ path: 'nightly-privacy/vitest-report.json', type: 'vitest', suites: Object.freeze(['privacy']) }),
      Object.freeze({ path: 'nightly-worker/vitest-report.json', type: 'vitest', suites: Object.freeze(['worker']) }),
    ]),
  }),
  lanes: Object.freeze({
    'pr-vitest': Object.freeze({ runner: 'vitest', suites: PR_VITEST_SUITES }),
    'pr-e2e': Object.freeze({ runner: 'playwright', suites: Object.freeze([]), options: Object.freeze({ requiredProjects: CHROMIUM_PROJECTS, requireAllE2E: true }) }),
    'pr-smoke': Object.freeze({ runner: 'playwright', suites: Object.freeze([]), options: Object.freeze({ requiredProjects: CHROMIUM_PROJECTS, expectedSpecs: Object.freeze([{ file: 'tests/e2e/app.spec.ts', title: 'renders the canonical AppShell order and eight-part Orb' }]) }) }),
    'nightly-privacy': Object.freeze({ runner: 'vitest', suites: Object.freeze(['privacy']) }),
    'nightly-worker': Object.freeze({ runner: 'vitest', suites: Object.freeze(['worker']) }),
  }),
});

export const REQUIRED_SUITES = Object.freeze([...PR_VITEST_SUITES, 'e2e']);

export function verificationReportsForTier(tier) {
  if (!(tier in VERIFICATION_REGISTRY.tiers)) throw new Error(`Unknown verification tier: ${tier}`);
  return VERIFICATION_REGISTRY.tiers[tier];
}

export function verificationCommandsForTier(tier) {
  if (!(tier in VERIFICATION_REGISTRY.execution)) throw new Error(`Unknown verification tier: ${tier}`);
  return VERIFICATION_REGISTRY.execution[tier];
}

export function verificationRetentionDaysForTier(tier) {
  if (!(tier in VERIFICATION_REGISTRY.retentionDays)) throw new Error(`Unknown verification tier: ${tier}`);
  return VERIFICATION_REGISTRY.retentionDays[tier];
}

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const FORBIDDEN_TEST_MODIFIERS = new Set(['only', 'skip', 'todo']);

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

export function assertContained(repoRoot, candidate, label = candidate) {
  const rel = relative(repoRoot, candidate);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return;
  throw new Error(`${label} escapes repository root`);
}

async function trustedRealpath(repoRoot, candidate, label = candidate) {
  const absolute = resolve(repoRoot, candidate);
  assertContained(repoRoot, absolute, label);
  const originalInfo = await lstat(absolute);
  if (originalInfo.isSymbolicLink()) throw new Error(`Symbolic links are not accepted: ${label}`);
  const actual = await realpath(absolute);
  assertContained(repoRoot, actual, label);
  return actual;
}

async function collectTestFiles(repoRoot, suite) {
  const suiteRoot = await trustedRealpath(repoRoot, resolve(repoRoot, 'tests', suite), `tests/${suite}`);
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        const target = await realpath(path);
        assertContained(repoRoot, target, relative(repoRoot, path));
        throw new Error(`Symbolic links are not accepted as test evidence: ${relative(repoRoot, path)}`);
      }
      if (info.isDirectory()) await walk(path);
      else if (info.isFile() && TEST_FILE.test(entry.name)) files.push(path);
    }
  }
  await walk(suiteRoot);
  return files.sort();
}

export async function collectPlaywrightRegistry(repoRoot = process.cwd()) {
  const actualRoot = await realpath(repoRoot);
  const files = await collectTestFiles(actualRoot, 'e2e');
  const registry = [];
  for (const file of files) {
    const sourceText = await readFile(file, 'utf8');
    const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['test', 'it'].includes(node.expression.text)) {
        const title = node.arguments[0];
        if (title && ts.isStringLiteral(title)) registry.push({ file: relative(actualRoot, file).replaceAll('\\', '/'), title: title.text });
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  if (registry.length === 0) throw new Error('Playwright source registry is empty');
  const keys = new Set();
  for (const item of registry) {
    const key = `${item.file}\u0000${item.title}`;
    if (keys.has(key)) throw new Error(`Duplicate Playwright source test: ${item.file} :: ${item.title}`);
    keys.add(key);
  }
  return registry;
}

function forbiddenModifiers(sourceText, file) {
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const findings = [];
  function visit(node) {
    let modifier;
    let token;
    if (ts.isPropertyAccessExpression(node)) {
      modifier = node.name.text;
      token = node.name;
    } else if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
      modifier = node.argumentExpression.text;
      token = node.argumentExpression;
    }
    if (modifier && token && FORBIDDEN_TEST_MODIFIERS.has(modifier)) {
      const location = sourceFile.getLineAndCharacterOfPosition(token.getStart(sourceFile));
      findings.push(`${file}:${location.line + 1}:${location.character + 1} uses .${modifier}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return findings;
}

export async function validateSuiteSources(repoRoot = process.cwd(), required = REQUIRED_SUITES) {
  const actualRoot = await realpath(repoRoot);
  const suites = [];
  const violations = [];
  for (const suite of required) {
    let files;
    try {
      files = await collectTestFiles(actualRoot, suite);
    } catch (error) {
      violations.push(`${suite}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (files.length === 0) {
      violations.push(`${suite}: no test/spec source files`);
      continue;
    }
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      violations.push(...forbiddenModifiers(text, relative(actualRoot, file)));
      if (/--passWithNoTests\b/.test(text)) violations.push(`${relative(actualRoot, file)} contains --passWithNoTests`);
    }
    suites.push({ suite, files: files.map((file) => relative(actualRoot, file)), fileCount: files.length });
  }
  if (violations.length) throw new Error(`Suite source validation failed:\n- ${violations.join('\n- ')}`);
  return { schemaVersion: '1.0.0', suiteCount: suites.length, suites };
}

function validateVitest(report, expectedSuites = [], expectedFiles = []) {
  const root = assertObject(report, 'Vitest report');
  const totalSuites = assertNonNegativeInteger(root.numTotalTestSuites, 'Vitest numTotalTestSuites');
  const passedSuites = assertNonNegativeInteger(root.numPassedTestSuites, 'Vitest numPassedTestSuites');
  const failedSuites = assertNonNegativeInteger(root.numFailedTestSuites, 'Vitest numFailedTestSuites');
  const pendingSuites = assertNonNegativeInteger(root.numPendingTestSuites, 'Vitest numPendingTestSuites');
  const total = assertNonNegativeInteger(root.numTotalTests, 'Vitest numTotalTests');
  const passed = assertNonNegativeInteger(root.numPassedTests, 'Vitest numPassedTests');
  const failed = assertNonNegativeInteger(root.numFailedTests, 'Vitest numFailedTests');
  const pending = assertNonNegativeInteger(root.numPendingTests, 'Vitest numPendingTests');
  const todo = assertNonNegativeInteger(root.numTodoTests, 'Vitest numTodoTests');
  if (!Array.isArray(root.testResults)) throw new Error('Vitest testResults must be an array');
  if (total === 0 || totalSuites === 0 || root.testResults.length === 0) throw new Error('Vitest report has zero results');
  if (passedSuites + failedSuites + pendingSuites !== totalSuites) throw new Error('Vitest suite counters do not balance');
  const assertions = root.testResults.flatMap((result, index) => {
    const item = assertObject(result, `Vitest testResults[${index}]`);
    if (item.status !== 'passed') throw new Error(`Vitest suite ${index} is not passed`);
    if (!Array.isArray(item.assertionResults)) throw new Error(`Vitest testResults[${index}].assertionResults must be an array`);
    return item.assertionResults;
  });
  if (assertions.length !== total) throw new Error(`Vitest assertion count ${assertions.length} does not match total ${total}`);
  const passedAssertions = assertions.filter((entry) => entry?.status === 'passed').length;
  const failedAssertions = assertions.filter((entry) => ['failed', 'failure'].includes(entry?.status)).length;
  const pendingAssertions = assertions.filter((entry) => ['pending', 'skipped', 'todo', 'disabled'].includes(entry?.status)).length;
  if (passedAssertions !== passed || failedAssertions !== failed || pendingAssertions !== pending + todo) throw new Error('Vitest assertion counters do not match assertion statuses');
  const normalizedReportFiles = root.testResults.map((result, index) => {
    const name = String(result?.name ?? '').replaceAll('\\', '/');
    if (!name) throw new Error(`Vitest testResults[${index}].name must be non-empty`);
    return name;
  });
  for (const suite of expectedSuites) {
    const marker = `/tests/${suite}/`;
    if (!normalizedReportFiles.some((name) => name.includes(marker) || name.startsWith(`tests/${suite}/`))) throw new Error(`Vitest report is missing required suite: ${suite}`);
  }
  for (const file of expectedFiles) {
    const normalized = file.replaceAll('\\', '/');
    if (!normalizedReportFiles.some((name) => name === normalized || name.endsWith(`/${normalized}`))) throw new Error(`Vitest report is missing required file: ${file}`);
  }
  if (pending !== 0 || todo !== 0 || failed !== 0 || passed !== total || passedSuites !== totalSuites || failedSuites !== 0 || pendingSuites !== 0) throw new Error(`Vitest report is not fully passing (${passed}/${total}, ${failed} failed)`);
  if (root.success !== true) throw new Error('Vitest report success is not true');
  return { runner: 'vitest', total, passed, failed, skipped: pending + todo };
}

function flattenPlaywrightSuites(suites, tests = [], files = new Set(), inheritedFile = undefined) {
  if (!Array.isArray(suites)) throw new Error('Playwright suites must be an array');
  for (const suite of suites) {
    assertObject(suite, 'Playwright suite');
    const suiteFile = suite.file === undefined ? inheritedFile : suite.file;
    if (suite.file !== undefined) {
      if (typeof suite.file !== 'string' || !suite.file) throw new Error('Playwright suite file is malformed');
      files.add(suite.file.replaceAll('\\', '/'));
    }
    const childSuites = suite.suites === undefined ? [] : suite.suites;
    const specs = suite.specs === undefined ? [] : suite.specs;
    if (!Array.isArray(childSuites) || !Array.isArray(specs)) throw new Error('Playwright suite arrays are malformed');
    for (const spec of specs) {
      assertObject(spec, 'Playwright spec');
      if (typeof spec.title !== 'string' || !spec.title) throw new Error('Playwright spec title is malformed');
      if (spec.ok !== true) throw new Error(`Playwright spec ${spec.title} is not ok`);
      if (!Array.isArray(spec.tests) || spec.tests.length === 0) throw new Error('Playwright spec has zero tests');
      tests.push(...spec.tests.map((test) => ({ ...test, __suiteFile: suiteFile, __specTitle: spec.title })));
    }
    flattenPlaywrightSuites(childSuites, tests, files, suiteFile);
  }
  return tests;
}

function sameReportedPath(actualPath, expectedPath) {
  const actual = actualPath.replaceAll('\\', '/');
  const expected = expectedPath.replaceAll('\\', '/');
  return actual === expected || actual.endsWith(`/${expected}`) || basename(actual) === basename(expected);
}

function validatePlaywright(report, expectedFiles = [], options = {}) {
  const root = assertObject(report, 'Playwright report');
  if (!Array.isArray(root.suites)) throw new Error('Playwright suites must be an array');
  const files = new Set();
  const tests = flattenPlaywrightSuites(root.suites, [], files);
  if (tests.length === 0) throw new Error('Playwright report has zero results');
  for (const file of expectedFiles) {
    const normalized = file.replaceAll('\\', '/');
    if (![...files].some((name) => sameReportedPath(name, normalized))) throw new Error(`Playwright report is missing required file: ${file}`);
  }
  const requiredProjects = options.requiredProjects ?? [];
  if (requiredProjects.length) {
    const configured = root.config?.projects;
    if (!Array.isArray(configured)) throw new Error('Playwright config projects must be an array');
    const configuredNames = configured.map((project) => project?.name).filter((name) => typeof name === 'string');
    if (configuredNames.length !== requiredProjects.length || requiredProjects.some((name) => !configuredNames.includes(name))) throw new Error(`Playwright projects do not exactly match required projects: ${requiredProjects.join(', ')}`);
    const actualProjects = [...new Set(tests.map((test) => test.projectName))];
    if (actualProjects.some((name) => !requiredProjects.includes(name)) || requiredProjects.some((name) => !actualProjects.includes(name))) throw new Error('Playwright results do not cover every required project');
  }
  const expectedSpecs = options.expectedSpecs ?? [];
  for (const expected of expectedSpecs) {
    const normalizedFile = expected.file.replaceAll('\\', '/');
    for (const project of requiredProjects.length ? requiredProjects : [undefined]) {
      const matches = tests.filter((test) => sameReportedPath(test.__suiteFile ?? '', normalizedFile) && test.__specTitle === expected.title && (project === undefined || test.projectName === project));
      if (matches.length !== 1) throw new Error(`Playwright report must contain exactly one ${normalizedFile} :: ${expected.title}${project ? ` :: ${project}` : ''}, found ${matches.length}`);
    }
  }
  const stats = root.stats;
  if (!stats || !Number.isSafeInteger(stats.expected) || !Number.isSafeInteger(stats.skipped) || !Number.isSafeInteger(stats.unexpected) || !Number.isSafeInteger(stats.flaky)) throw new Error('Playwright stats are missing or malformed');
  if (stats.expected !== tests.length || stats.skipped !== 0 || stats.unexpected !== 0 || stats.flaky !== 0) throw new Error('Playwright stats do not describe a complete passing run');
  for (const [index, rawTest] of tests.entries()) {
    const test = assertObject(rawTest, `Playwright test[${index}]`);
    if (test.expectedStatus !== 'passed' || test.status !== 'expected') throw new Error(`Playwright test[${index}] has an unexpected status`);
    if (!Array.isArray(test.results) || test.results.length === 0) throw new Error(`Playwright test[${index}] has zero attempts`);
    if (test.results.some((attempt) => !attempt || attempt.status !== 'passed' || (Array.isArray(attempt.errors) && attempt.errors.length))) throw new Error(`Playwright test[${index}] has a failed attempt`);
  }
  if (Array.isArray(root.errors) && root.errors.length) throw new Error('Playwright report contains top-level errors');
  return { runner: 'playwright', total: tests.length, passed: tests.length, failed: 0, skipped: 0, projects: requiredProjects };
}

export async function validateStructuredReport(reportPath, type, repoRoot = process.cwd(), expectedSuites = [], options = {}) {
  const actualRoot = await realpath(repoRoot);
  const actualReport = await trustedRealpath(actualRoot, reportPath, 'structured report');
  const expectedFiles = expectedSuites.length ? (await validateSuiteSources(actualRoot, expectedSuites)).suites.flatMap((suite) => suite.files) : [];
  const runnerOptions = options.requireAllE2E
    ? { ...options, expectedSpecs: await collectPlaywrightRegistry(actualRoot) }
    : options;
  const info = await lstat(actualReport);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Structured report must be a regular file');
  let parsed;
  try {
    parsed = JSON.parse(await readFile(actualReport, 'utf8'));
  } catch (error) {
    throw new Error(`Structured report is malformed JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (type === 'vitest') return { ...validateVitest(parsed, expectedSuites, expectedFiles), path: relative(actualRoot, actualReport) };
  if (type === 'playwright') return { ...validatePlaywright(parsed, expectedFiles, runnerOptions), path: relative(actualRoot, actualReport) };
  throw new Error(`Unsupported report type: ${type}`);
}

async function main(argv) {
  const reportIndex = argv.indexOf('--report');
  if (reportIndex !== -1) {
    const report = argv[reportIndex + 1];
    const typeIndex = argv.indexOf('--type');
    const type = typeIndex === -1 ? undefined : argv[typeIndex + 1];
    if (!report || !type) throw new Error('Usage: check-suites.mjs --report <path> --type <vitest|playwright>');
    console.log(JSON.stringify(await validateStructuredReport(report, type), null, 2));
    return;
  }
  const result = await validateSuiteSources();
  console.log(`Verified ${result.suiteCount} non-empty required suites with no only/skip/todo.`);
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
