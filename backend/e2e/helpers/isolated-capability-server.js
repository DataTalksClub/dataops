const { spawn } = require('child_process');
const fs = require('fs');
const net = require('node:net');
const path = require('path');

const { waitForOwnedServer } = require('../global-setup');
const { resolveTestServerCommand } = require('./tsx-launcher');

const OUTPUT_LIMIT = 20_000;

function appendOutput(server, streamName, chunk) {
  server.outputs[streamName] = (
    (server.outputs[streamName] || '') + String(chunk)
  ).slice(-OUTPUT_LIMIT);
}

function exitStatus(child) {
  if (!child) return 'not spawned';
  return `pid=${child.pid ?? 'unknown'}, exitCode=${child.exitCode ?? 'none'}, signal=${child.signalCode ?? 'none'}`;
}

function describeServerState(server, operation) {
  return [
    `${operation}: isolated capability test server did not stay healthy.`,
    `port=${server.port}`,
    exitStatus(server.process),
    `health=${server.healthCheck || 'not probed'}`,
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
    if (!server.stopRequested && !server.unexpectedExit) {
      server.unexpectedExit = `code=${code ?? 'none'}, signal=${signal ?? 'none'}`;
      const body = describeServerState(server, 'runtime failure');
      console.error(body);
      onUnexpectedExit?.(body);
    }
  });
}

function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close(() => resolve(port));
    });
  });
}

async function startIsolatedCapabilityServer(server, tmpRoot, options = {}) {
  if (server.port === undefined) server.port = await reserveFreePort();
  server.stopRequested = false;
  server.unexpectedExit = null;
  server.spawnError = null;
  server.healthCheck = null;
  server.outputs = { stdout: '', stderr: '' };

  const cache = path.join(tmpRoot, String(server.port), 'cache');
  fs.mkdirSync(path.join(cache, 'content', 'synthetic'), { recursive: true });
  for (const [filename, content] of server.documents || []) {
    fs.writeFileSync(path.join(cache, 'content', 'synthetic', filename), content);
  }

  const child = spawn(...resolveTestServerCommand(), {
    cwd: path.resolve(__dirname, '..', '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      IS_LOCAL: 'true',
      SKIP_AUTH: 'false',
      DATAOPS_DOCS_DOMAIN: '1',
      WORK_ENGINE_AUTH_MODE: 'portal',
      DTC_OFFLINE: '1',
      DTC_CACHE_ROOT: cache,
      FRONTEND_ROOT: path.resolve(__dirname, '..', '..', '..', 'frontend'),
      AUTH_BASE_URL: 'https://auth.example.test',
      AUTH_ISSUER: 'https://issuer.example.test/synthetic-pool',
      AUTH_CLIENT_ID: 'synthetic-client',
      AUTH_CALLBACK_URL: `http://127.0.0.1:${server.port}/auth/callback`,
      AUTH_LOGOUT_URL: `http://127.0.0.1:${server.port}/`,
      E2E_BROWSER_SESSION_USER_ID: server.userId,
      E2E_BROWSER_SESSION_USER_ROLE: server.role,
      ...(server.disabled ? { E2E_BROWSER_SESSION_USER_DISABLED: 'true' } : {}),
      ...(server.sessionLifetimeSeconds ? {
        E2E_BROWSER_SESSION_LIFETIME_SECONDS: server.sessionLifetimeSeconds,
      } : {}),
      ...(server.qualityFindings ? {
        DTC_CONTENT_TOKEN_DAYS_REMAINING_FOR_TESTS: '30',
      } : {}),
      SPONSOR_FINANCE_ENABLED: 'true',
      DATAOPS_MAILING_EXPORTS_CONFIG: server.noMailingConfig ? '[]' : JSON.stringify([{
        id: 'synthetic-disabled-provider',
        provider: 'mailchimp',
        account: 'Synthetic audience account',
        scopeLabel: 'All synthetic audiences',
        credentialId: 'mailchimp',
        enabled: true,
      }]),
      CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED: 'false',
      CONVERSATIONAL_EXECUTION_ENABLED: 'false',
      CONVERSATIONAL_ENABLED_PLUGINS: 'none',
      PORT: String(server.port),
      GITHUB_TOKEN: '',
      GITHUB_TOKEN_SECRET_NAME: '',
      AWS_EC2_METADATA_DISABLED: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  server.process = child;
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => appendOutput(server, 'stdout', chunk));
  child.stderr?.on('data', (chunk) => appendOutput(server, 'stderr', chunk));
  child.once('error', (error) => {
    server.spawnError = error;
  });
  watchRuntimeExit(server, options.onRuntimeExit);

  try {
    await waitForOwnedServer(child, server.port, 30_000);
    server.healthCheck = 'HTTP 200 /api/health after owned listen marker';
  } catch (error) {
    server.healthCheck = `readiness failed: ${error.message}`;
    const failedServer = { ...server };
    await stopIsolatedCapabilityServer(server).catch(() => {});
    throw new Error(describeServerState(failedServer, 'startup'));
  }
}

async function stopIsolatedCapabilityServer(server) {
  const child = server.process;
  if (!child) return;
  server.stopRequested = true;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}

  let stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!stopped) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
    stopped = await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);
  }
  if (!stopped) {
    throw new Error(describeServerState(
      { ...server, process: child },
      'shutdown',
    ));
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

module.exports = {
  installServerExitDiagnostics,
  startIsolatedCapabilityServer,
  stopIsolatedCapabilityServer,
};
