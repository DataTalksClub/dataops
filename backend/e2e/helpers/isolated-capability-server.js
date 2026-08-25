const { spawn } = require('child_process');
const fs = require('fs');
const { randomBytes, randomUUID } = require('node:crypto');
const path = require('path');
const {
  stopTestServerProcessGroup,
  trackTestServerProcessGroup,
} = require('./test-server-process-groups');

const {
  assertExplicitPortAvailable,
  waitForOwnedServer,
} = require('../global-setup');
const { resolveTestServerCommand } = require('./tsx-launcher');

const OUTPUT_LIMIT = 20_000;
const CHECKOUT_ROOT = path.resolve(__dirname, '..', '..', '..');
const BACKEND_ROOT = path.join(CHECKOUT_ROOT, 'backend');
const FRONTEND_ROOT = path.join(CHECKOUT_ROOT, 'frontend');

const SHARED_TEST_SERVER_ENVIRONMENT = Object.freeze({
  NODE_ENV: 'test',
  IS_LOCAL: 'true',
  DATAOPS_DOCS_DOMAIN: '1',
  DTC_OFFLINE: '1',
  FRONTEND_ROOT,
  CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED: 'false',
  CONVERSATIONAL_EXECUTION_ENABLED: 'false',
  CONVERSATIONAL_ENABLED_PLUGINS: 'none',
  CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED: 'false',
  CONVERSATIONAL_TELEGRAM_VOICE_ENABLED: 'false',
  CONVERSATIONAL_TELEGRAM_PHOTO_ENABLED: 'false',
  GITHUB_TOKEN: '',
  GITHUB_TOKEN_SECRET_NAME: '',
  AWS_EC2_METADATA_DISABLED: 'true',
});

function appendOutput(server, streamName, chunk) {
  server.outputs[streamName] = (
    (server.outputs[streamName] || '') + String(chunk)
  ).slice(-OUTPUT_LIMIT);
}

function describeServerState(server, operation) {
  return [
    `${operation}: isolated test server did not stay healthy.`,
    `checkout=${server.checkout || CHECKOUT_ROOT}`,
    `requestedPort=${server.requestedPort ?? 'unknown'}`,
    `finalPort=${server.finalPort ?? server.port ?? 'unknown'}`,
    `controllerPid=${server.controllerPid ?? 'unknown'}, serverPid=${server.serverPid ?? 'unknown'}`,
    `exit=${server.lastExitStatus || (server.process ? 'running' : 'not running')}`,
    `health=${server.healthCheck || 'not probed'}`,
    `ownerToken=${server.ownerToken ? `${server.ownerToken.slice(0, 4)}...${server.ownerToken.slice(-4)}` : '<missing>'}`,
    server.unexpectedExit ? `unexpectedExit=${server.unexpectedExit}` : undefined,
    server.spawnError ? `spawnError=${server.spawnError.message}` : undefined,
    'stdout:',
    server.outputs.stdout || '<empty>',
    'stderr:',
    server.outputs.stderr || '<empty>',
  ].filter((part) => part !== undefined).join('\n');
}

function watchRuntimeExit(server, onUnexpectedExit) {
  const child = server.process;
  child.once('exit', (code, signal) => {
    server.lastExitStatus = `code=${code ?? 'none'}, signal=${signal ?? 'none'}`;
    if (!server.stopRequested && !server.unexpectedExit) {
      server.unexpectedExit = `code=${code ?? 'none'}, signal=${signal ?? 'none'}`;
      const body = describeServerState(server, 'runtime failure');
      console.error(body);
      onUnexpectedExit?.(body);
    }
  });
}

function initializeOwnedServer(server, requestedPort = 0) {
  const instanceId = randomUUID();
  Object.assign(server, {
    checkout: CHECKOUT_ROOT,
    controllerPid: null,
    finalPort: null,
    healthCheck: null,
    instanceId,
    lastExitStatus: null,
    outputs: { stdout: '', stderr: '' },
    ownerToken: randomBytes(24).toString('hex'),
    requestedPort,
    spawnError: null,
    stopRequested: false,
    unexpectedExit: null,
    serverPid: null,
  });
  return instanceId;
}

async function launchOwnedTestServer(server, environment, options = {}) {
  if (server.requestedPort !== 0) {
    await assertExplicitPortAvailable(server.requestedPort);
  }

  const child = spawn(...resolveTestServerCommand(), {
    cwd: BACKEND_ROOT,
    detached: true,
    env: {
      ...process.env,
      ...SHARED_TEST_SERVER_ENVIRONMENT,
      DATAOPS_E2E_SERVER_TOKEN: server.ownerToken,
      PORT: String(server.requestedPort),
      ...environment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.process = child;
  server.controllerPid = child.pid ?? null;
  trackTestServerProcessGroup(child);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => appendOutput(server, 'stdout', chunk));
  child.stderr.on('data', (chunk) => appendOutput(server, 'stderr', chunk));
  child.once('error', (error) => {
    server.spawnError = error;
  });
  watchRuntimeExit(server, options.onRuntimeExit);

  try {
    const ready = await waitForOwnedServer(
      child,
      server.requestedPort,
      30_000,
      { checkout: CHECKOUT_ROOT, token: server.ownerToken },
    );
    server.finalPort = ready.port;
    server.port = ready.port;
    server.baseURL = `http://127.0.0.1:${ready.port}`;
    server.serverPid = ready.owner.pid ?? null;
    server.healthCheck = (
      `HTTP 200 /api/health; run token and checkout verified; `
      + `server pid ${ready.owner.pid}`
    );
  } catch (error) {
    server.healthCheck = `readiness failed: ${error.message}`;
    const failedServer = { ...server };
    await stopOwnedTestServer(server).catch(() => {});
    throw new Error(describeServerState(failedServer, 'startup'));
  }
}

async function startOwnedTestServer({
  environment = {},
  onRuntimeExit,
  target = {},
} = {}) {
  const server = target;
  initializeOwnedServer(server, 0);
  await launchOwnedTestServer(
    server,
    {
      E2E_TEMPLATE_ACTOR_ID: '00000000-0000-0000-0000-000000000001',
      SKIP_AUTH: 'true',
      ...environment,
    },
    { onRuntimeExit },
  );
  return server;
}

async function startIsolatedCapabilityServer(server, tmpRoot, options = {}) {
  const requestedPort = typeof server.port === 'number' ? server.port : 0;
  const instanceId = initializeOwnedServer(server, requestedPort);
  const cache = path.join(tmpRoot, instanceId, 'cache');
  fs.mkdirSync(path.join(cache, 'content', 'synthetic'), { recursive: true });
  for (const [filename, content] of server.documents || []) {
    fs.writeFileSync(path.join(cache, 'content', 'synthetic', filename), content);
  }

  await launchOwnedTestServer(server, {
    AUTH_BASE_URL: 'https://auth.example.test',
    AUTH_CALLBACK_URL: 'http://127.0.0.1/auth/callback',
    AUTH_CLIENT_ID: 'synthetic-client',
    AUTH_ISSUER: 'https://issuer.example.test/synthetic-pool',
    AUTH_LOGOUT_URL: 'http://127.0.0.1/',
    // These values are inert for local browser sessions; the final loopback
    // port is discovered after the child binds port zero.
    DTC_CACHE_ROOT: cache,
    E2E_BROWSER_SESSION_USER_ID: server.userId,
    E2E_BROWSER_SESSION_USER_ROLE: server.role,
    ...(server.disabled ? { E2E_BROWSER_SESSION_USER_DISABLED: 'true' } : {}),
    ...(server.sessionLifetimeSeconds ? {
      E2E_BROWSER_SESSION_LIFETIME_SECONDS: String(server.sessionLifetimeSeconds),
    } : {}),
    ...(server.qualityFindings ? {
      DTC_CONTENT_TOKEN_DAYS_REMAINING_FOR_TESTS: '30',
    } : {}),
    SKIP_AUTH: 'false',
    SPONSOR_FINANCE_ENABLED: 'true',
    WORK_ENGINE_AUTH_MODE: 'portal',
    DATAOPS_MAILING_EXPORTS_CONFIG: server.noMailingConfig ? '[]' : JSON.stringify([{
      account: 'Synthetic audience account',
      credentialId: 'mailchimp',
      enabled: true,
      id: 'synthetic-disabled-provider',
      provider: 'mailchimp',
      scopeLabel: 'All synthetic audiences',
    }]),
  }, options);
}

async function stopOwnedTestServer(server) {
  if (!server) return;
  const child = server.process;
  if (!child) return;
  server.stopRequested = true;
  await stopTestServerProcessGroup(child.pid);
  if (!server.lastExitStatus) {
    server.lastExitStatus = `code=${child.exitCode ?? 'none'}, signal=${child.signalCode ?? 'none'}`;
  }
  server.process = null;
}

function installServerExitDiagnostics(context, server, testInfo) {
  context.on('requestfailed', () => {
    if (!server.unexpectedExit || testInfo.attachments.some((item) => item.name === 'isolated-server-exit')) return;
    const body = describeServerState(server, 'runtime failure');
    void testInfo.attach('isolated-server-exit', { contentType: 'text/plain', body }).catch(() => {});
    console.error(body);
  });
}

function assertOwnedServerResponse(server, response, label = 'isolated server request') {
  const headers = response.headers();
  const url = new URL(response.url());
  const expectedOrigin = `http://127.0.0.1:${server.finalPort}`;
  if (url.origin !== expectedOrigin) {
    throw new Error(`${label} contacted ${url.origin}, expected ${expectedOrigin}`);
  }
  if (headers['x-dataops-e2e-owner-token'] !== server.ownerToken) {
    throw new Error(
      `${label} reached a listener with a different run token `
      + `(expected=${server.ownerToken.slice(0, 4)}..., `
      + `found=${headers['x-dataops-e2e-owner-token']?.slice(0, 4) ?? 'missing'}...)`,
    );
  }
  if (headers['x-dataops-e2e-owner-pid'] !== String(server.serverPid)) {
    throw new Error(
      `${label} reached a listener with a different server PID `
        + `(expected=${server.serverPid ?? 'unknown'}, `
        + `found=${headers['x-dataops-e2e-owner-pid'] ?? 'missing'}).`,
    );
  }
  if (headers['x-dataops-e2e-owner-port'] !== String(server.finalPort)) {
    throw new Error(
      `${label} reached a listener reporting port `
        + `${headers['x-dataops-e2e-owner-port'] ?? 'unknown'}, expected ${server.finalPort}.`,
    );
  }
}

module.exports = {
  assertOwnedServerResponse,
  installServerExitDiagnostics,
  OWNED_SERVER_PATHS: Object.freeze({
    backendRoot: BACKEND_ROOT,
    checkoutRoot: CHECKOUT_ROOT,
    frontendRoot: FRONTEND_ROOT,
  }),
  startIsolatedCapabilityServer,
  startOwnedTestServer,
  stopIsolatedCapabilityServer: stopOwnedTestServer,
  stopOwnedTestServer,
};
