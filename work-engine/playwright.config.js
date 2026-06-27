const { defineConfig } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const AUTH_STATE_PATH = path.join(__dirname, 'e2e', '.auth-state.json');

// Create an empty auth state file if it doesn't exist (first run)
if (!fs.existsSync(AUTH_STATE_PATH)) {
  fs.writeFileSync(AUTH_STATE_PATH, JSON.stringify({ cookies: [], origins: [] }));
}

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 30000,
  retries: 0,
  globalSetup: './e2e/global-setup.js',
  globalTeardown: './e2e/global-teardown.js',
  use: {
    baseURL: 'http://localhost:3001',
    headless: true,
    // All browser tests use the auth state (pre-logged-in as Grace)
    storageState: AUTH_STATE_PATH,
  },
});
