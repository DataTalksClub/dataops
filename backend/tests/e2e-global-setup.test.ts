import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { parseConversationalRolloutSnapshot } from '../src/conversation/rollout';

interface TestServerEnvironment {
  [key: string]: string | undefined;
}

interface WaitForServerOptions {
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
}

interface OwnedTestServerChild {
  stdout?: NodeJS.ReadableStream;
  stderr?: NodeJS.ReadableStream;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once(eventName: string, listener: (...args: unknown[]) => void): unknown;
  off(eventName: string, listener: (...args: unknown[]) => void): unknown;
}

interface ExpectedTestServerOwner {
  checkout: string;
  token: string;
}

interface ReportedTestServerOwner extends ExpectedTestServerOwner {
  listeningPort: number;
  pid: number;
}

const globalSetupModule = require('../e2e/global-setup.js') as {
  (options?: { port?: number }): Promise<void>;
  buildTestServerEnvironment(
    parent?: TestServerEnvironment,
    port?: number,
    ownerToken?: string,
  ): TestServerEnvironment;
  assertExplicitPortAvailable(port: number, timeoutMs?: number): Promise<void>;
  readListenerOwnership(
    port: number,
    timeoutMs?: number,
  ): Promise<ReportedTestServerOwner>;
  waitForServer(
    port: number,
    timeoutMs: number,
    options?: WaitForServerOptions
  ): Promise<void>;
  waitForOwnedServer(
    child: OwnedTestServerChild,
    port: number,
    timeoutMs: number,
    expectedOwner: ExpectedTestServerOwner,
  ): Promise<{ owner: ReportedTestServerOwner; port: number }>;
};
const globalTeardown = require('../e2e/global-teardown.js') as () => Promise<void>;
const processGroups = require('../e2e/helpers/test-server-process-groups.js') as {
  stopTestServerProcessGroup(
    pid: number,
    options?: { termTimeoutMs?: number; killTimeoutMs?: number },
  ): Promise<void>;
};
const ownedServerModule = require('../e2e/helpers/isolated-capability-server.js') as {
  OWNED_SERVER_PATHS: {
    backendRoot: string;
    checkoutRoot: string;
    frontendRoot: string;
  };
};
const testServerPortModule = require('../e2e/test-server-port.js') as {
  DEFAULT_TEST_SERVER_PORT: number;
  TEST_SERVER_PORT: number;
  resolveTestServerPort(value?: string): number;
};

const ROLLOUT_KEYS = [
  'CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED',
  'CONVERSATIONAL_EXECUTION_ENABLED',
  'CONVERSATIONAL_ENABLED_PLUGINS',
  'CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED',
  'CONVERSATIONAL_TELEGRAM_VOICE_ENABLED',
  'CONVERSATIONAL_TELEGRAM_PHOTO_ENABLED',
] as const;

const DARK_ROLLOUT_ENVIRONMENT = {
  CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED: 'false',
  CONVERSATIONAL_EXECUTION_ENABLED: 'false',
  CONVERSATIONAL_ENABLED_PLUGINS: 'none',
  CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED: 'false',
  CONVERSATIONAL_TELEGRAM_VOICE_ENABLED: 'false',
  CONVERSATIONAL_TELEGRAM_PHOTO_ENABLED: 'false',
};

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      resolve(address.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function fakeOwnedChild(): OwnedTestServerChild & EventEmitter {
  const child = new EventEmitter() as OwnedTestServerChild & EventEmitter;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

const OWNER_TOKEN = 'a'.repeat(48);
const FOREIGN_TOKEN = 'b'.repeat(48);
const OWNER_CHECKOUT = '/synthetic/current-checkout';
const FOREIGN_CHECKOUT = '/synthetic/other-worktree';

interface SyntheticOwnerOverrides {
  checkout?: string;
  pid?: string;
  token?: string;
}

async function listenOwnedListener(overrides: SyntheticOwnerOverrides = {}): Promise<{
  ownership: ReportedTestServerOwner;
  port: number;
  server: http.Server;
}> {
  const ownership: ReportedTestServerOwner = {
    checkout: overrides.checkout ?? OWNER_CHECKOUT,
    listeningPort: 0,
    pid: Number(overrides.pid ?? 424242),
    token: overrides.token ?? OWNER_TOKEN,
  };
  const server = http.createServer((_request, response) => {
    const pathname = new URL(_request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname !== '/api/health' && pathname !== '/__e2e__/server-owner') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(pathname === '/api/health' ? '"healthy"' : JSON.stringify(ownership));
  });
  const port = await listen(server);
  ownership.listeningPort = port;
  return { ownership, port, server };
}

function ownedListenMarker(port: number, ownership: ExpectedTestServerOwner): string {
  return `Test server listening at http://127.0.0.1:${port} `
    + `(owner ${ownership.token}, checkout ${ownership.checkout})\n`;
}

function healthStatus(port: number): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const request = http.get(`http://localhost:${port}/api/health`, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.once('error', reject);
    request.setTimeout(1000, () => {
      request.destroy(new Error('health request timed out'));
    });
  });
}

function loadTestServerPortWithEnvironment(value: string | undefined) {
  const moduleId = require.resolve('../e2e/test-server-port.js');
  const savedValue = process.env.DATAOPS_E2E_SERVER_PORT;
  try {
    delete require.cache[moduleId];
    if (value === undefined) delete process.env.DATAOPS_E2E_SERVER_PORT;
    else process.env.DATAOPS_E2E_SERVER_PORT = value;
    return require(moduleId) as typeof testServerPortModule;
  } finally {
    if (savedValue === undefined) delete process.env.DATAOPS_E2E_SERVER_PORT;
    else process.env.DATAOPS_E2E_SERVER_PORT = savedValue;
    delete require.cache[moduleId];
  }
}

afterEach(async () => {
  if (globalThis.__testServerProcess) {
    await globalTeardown();
    delete globalThis.__testServerProcess;
  }
});

describe('Playwright E2E bootstrap', () => {
  it('keeps port 3001 as the browser-suite default and validates explicit overrides', () => {
    assert.equal(testServerPortModule.DEFAULT_TEST_SERVER_PORT, 3001);
    assert.equal(testServerPortModule.resolveTestServerPort(undefined), 3001);
    assert.equal(testServerPortModule.resolveTestServerPort('3210'), 3210);
    assert.equal(loadTestServerPortWithEnvironment(undefined).TEST_SERVER_PORT, 3001);
    assert.equal(loadTestServerPortWithEnvironment('3210').TEST_SERVER_PORT, 3210);
    assert.throws(
      () => testServerPortModule.resolveTestServerPort('not-a-port'),
      /must be a TCP port number/,
    );
    assert.throws(
      () => testServerPortModule.resolveTestServerPort('65536'),
      /between 1 and 65535/,
    );
  });

  it('forces exact dark rollout controls independent of the parent environment', () => {
    const inherited = globalSetupModule.buildTestServerEnvironment({
      KEEP_ME: 'yes',
      CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED: 'true',
      CONVERSATIONAL_EXECUTION_ENABLED: 'true',
      CONVERSATIONAL_ENABLED_PLUGINS: 'todo,typefully',
      CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED: 'true',
      CONVERSATIONAL_TELEGRAM_VOICE_ENABLED: 'true',
      CONVERSATIONAL_TELEGRAM_PHOTO_ENABLED: 'true',
    });

    assert.equal(inherited.KEEP_ME, 'yes');
    for (const [key, value] of Object.entries(DARK_ROLLOUT_ENVIRONMENT)) {
      assert.equal(inherited[key], value);
    }
    assert.deepEqual(
      parseConversationalRolloutSnapshot(inherited).controls,
      {
        telegramIngress: false,
        executionLeasing: false,
        enabledPlugins: [],
        typefullyExternalExecution: false,
        voice: false,
        photo: false,
      }
    );
  });

  it('requires HTTP 200 from /api/health instead of accepting a non-200 response', async () => {
    let probes = 0;
    const server = http.createServer((_request, response) => {
      probes += 1;
      response.writeHead(probes === 1 ? 503 : 200);
      response.end('discarded');
    });
    const port = await listen(server);
    try {
      await globalSetupModule.waitForServer(port, 1000, {
        pollIntervalMs: 5,
        requestTimeoutMs: 100,
      });
      assert.equal(probes, 2);
    } finally {
      await close(server);
    }
  });

  it('fails boundedly with a clear status-only diagnostic for persistent non-200', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(503);
      response.end('private response detail');
    });
    const port = await listen(server);
    try {
      await assert.rejects(
        globalSetupModule.waitForServer(port, 30, {
          pollIntervalMs: 5,
          requestTimeoutMs: 10,
        }),
        (error: Error) => {
          assert.match(error.message, /HTTP 200 from \/api\/health/);
          assert.match(error.message, /last non-timeout probe: HTTP 503/);
          assert.doesNotMatch(error.message, /private response detail/);
          return true;
        }
      );
    } finally {
      await close(server);
    }
  });

  it('retains the last HTTP status when a later probe times out at the deadline', async () => {
    let probes = 0;
    let hangingResponse: http.ServerResponse | undefined;
    const server = http.createServer((_request, response) => {
      probes += 1;
      if (probes === 1) {
        response.writeHead(503);
        response.end('private response detail');
        return;
      }
      hangingResponse = response;
    });
    const port = await listen(server);
    try {
      await assert.rejects(
        globalSetupModule.waitForServer(port, 40, {
          pollIntervalMs: 1,
          requestTimeoutMs: 30,
        }),
        (error: Error) => {
          assert.match(error.message, /last non-timeout probe: HTTP 503/);
          assert.doesNotMatch(error.message, /request_timeout|private response detail/);
          return true;
        }
      );
      assert.ok(probes >= 2);
    } finally {
      hangingResponse?.destroy();
      await close(server);
    }
  });

  it('requires the spawned child listen announcement before accepting health', async () => {
    const { ownership, port, server } = await listenOwnedListener();
    const child = fakeOwnedChild();
    try {
      child.stdout?.write(ownedListenMarker(port, {
        checkout: OWNER_CHECKOUT,
        token: OWNER_TOKEN,
      }));
      const ready = await globalSetupModule.waitForOwnedServer(
        child,
        port,
        1000,
        { checkout: OWNER_CHECKOUT, token: OWNER_TOKEN },
      );
      assert.equal(ready.port, port);
      assert.deepEqual(ready.owner, ownership);
    } finally {
      await close(server);
    }
  });

  it('rejects an identity listener with another run token', async () => {
    const { port, server } = await listenOwnedListener({ token: FOREIGN_TOKEN });
    const child = fakeOwnedChild();
    try {
      child.stdout?.write(ownedListenMarker(port, {
        checkout: OWNER_CHECKOUT,
        token: OWNER_TOKEN,
      }));
      await assert.rejects(
        globalSetupModule.waitForOwnedServer(child, port, 100, {
          checkout: OWNER_CHECKOUT,
          token: OWNER_TOKEN,
        }),
        /different run token/,
      );
    } finally {
      await close(server);
    }
  });

  it('rejects an identity listener from another checkout', async () => {
    const { port, server } = await listenOwnedListener({ checkout: FOREIGN_CHECKOUT });
    const child = fakeOwnedChild();
    try {
      child.stdout?.write(ownedListenMarker(port, {
        checkout: OWNER_CHECKOUT,
        token: OWNER_TOKEN,
      }));
      await assert.rejects(
        globalSetupModule.waitForOwnedServer(child, port, 100, {
          checkout: OWNER_CHECKOUT,
          token: OWNER_TOKEN,
        }),
        /another checkout/,
      );
    } finally {
      await close(server);
    }
  });

  it('rejects an identity endpoint whose reported port does not match its marker', async () => {
    const { ownership, port, server } = await listenOwnedListener({
      pid: '515253',
    });
    ownership.listeningPort += 1;
    const child = fakeOwnedChild();
    try {
      child.stdout?.write(ownedListenMarker(port, {
        checkout: OWNER_CHECKOUT,
        token: OWNER_TOKEN,
      }));
      await assert.rejects(
        globalSetupModule.waitForOwnedServer(child, port, 100, {
          checkout: OWNER_CHECKOUT,
          token: OWNER_TOKEN,
        }),
        /reported port .* announced/,
      );
    } finally {
      await close(server);
    }
  });

  it('rejects an exited child instead of trusting a foreign listener', async () => {
    const child = fakeOwnedChild();
    child.exitCode = 1;
    await assert.rejects(
      globalSetupModule.waitForOwnedServer(child, 3210, 100, {
        checkout: OWNER_CHECKOUT,
        token: OWNER_TOKEN,
      }),
      /already exited \(code=1/,
    );
  });

  it('requires cryptographic ownership proof before readiness can start', () => {
    const child = fakeOwnedChild();
    assert.throws(
      () => globalSetupModule.waitForOwnedServer(child, 0, 100, {
        checkout: OWNER_CHECKOUT,
        token: 'not-a-generated-run-token',
      }),
      /48-character hexadecimal run token/,
    );
  });

  it('diagnoses an occupied explicit port and identifies the current owner', async () => {
    const { port, server } = await listenOwnedListener({
      checkout: FOREIGN_CHECKOUT,
      pid: '515253',
    });
    try {
      await assert.rejects(
        globalSetupModule.assertExplicitPortAvailable(port),
        (error: Error) => {
          assert.match(error.message, /unavailable \(EADDRINUSE\)/);
          assert.match(error.message, new RegExp(`${FOREIGN_CHECKOUT.replace(/\//g, '\\/')}, pid=515253`));
          return true;
        },
      );
    } finally {
      await close(server);
    }
  });

  it('lets teardown finish when the spawned server has already stopped', async () => {
    const child = fakeOwnedChild();
    child.exitCode = 0;
    globalThis.__testServerProcess = child as unknown as import('node:child_process').ChildProcess;
    await globalTeardown();
  });

  it('verifies an exited controller has not left its detached group behind', async () => {
    const child = spawn('sleep', ['30'], { detached: true });
    child.exitCode = 0;
    globalThis.__testServerProcess = child;
    try {
      await globalTeardown();
      await assert.rejects(
        Promise.resolve().then(() => process.kill(-child.pid!, 0)),
        (error: NodeJS.ErrnoException) => error.code === 'ESRCH',
      );
    } finally {
      delete globalThis.__testServerProcess;
    }
  });

  it('stops a detached test-server group before forgetting its owner', async () => {
    const child = spawn('sleep', ['30'], { detached: true });
    const pid = child.pid!;
    processGroups.trackTestServerProcessGroup(child);
    await processGroups.stopTestServerProcessGroup(pid, {
      termTimeoutMs: 1_000,
      killTimeoutMs: 1_000,
    });
  });

  it('derives isolated-server roots from the helper location', () => {
    const paths = ownedServerModule.OWNED_SERVER_PATHS;

    assert.equal(paths.backendRoot, path.resolve(__dirname, '..'));
    assert.equal(paths.checkoutRoot, path.resolve(__dirname, '..', '..'));
    assert.equal(paths.frontendRoot, path.resolve(__dirname, '..', '..', 'frontend'));
    assert.equal(fs.existsSync(path.join(paths.frontendRoot, 'index.html')), true);
  });

  it('routes every browser-suite backend server through the owned launcher', () => {
    const e2eDirectory = path.resolve(__dirname, '..', 'e2e');
    const forbidden = /resolveTestServerCommand|scripts[\\/]test-server\.ts/;
    const offenders = fs.readdirSync(e2eDirectory)
      .filter((name) => name.endsWith('.spec.js'))
      .flatMap((name) => {
        const source = fs.readFileSync(path.join(e2eDirectory, name), 'utf8');
        return forbidden.test(source) ? [name] : [];
      });

    assert.deepEqual(offenders, []);
  });

  it('starts the real child healthy and dark when all six parent controls are absent', async () => {
    const saved = Object.fromEntries(ROLLOUT_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ROLLOUT_KEYS) delete process.env[key];

    try {
      const childEnvironment = globalSetupModule.buildTestServerEnvironment(process.env);
      for (const [key, value] of Object.entries(DARK_ROLLOUT_ENVIRONMENT)) {
        assert.equal(childEnvironment[key], value);
      }

      // Reserve an OS-selected loopback port so concurrent worktrees running the
      // backend suite do not contend for Playwright's fixed browser port.
      const reservation = http.createServer();
      const port = await listen(reservation);
      await close(reservation);

      await globalSetupModule({ port });
      assert.equal(await healthStatus(port), 200);
    } finally {
      for (const key of ROLLOUT_KEYS) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

declare global {
  var __testServerProcess: import('node:child_process').ChildProcess | undefined;
}
