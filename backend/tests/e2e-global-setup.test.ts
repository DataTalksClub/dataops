import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';

import { parseConversationalRolloutSnapshot } from '../src/conversation/rollout';

interface TestServerEnvironment {
  [key: string]: string | undefined;
}

interface WaitForServerOptions {
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
}

const globalSetupModule = require('../e2e/global-setup.js') as {
  (): Promise<void>;
  buildTestServerEnvironment(parent?: TestServerEnvironment): TestServerEnvironment;
  waitForServer(
    port: number,
    timeoutMs: number,
    options?: WaitForServerOptions
  ): Promise<void>;
};
const globalTeardown = require('../e2e/global-teardown.js') as () => Promise<void>;

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

function healthStatus(): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const request = http.get('http://localhost:3001/api/health', (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.once('error', reject);
    request.setTimeout(1000, () => {
      request.destroy(new Error('health request timed out'));
    });
  });
}

afterEach(async () => {
  if (globalThis.__testServerProcess) {
    await globalTeardown();
    delete globalThis.__testServerProcess;
  }
});

describe('Playwright E2E bootstrap', () => {
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

  it('starts the real child healthy and dark when all six parent controls are absent', async () => {
    const saved = Object.fromEntries(ROLLOUT_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ROLLOUT_KEYS) delete process.env[key];

    try {
      const childEnvironment = globalSetupModule.buildTestServerEnvironment(process.env);
      for (const [key, value] of Object.entries(DARK_ROLLOUT_ENVIRONMENT)) {
        assert.equal(childEnvironment[key], value);
      }

      await globalSetupModule();
      assert.equal(await healthStatus(), 200);
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
