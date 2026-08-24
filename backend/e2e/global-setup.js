const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { resolveTestServerCommand } = require('./helpers/tsx-launcher');

const TEST_SERVER_PORT = 3001;
const READY_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 300;
const READY_PATH = '/api/health';

const DARK_ROLLOUT_ENVIRONMENT = Object.freeze({
  CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED: 'false',
  CONVERSATIONAL_EXECUTION_ENABLED: 'false',
  CONVERSATIONAL_ENABLED_PLUGINS: 'none',
  CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED: 'false',
  CONVERSATIONAL_TELEGRAM_VOICE_ENABLED: 'false',
  CONVERSATIONAL_TELEGRAM_PHOTO_ENABLED: 'false',
});

const AUTH_STATE_PATH = path.join(__dirname, '.auth-state.json');
const GRACE_USER = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Grace',
  email: 'grace@datatalks.club',
  createdAt: '2026-01-01T00:00:00.000Z',
};

function writeDefaultAuthState() {
  fs.writeFileSync(
    AUTH_STATE_PATH,
    JSON.stringify({
      cookies: [],
      origins: [
        {
          origin: `http://localhost:${TEST_SERVER_PORT}`,
          localStorage: [
            { name: 'dataops_token', value: 'e2e-bypass-token' },
            { name: 'dataops_user', value: JSON.stringify(GRACE_USER) },
          ],
        },
      ],
    }, null, 2)
  );
}

function buildTestServerEnvironment(parentEnvironment = process.env) {
  return {
    ...parentEnvironment,
    NODE_ENV: 'test',
    IS_LOCAL: 'true',
    SKIP_AUTH: 'true',
    PORT: String(TEST_SERVER_PORT),
    FRONTEND_ROOT: path.resolve(__dirname, '..', '..', 'frontend'),
    // Server-owned actor for template-admin tests only. Other route permission
    // tests retain their existing explicit actor/no-actor behavior.
    E2E_TEMPLATE_ACTOR_ID: GRACE_USER.id,
    ...DARK_ROLLOUT_ENVIRONMENT,
  };
}

/**
 * Poll the health endpoint until it returns HTTP 200 or timeout is reached.
 * Diagnostics intentionally include no response body or request details.
 */
function waitForServer(port, timeoutMs, options = {}) {
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? 1000;

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let settled = false;
    let retryTimer;
    let lastProbe = 'no response';
    let lastNonTimeoutProbe;

    function fail() {
      if (settled) return;
      settled = true;
      if (retryTimer) clearTimeout(retryTimer);
      const diagnosticLabel = lastNonTimeoutProbe === undefined
        ? 'last probe'
        : 'last non-timeout probe';
      reject(new Error(
        `Test server on port ${port} did not return HTTP 200 from ${READY_PATH} `
        + `within ${timeoutMs}ms (${diagnosticLabel}: ${lastNonTimeoutProbe ?? lastProbe})`
      ));
    }

    function retry() {
      if (settled) return;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        fail();
        return;
      }
      retryTimer = setTimeout(poll, Math.min(pollIntervalMs, remainingMs));
    }

    function poll() {
      if (Date.now() >= deadline) {
        fail();
        return;
      }

      let completed = false;
      const req = http.get(
        `http://localhost:${port}${READY_PATH}`,
        (res) => {
          if (completed || settled) {
            res.resume();
            return;
          }
          completed = true;
          res.resume(); // discard body
          if (res.statusCode === 200) {
            settled = true;
            resolve();
            return;
          }
          lastProbe = `HTTP ${res.statusCode ?? 'unknown'}`;
          lastNonTimeoutProbe = lastProbe;
          retry();
        }
      );
      req.on('error', (error) => {
        if (completed || settled) return;
        completed = true;
        const code = typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
          ? error.code
          : 'connection_error';
        lastProbe = code;
        lastNonTimeoutProbe = lastProbe;
        retry();
      });
      req.setTimeout(Math.min(requestTimeoutMs, Math.max(1, deadline - Date.now())), () => {
        if (completed || settled) return;
        completed = true;
        lastProbe = 'request_timeout';
        req.destroy();
        retry();
      });
    }

    poll();
  });
}

async function globalSetup() {
  // Playwright specs also launch isolated test-server children. Keep every
  // process in this test-only tree on the same explicit dark rollout state.
  Object.assign(process.env, DARK_ROLLOUT_ENVIRONMENT);

  // Use detached: true so the child runs in its own process group.
  // This lets us kill the entire group (parent tsx + child node) cleanly.
  const child = spawn(
    ...resolveTestServerCommand(),
    {
      env: buildTestServerEnvironment(),
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

  // UI tests do not need a server-side session while SKIP_AUTH=true. Use a
  // deterministic localStorage session so auth/logout tests cannot invalidate
  // the shared browser storage state for unrelated UI tests.
  writeDefaultAuthState();
  console.log('[global-setup] Auth state saved with test bypass token for Grace');
}

module.exports = globalSetup;
module.exports.buildTestServerEnvironment = buildTestServerEnvironment;
module.exports.waitForServer = waitForServer;
