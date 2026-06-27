const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const { chromium } = require('@playwright/test');
const fs = require('fs');

const TEST_SERVER_PORT = 3001;
const READY_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 300;

const AUTH_STATE_PATH = path.join(__dirname, '.auth-state.json');

/**
 * Poll the test server until it responds or timeout is reached.
 */
function waitForServer(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    function poll() {
      const req = http.get(
        `http://localhost:${port}/api/tasks?date=2000-01-01`,
        (res) => {
          res.resume(); // discard body
          resolve();
        }
      );
      req.on('error', () => {
        if (Date.now() >= deadline) {
          reject(new Error(`Test server on port ${port} did not start within ${timeoutMs}ms`));
          return;
        }
        setTimeout(poll, POLL_INTERVAL_MS);
      });
      req.setTimeout(1000, () => {
        req.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`Test server on port ${port} did not start within ${timeoutMs}ms`));
          return;
        }
        setTimeout(poll, POLL_INTERVAL_MS);
      });
    }

    poll();
  });
}

module.exports = async function globalSetup() {
  const serverScript = path.join(__dirname, '..', 'scripts', 'test-server.ts');

  // Use detached: true so the child runs in its own process group.
  // This lets us kill the entire group (parent tsx + child node) cleanly.
  const child = spawn(
    'npx',
    ['tsx', serverScript],
    {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        IS_LOCAL: 'true',
        SKIP_AUTH: 'true',
        PORT: String(TEST_SERVER_PORT),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    }
  );

  child.stdout.on('data', (data) => {
    process.stdout.write(`[test-server] ${data}`);
  });
  child.stderr.on('data', (data) => {
    process.stderr.write(`[test-server] ${data}`);
  });

  child.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`[test-server] exited with code ${code}`);
    }
  });

  // Store the child process so teardown can kill it
  globalThis.__testServerProcess = child;

  // Wait for the server to be ready before returning control to Playwright
  await waitForServer(TEST_SERVER_PORT, READY_TIMEOUT_MS);

  console.log(`[global-setup] Test server is ready on port ${TEST_SERVER_PORT}`);

  // ── Auth: Log in as Grace and save the auth state ──────────────
  const baseURL = `http://localhost:${TEST_SERVER_PORT}`;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ baseURL });

  try {
    const response = await page.request.post('/api/auth/login', {
      data: { email: 'grace@datatalks.club', password: '111' },
    });

    if (response.status() === 200) {
      const { token, user } = await response.json();

      // Navigate to the app and set localStorage
      await page.goto('/');
      await page.evaluate((args) => {
        localStorage.setItem(args.tokenKey, args.token);
        localStorage.setItem(args.userKey, JSON.stringify(args.user));
      }, {
        tokenKey: 'datatasks_token',
        userKey: 'datatasks_user',
        token,
        user,
      });

      // Save the storage state
      await page.context().storageState({ path: AUTH_STATE_PATH });
      console.log('[global-setup] Auth state saved with token for Grace');
    } else {
      console.warn('[global-setup] Login failed with status', response.status(), '- tests may fail');
    }
  } catch (err) {
    console.warn('[global-setup] Could not set up auth state:', err.message);
  } finally {
    await browser.close();
  }
};
