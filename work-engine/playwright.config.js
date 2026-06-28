const { defineConfig } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const AUTH_STATE_PATH = path.join(__dirname, 'e2e', '.auth-state.json');
const DEFAULT_AUTH_STATE = {
  cookies: [],
  origins: [
    {
      origin: 'http://localhost:3001',
      localStorage: [
        {
          name: 'dataops_token',
          value: 'e2e-bypass-token',
        },
        {
          name: 'dataops_user',
          value: JSON.stringify({
            id: '00000000-0000-0000-0000-000000000001',
            name: 'Grace',
            email: 'grace@datatalks.club',
            createdAt: '2026-01-01T00:00:00.000Z',
          }),
        },
      ],
    },
  ],
};

// Create a usable auth state file if it doesn't exist (first run).
if (!fs.existsSync(AUTH_STATE_PATH)) {
  fs.writeFileSync(AUTH_STATE_PATH, JSON.stringify(DEFAULT_AUTH_STATE, null, 2));
}

module.exports = defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  timeout: 30000,
  retries: 0,
  reporter: process.env.CI
    ? [['line'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : [['list']],
  globalSetup: './e2e/global-setup.js',
  globalTeardown: './e2e/global-teardown.js',
  use: {
    baseURL: 'http://localhost:3001',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    // All browser tests use the auth state (pre-logged-in as Grace)
    storageState: AUTH_STATE_PATH,
  },
});
