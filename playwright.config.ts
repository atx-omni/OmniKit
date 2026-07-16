import { defineConfig, devices } from '@playwright/test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const port = 4178;
const browserTestRoot = join(tmpdir(), 'omnikit-bi-migration-browser-tests');

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: `http://127.0.0.1:${port}/api/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      OMNIKIT_NO_BROWSER: 'true',
      OMNIKIT_VAULT_PATH: join(browserTestRoot, 'vault.enc'),
      OMNIKIT_JOB_HISTORY_PATH: join(browserTestRoot, 'jobs.json'),
      OMNIKIT_SEMANTIC_MIGRATION_AUDIT_PATH: join(browserTestRoot, 'semantic-migration-audit.jsonl'),
      OMNIKIT_MIGRATION_ENGINE_MODE: 'off',
    },
  },
});
