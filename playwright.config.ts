import { defineConfig, devices } from '@playwright/test';

const CONSOLE_URL = process.env.E2E_CONSOLE_URL ?? 'http://127.0.0.1:3000';
const FUNNEL_URL = process.env.E2E_FUNNEL_URL ?? 'http://127.0.0.1:3001';

/**
 * E2E runs entirely in demo mode against fixture providers: no credentials, no
 * external writes, deterministic data. That is what makes the full
 * proposal → paused Meta draft → lead → CRM → revenue → scale chain testable.
 */
const demoEnv = {
  DEMO_MODE: 'true',
  EXTERNAL_WRITES_ENABLED: 'false',
  META_MUTATIONS_ENABLED: 'false',
  META_CAPI_ENABLED: 'false',
  HUBSPOT_WRITES_ENABLED: 'false',
  APP_ENVIRONMENT: 'test',
  E2E: '1',
  AUTH_ALLOWLIST: '@am-beratung.de',
  REDIRECT_ALLOWLIST: 'am-beratung.de,go.am-beratung.de,localhost',
  TRACKING_SIGNING_SECRET: 'e2e-tracking-secret-value-at-least-32-chars',
  APP_ENCRYPTION_KEY: 'ZTJlLWVuY3J5cHRpb24ta2V5LTMyLWJ5dGVzLWxvbmc=',
  CRON_SECRET: 'e2e-cron-secret',
  NEXT_PUBLIC_CONSOLE_URL: CONSOLE_URL,
  NEXT_PUBLIC_FUNNEL_URL: FUNNEL_URL,
  NODE_ENV: 'production',
};

export default defineConfig({
  testDir: './e2e/tests',
  outputDir: './test-results',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 90_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: CONSOLE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
  },

  projects: [
    {
      name: 'console',
      testMatch: /console\/.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: CONSOLE_URL },
    },
    {
      name: 'funnel-desktop',
      testMatch: /funnel\/.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: FUNNEL_URL },
    },
    {
      name: 'funnel-mobile',
      testMatch: /mobile\/.*\.spec\.ts/,
      use: {
        ...devices['iPhone 13'],
        baseURL: FUNNEL_URL,
        // Overridden per test for the 320 / 375 / 430 px checks.
      },
    },
    {
      name: 'journey',
      testMatch: /journey\/.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: CONSOLE_URL },
    },
  ],

  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : [
        {
          command: 'pnpm --filter @am/console start',
          url: `${CONSOLE_URL}/api/health`,
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
          env: demoEnv,
          stdout: 'pipe',
          stderr: 'pipe',
        },
        {
          command: 'pnpm --filter @am/funnels start',
          url: `${FUNNEL_URL}/api/health`,
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
          env: demoEnv,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      ],
});
