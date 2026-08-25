const { spawn } = require('child_process');
const { randomBytes } = require('node:crypto');
const http = require('http');
const net = require('node:net');
const path = require('path');
const fs = require('fs');
const { resolveTestServerCommand } = require('./helpers/tsx-launcher');
const { trackTestServerProcessGroup } = require('./helpers/test-server-process-groups');

const { TEST_SERVER_PORT } = require('./test-server-port');
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

function writeDefaultAuthState(port = TEST_SERVER_PORT) {
  fs.writeFileSync(
    AUTH_STATE_PATH,
    JSON.stringify({
      cookies: [],
      origins: [
        {
          origin: `http://127.0.0.1:${port}`,
          localStorage: [
            { name: 'dataops_token', value: 'e2e-bypass-token' },
            { name: 'dataops_user', value: JSON.stringify(GRACE_USER) },
          ],
        },
      ],
    }, null, 2)
  );
}

function buildTestServerEnvironment(
  parentEnvironment = process.env,
  port = TEST_SERVER_PORT,
  ownerToken = randomBytes(24).toString('hex'),
) {
  return {
    ...parentEnvironment,
    NODE_ENV: 'test',
    IS_LOCAL: 'true',
    SKIP_AUTH: 'true',
    PORT: String(port),
    DATAOPS_E2E_SERVER_TOKEN: ownerToken,
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

/**
 * A health response proves that *a* server owns the fixed port, not that the
 * child just spawned owns it. Require that child's successful listen log before
 * probing health so a foreign listener cannot satisfy bootstrap.
 */
function waitForOwnedServer(
  child,
  requestedPort,
  timeoutMs,
  expectedOwner,
) {
  if (
    !expectedOwner
    || !/^[0-9a-f]{48}$/.test(expectedOwner.token || '')
    || typeof expectedOwner.checkout !== 'string'
    || expectedOwner.checkout.length === 0
  ) {
    throw new Error(
      'Test-server readiness requires a 48-character hexadecimal run token '
      + 'and owning checkout path.',
    );
  }

  const ownerToken = expectedOwner.token;

  return new Promise((resolve, reject) => {
    let settled = false;
    let retryTimer;
    let activeRequest;
    let announcedPort;
    let outputBuffer = '';
    const deadline = Date.now() + timeoutMs;

    function cleanup() {
      clearTimeout(retryTimer);
      if (activeRequest) activeRequest.destroy();
      child.stdout?.off('data', onOutput);
      child.stderr?.off('data', onErrorOutput);
      child.off('error', onError);
      child.off('exit', onExit);
    }

    function settle(operation) {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    }

    function fail(message) {
      settle(() => reject(new Error(message)));
    }

    function succeededWithOwnership(reportedOwner) {
      settle(() => resolve({
        owner: reportedOwner,
        port: announcedPort,
      }));
    }

    function maskToken(token) {
      return typeof token === 'string' && token.length >= 8
        ? `${token.slice(0, 4)}...${token.slice(-4)}`
        : '<missing>';
    }

    function childStatus() {
      return `code=${child.exitCode ?? 'none'}, signal=${child.signalCode ?? 'none'}`;
    }

    function scheduleProbe(delayMs) {
      if (settled) return;
      if (child.exitCode !== null || child.signalCode !== null) {
        fail(`Test server child exited before readiness (${childStatus()}).`);
        return;
      }

      const waitMs = Math.min(delayMs, Math.max(0, deadline - Date.now()));
      if (waitMs <= 0 && retryTimer === undefined) {
        fail(
          `The spawned test server did not return HTTP 200 from /api/health `
          + `within ${timeoutMs}ms after announcing port ${announcedPort}.`
        );
        return;
      }
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        probe();
      }, waitMs);
    }

    function probe() {
      if (settled) return;
      let completed = false;
      const request = http.get(`http://127.0.0.1:${announcedPort}${READY_PATH}`, (response) => {
        if (completed || settled) {
          response.resume();
          return;
        }
        completed = true;
        activeRequest = undefined;
        response.resume();
        if (response.statusCode === 200) {
          probeOwnership();
          return;
        }
        scheduleProbe(POLL_INTERVAL_MS);
      });
      request.on('error', () => {
        if (completed || settled) return;
        completed = true;
        activeRequest = undefined;
        scheduleProbe(POLL_INTERVAL_MS);
      });
      request.setTimeout(Math.min(1000, Math.max(1, deadline - Date.now())), () => {
        if (completed || settled) return;
        completed = true;
        activeRequest = undefined;
        request.destroy();
        scheduleProbe(POLL_INTERVAL_MS);
      });
      activeRequest = request;
    }

    function probeOwnership() {
      if (settled) return;
      let completed = false;
      const request = http.get(
        `http://127.0.0.1:${announcedPort}/__e2e__/server-owner`,
        (response) => {
          if (completed || settled) {
            response.resume();
            return;
          }
          completed = true;
          activeRequest = undefined;
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            if (settled) return;
            if (response.statusCode !== 200) {
              scheduleProbe(POLL_INTERVAL_MS);
              return;
            }

            let reportedOwner;
            try {
              reportedOwner = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              scheduleProbe(POLL_INTERVAL_MS);
              return;
            }

            if (reportedOwner.token !== ownerToken) {
              fail(
                'The listener on the announced test-server port has a different '
                + `run token (expected=${maskToken(ownerToken)}, `
                + `found=${maskToken(reportedOwner.token)}); refusing to reuse it.`,
              );
              return;
            }
            if (
              expectedOwner.checkout
              && reportedOwner.checkout !== expectedOwner.checkout
            ) {
              fail(
                'The listener on the announced test-server port belongs to another '
                + `checkout (expected=${expectedOwner.checkout}, `
                + `found=${reportedOwner.checkout}).`,
              );
              return;
            }
            if (Number(reportedOwner.listeningPort) !== announcedPort) {
              fail(
                `The spawned test server reported port ${reportedOwner.listeningPort}, `
                + `but its owned listen marker announced ${announcedPort}.`,
              );
              return;
            }
            succeededWithOwnership(reportedOwner);
          });
        },
      );
      request.on('error', () => {
        if (completed || settled) return;
        completed = true;
        activeRequest = undefined;
        scheduleProbe(POLL_INTERVAL_MS);
      });
      request.setTimeout(Math.min(1000, Math.max(1, deadline - Date.now())), () => {
        if (completed || settled) return;
        completed = true;
        activeRequest = undefined;
        request.destroy();
        scheduleProbe(POLL_INTERVAL_MS);
      });
      activeRequest = request;
    }

    function onOutput(chunk) {
      if (settled) return;
      outputBuffer = `${outputBuffer}${String(chunk)}`.slice(-20_000);
      for (const match of outputBuffer.matchAll(
        /Test server listening at http:\/\/127\.0\.0\.1:(\d+) \(owner ([0-9a-f]{48}), checkout ([^\r\n]+)\)/g,
      )) {
        const [, parsedPort, parsedToken] = match;
        if (parsedToken !== ownerToken) continue;

        announcedPort = Number(parsedPort);
        if (!Number.isInteger(announcedPort) || announcedPort < 1 || announcedPort > 65535) {
          fail(`The spawned test server announced an invalid loopback port: ${parsedPort}.`);
          return;
        }
        if (requestedPort > 0 && announcedPort !== requestedPort) {
          fail(
            `The spawned test server bound port ${announcedPort} instead of `
            + `requested port ${requestedPort}.`,
          );
          return;
        }
        probe();
        return;
      }
    }

    function onErrorOutput() {}

    function onError(error) {
      fail(`Test server child failed before readiness: ${error.message}`);
    }

    function onExit() {
      fail(`Test server child exited before readiness (${childStatus()}).`);
    }

    if (child.exitCode !== null || child.signalCode !== null) {
      fail(`Test server child had already exited (${childStatus()}).`);
      return;
    }

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', onOutput);
    child.stderr?.on('data', onErrorOutput);
    child.once('error', onError);
    child.once('exit', onExit);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      fail(
        'Test server child did not announce an owned loopback listener '
        + `within ${timeoutMs}ms; `
        + 'refusing to use another listener.'
      );
    }, timeoutMs);
  });
}

async function readListenerOwnership(port, timeoutMs = 500) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      `http://127.0.0.1:${port}/__e2e__/server-owner`,
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(new Error(`HTTP ${response.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error('ownership request timed out')));
    request.once('error', reject);
  });
}

async function assertExplicitPortAvailable(port, timeoutMs = 1000) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Requested test-server port is invalid: ${String(port)}`);
  }

  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      probe.close(() => resolve());
    });
  }).catch(async (error) => {
    const currentOwner = await readListenerOwnership(port, timeoutMs).catch(() => null);
    const details = currentOwner
      ? `current owner checkout=${currentOwner.checkout ?? 'unknown'}, pid=${currentOwner.pid ?? 'unknown'}`
      : 'the existing listener did not expose a DataOps ownership endpoint';
    throw new Error(
      `Requested test-server port ${port} is unavailable (${error.code || error.message}); ${details}.`,
      { cause: error },
    );
  });
}

async function globalSetup({ port = TEST_SERVER_PORT } = {}) {
  // Playwright specs also launch isolated test-server children. Keep every
  // process in this test-only tree on the same explicit dark rollout state.
  Object.assign(process.env, DARK_ROLLOUT_ENVIRONMENT);

  const ownerToken = randomBytes(24).toString('hex');
  if (port > 0) await assertExplicitPortAvailable(port);

  // Use detached: true so the child runs in its own process group.
  // This lets us kill the entire group (parent tsx + child node) cleanly.
  const child = spawn(
    ...resolveTestServerCommand(),
    {
      env: buildTestServerEnvironment(undefined, port, ownerToken),
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
  trackTestServerProcessGroup(child);

  // Wait for this spawned process to own the port before returning control to
  // Playwright. A foreign HTTP 200 must never satisfy global setup.
  let ready;
  try {
    ready = await waitForOwnedServer(child, port, READY_TIMEOUT_MS, {
      checkout: path.resolve(__dirname, '..', '..'),
      token: ownerToken,
    });
  } catch (error) {
    await globalTeardown();
    throw error;
  }

  console.log(
    `[global-setup] Test server is ready on port ${ready.port}; `
    + `run token and checkout verified for server pid ${ready.owner.pid}.`,
  );

  // UI tests do not need a server-side session while SKIP_AUTH=true. Use a
  // deterministic localStorage session so auth/logout tests cannot invalidate
  // the shared browser storage state for unrelated UI tests.
  writeDefaultAuthState(ready.port);
  console.log('[global-setup] Auth state saved with test bypass token for Grace');
}

module.exports = globalSetup;
module.exports.assertExplicitPortAvailable = assertExplicitPortAvailable;
module.exports.buildTestServerEnvironment = buildTestServerEnvironment;
module.exports.readListenerOwnership = readListenerOwnership;
module.exports.waitForServer = waitForServer;
module.exports.waitForOwnedServer = waitForOwnedServer;
