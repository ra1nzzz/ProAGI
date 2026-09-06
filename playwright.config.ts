import { defineConfig, devices } from '@playwright/test';

const safeSegment = (value: string | undefined, fallback: string): string => {
  const segment = value ?? fallback;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(segment)) throw new Error(`Unsafe Playwright output segment: ${segment}`);
  return segment;
};

const runId = safeSegment(process.env.TEST_RUN_ID, `local-${Date.now()}-${process.pid}`);
const lane = safeSegment(process.env.TEST_LANE, 'e2e');
const outputRoot = `test-results/${runId}/${lane}`;
const port = Number(process.env.PLAYWRIGHT_PORT ?? '4173');
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('PLAYWRIGHT_PORT must be an unprivileged TCP port');
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${port}`;
const jsonOutput = process.env.PLAYWRIGHT_JSON_OUTPUT_FILE ?? `${outputRoot}/playwright-report.json`;

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? `${outputRoot}/artifacts`,
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: jsonOutput }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off'
  },
  webServer: {
    command: `VITE_PROAGI_E2E_HOOKS=1 npm run build && npm run preview -- --strictPort --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000
  },
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'chromium-320', use: { ...devices['Desktop Chrome'], viewport: { width: 320, height: 720 } } }
  ]
});
