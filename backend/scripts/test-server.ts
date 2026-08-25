// Set the test/runtime flags before importing the handler. Local database
// startup remains explicit in runSeeds() below.
process.env.NODE_ENV = 'test';
process.env.IS_LOCAL = 'true';

import http from 'http';
import { URL } from 'url';
import { Readable } from 'stream';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { randomBytes } from 'crypto';
import { handler } from '../src/handler';
import { getClient } from '../src/db/client';
import { createBrowserSession } from '../src/db/sessions';
import { createUserWithId } from '../src/db/users';
import { createTemplate, deleteTemplate, updateTemplate } from '../src/db/templates';
import {
  setBookkeepingArchiveUploaderForTests,
  setBookkeepingStorageForTests,
} from '../src/routes/bookkeeping';
import { setMailingExportDependenciesForTests } from '../src/routes/mailingExports';
import { MailingExportProviderError } from '../src/mailingExports/mailchimp';
import { ContentsApiGithubStore, githubStoreConfigFromEnv } from '../src/docs/githubStore';
import { configureDocsRuntime } from '../src/docs/contentApi';
import { configurePortalStore } from '../src/docs/portal';
import { seed as seedUsers } from './seed-users';
import { setupLocalDynamo, stopLocal } from './local-dynamodb';
import type { LambdaEvent } from '../src/types';

const PORT = parseInt(process.env.PORT || '3001', 10);
const OWNER_TOKEN = process.env.DATAOPS_E2E_SERVER_TOKEN || randomBytes(24).toString('hex');
const OWNER_CHECKOUT = resolve(__dirname, '..', '..');
let e2eBrowserSessionToken = '';
let localDatabaseReady = false;
const e2eBookkeepingObjects = new Map<string, Buffer>();
type E2eRouteFault = {
  method?: string;
  path: string;
  query?: Record<string, string>;
  status?: number;
  delayMs?: number;
  remaining?: number;
};
let e2eRouteFaults: E2eRouteFault[] = [];
let e2eMailingProviderMode: 'pending' | 'complete' | 'fail' = 'pending';

function listeningPort(): number {
  const address = server.address();
  return address && typeof address !== 'string' ? address.port : PORT;
}

async function bufferBody(body: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function missingObject(): Error & { $metadata: { httpStatusCode: number } } {
  return Object.assign(new Error('Synthetic object not found'), {
    name: 'NotFound',
    $metadata: { httpStatusCode: 404 },
  });
}

function configureBookkeepingStorage(): void {
  process.env.BOOKKEEPING_DOCUMENTS_BUCKET ||= 'synthetic-e2e-versioned-bucket';
  process.env.BOOKKEEPING_DOCUMENTS_KMS_KEY ||= 'synthetic-e2e-kms-key';
  const client = {
    send: async (command: { constructor: { name: string }; input: { Key?: string; VersionId?: string } }) => {
      const key = String(command.input.Key || '');
      const bytes = e2eBookkeepingObjects.get(key);
      if (command.constructor.name === 'GetObjectCommand') {
        if (!bytes) throw missingObject();
        return { Body: Readable.from(bytes), ContentLength: bytes.length, ContentType: 'application/pdf', VersionId: 'synthetic-version-1' };
      }
      if (command.constructor.name === 'HeadObjectCommand') {
        if (!bytes) throw missingObject();
        return { ContentLength: bytes.length, ContentType: 'application/pdf', VersionId: 'synthetic-version-1' };
      }
      if (command.constructor.name === 'DeleteObjectCommand') {
        if (command.input.VersionId !== 'synthetic-version-1') throw new Error('Synthetic version mismatch');
        e2eBookkeepingObjects.delete(key);
      }
      return {};
    },
  };
  setBookkeepingStorageForTests(client as never, (async (_client: unknown, command: { constructor: { name: string }; input: { Key?: string } }) => {
    const key = encodeURIComponent(String(command.input.Key || ''));
    const mode = command.constructor.name === 'PutObjectCommand' ? 'upload' : 'download';
    return `http://127.0.0.1:${listeningPort()}/__e2e__/bookkeeping-object/${key}?mode=${mode}`;
  }) as never);
  setBookkeepingArchiveUploaderForTests(async (params) => {
    const key = String(params.Key || '');
    e2eBookkeepingObjects.set(key, await bufferBody(params.Body));
    return { VersionId: 'synthetic-version-1' };
  });
}

configureBookkeepingStorage();
setMailingExportDependenciesForTests({
  provider: {
    minimumIntervalMs: 0,
    async requestExport() {
      if (e2eMailingProviderMode === 'fail') throw new MailingExportProviderError('provider-api', 'Synthetic local provider failure');
      return e2eMailingProviderMode === 'complete'
        ? { status: 'completed', providerJobId: 'synthetic-local-job', downloadUrl: 'local://synthetic-export', filename: 'synthetic-export.zip' }
        : { status: 'pending', providerJobId: 'synthetic-local-job' };
    },
    async checkExport() {
      if (e2eMailingProviderMode === 'fail') throw new MailingExportProviderError('provider-api', 'Synthetic local provider failure');
      return e2eMailingProviderMode === 'complete'
        ? { status: 'completed', providerJobId: 'synthetic-local-job', downloadUrl: 'local://synthetic-export', filename: 'synthetic-export.zip' }
        : { status: 'pending', providerJobId: 'synthetic-local-job' };
    },
    async download() {
      return Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    },
  },
  async store(key) {
    return `local://synthetic-e2e/${encodeURIComponent(key)}`;
  },
  log() {},
});

function configureOfflineDocsStore(): void {
  if (process.env.DTC_OFFLINE !== '1') return;
  const store = new ContentsApiGithubStore(githubStoreConfigFromEnv());
  // Offline mode skips authenticated GitHub responses, so tests that need the
  // observed token-age finding must inject it explicitly.
  const contentTokenDaysRemaining =
    process.env.DTC_CONTENT_TOKEN_DAYS_REMAINING_FOR_TESTS;
  const parsedTokenDaysRemaining = Number(contentTokenDaysRemaining);
  if (
    contentTokenDaysRemaining !== undefined
    && Number.isFinite(parsedTokenDaysRemaining)
  ) {
    Object.defineProperty(store, 'contentTokenDaysRemaining', {
      value: parsedTokenDaysRemaining,
      configurable: true,
    });
  }
  store.writeFile = async (repoPath, content) => {
    const target = store.localPath(repoPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  store.deleteFile = async (repoPath) => {
    rmSync(store.localPath(repoPath), { force: true });
  };
  store.commitLocalFile = async () => {};
  store.deleteRepoFile = async () => {};
  configureDocsRuntime(store);
  configurePortalStore(store);
}

configureOfflineDocsStore();

function matchesRouteFault(fault: E2eRouteFault, method: string, parsed: URL): boolean {
  const apiPath = parsed.pathname.replace(/^\/work(?=\/api\/)/, '');
  if ((fault.method || 'GET').toUpperCase() !== method.toUpperCase() || fault.path !== apiPath) return false;
  return Object.entries(fault.query || {}).every(([key, value]) => parsed.searchParams.get(key) === value);
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url!, `http://localhost:${PORT}`);

  // The spawning process generates this token so bootstrap can prove that the
  // spawned local test process, not an older listener, owns the loopback port.
  const listenAddress = server.address();
  const listeningPort = listenAddress && typeof listenAddress !== 'string'
    ? listenAddress.port
    : PORT;
  res.setHeader('x-dataops-e2e-owner-token', OWNER_TOKEN);
  res.setHeader('x-dataops-e2e-owner-pid', String(process.pid));
  res.setHeader('x-dataops-e2e-owner-port', String(listeningPort));

  if (parsed.pathname === '/__e2e__/server-owner' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      checkout: OWNER_CHECKOUT,
      listeningPort,
      pid: process.pid,
      token: OWNER_TOKEN,
    }));
    return;
  }

  // Explicit opt-in seam for production-cookie browser E2E. This server is a
  // test-only executable and the opaque token is never exposed to the test.
  if (parsed.pathname === '/__e2e__/browser-session') {
    if (!e2eBrowserSessionToken) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader('set-cookie', `dataops_session=${e2eBrowserSessionToken}; Path=/; HttpOnly; SameSite=Lax`);
    res.writeHead(303, { location: '/' });
    res.end();
    return;
  }

  // Collect body
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  // Use binary encoding for multipart requests to preserve file content
  const contentType = req.headers['content-type'] || '';
  const isMultipart = contentType.includes('multipart/form-data');
  const body = chunks.length > 0
    ? Buffer.concat(chunks).toString(isMultipart ? 'binary' : 'utf-8')
    : null;

  const bookkeepingObject = parsed.pathname.match(/^\/__e2e__\/bookkeeping-object\/(.+)$/);
  if (bookkeepingObject) {
    const key = decodeURIComponent(bookkeepingObject[1]);
    if (req.method === 'PUT' && parsed.searchParams.get('mode') === 'upload') {
      if (req.headers['if-none-match'] === '*' && e2eBookkeepingObjects.has(key)) {
        res.writeHead(412);
        res.end();
        return;
      }
      e2eBookkeepingObjects.set(key, Buffer.concat(chunks));
      res.writeHead(200, { etag: '"synthetic-etag"', 'x-amz-version-id': 'synthetic-version-1' });
      res.end();
      return;
    }
    if (req.method === 'GET' && parsed.searchParams.get('mode') === 'download') {
      const object = e2eBookkeepingObjects.get(key);
      if (!object) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': key.endsWith('.zip') ? 'application/zip' : 'application/pdf' });
      res.end(object);
      return;
    }
    res.writeHead(405);
    res.end();
    return;
  }

  if (parsed.pathname === '/__e2e__/mailing-provider' && req.method === 'POST') {
    let mode: unknown;
    try { mode = JSON.parse(body || '{}').mode; } catch { mode = null; }
    if (!['pending', 'complete', 'fail'].includes(String(mode))) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid synthetic provider mode' }));
      return;
    }
    e2eMailingProviderMode = mode as typeof e2eMailingProviderMode;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ mode: e2eMailingProviderMode }));
    return;
  }

  // Test-only fixture seam for tests whose subject is Card/Cron behavior. It
  // never ships with the Lambda and cannot be confused with the read-only
  // production /api/templates authority boundary.
  const templateFixture = parsed.pathname.match(/^\/__e2e__\/template-fixtures(?:\/([^/]+))?$/);
  if (templateFixture) {
    try {
      const client = await getClient();
      const id = templateFixture[1];
      const payload = body ? JSON.parse(body) : {};
      if (req.method === 'POST' && !id) {
        const template = await createTemplate(client, payload);
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ template }));
        return;
      }
      if (req.method === 'PUT' && id) {
        const template = await updateTemplate(client, id, payload);
        res.writeHead(template ? 200 : 404, { 'content-type': 'application/json' });
        res.end(JSON.stringify(template ? { template } : { error: 'Template fixture not found' }));
        return;
      }
      if (req.method === 'DELETE' && id) {
        await deleteTemplate(client, id);
        res.writeHead(204);
        res.end();
        return;
      }
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid synthetic template fixture' }));
      return;
    }
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  // Deterministic server-side faults for route E2E. Requests still traverse
  // the browser, HTTP server, and real handler; a delay falls through to the
  // handler, while an explicit status proves non-404 transport failures.
  if (parsed.pathname === '/__e2e__/route-faults') {
    if (req.method === 'DELETE') e2eRouteFaults = [];
    else if (req.method === 'POST') {
      const payload = body ? JSON.parse(body) : {};
      e2eRouteFaults = Array.isArray(payload.faults)
        ? payload.faults.map((fault: E2eRouteFault) => ({ ...fault, remaining: fault.remaining ?? 1 }))
        : [];
    } else {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ faults: e2eRouteFaults.length }));
    return;
  }

  const fault = e2eRouteFaults.find((candidate) => matchesRouteFault(candidate, req.method || 'GET', parsed) && (candidate.remaining ?? 1) > 0);
  if (fault) {
    fault.remaining = (fault.remaining ?? 1) - 1;
    if (fault.delayMs) await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
    if (fault.status) {
      res.writeHead(fault.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `Synthetic route failure (${fault.status})` }));
      return;
    }
  }

  // Build query string parameters
  const queryStringParameters: Record<string, string> = {};
  for (const [key, value] of parsed.searchParams.entries()) {
    queryStringParameters[key] = value;
  }

  // Build Lambda-style event
  const event: LambdaEvent = {
    httpMethod: req.method!,
    path: parsed.pathname,
    headers: req.headers as Record<string, string>,
    body: body,
    queryStringParameters:
      Object.keys(queryStringParameters).length > 0
        ? queryStringParameters
        : null,
  };

  try {
    const result = await handler(event, {});

    // Set response headers
    if (result.headers) {
      for (const [key, value] of Object.entries(result.headers)) {
        res.setHeader(key, value);
      }
    }

    res.writeHead(result.statusCode);
    // If Content-Disposition is set, treat the body as binary
    const hasDownload = result.headers?.['Content-Disposition'];
    if (hasDownload && result.body) {
      res.end(Buffer.from(result.body, 'binary'));
    } else if (result.isBase64Encoded && result.body) {
      res.end(Buffer.from(result.body, 'base64'));
    } else {
      res.end(result.body || '');
    }
  } catch (err: unknown) {
    console.error('Handler error:', err);
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
});

// Seed users and templates before starting the server
async function runSeeds() {
  try {
    if (!localDatabaseReady) {
      await setupLocalDynamo({ persistent: false });
      localDatabaseReady = true;
    }
    await seedUsers();
    await createTemplate(await getClient(), {
      name: 'Synthetic Git-authored workflow',
      type: 'synthetic-git-workflow',
      tags: ['synthetic'],
      sourcePath: 'workflow-templates/synthetic-git-workflow.yaml',
      sourceRevision: '0123456789abcdef0123456789abcdef01234567',
      triggerType: 'manual',
      references: [],
      cardLinkDefinitions: [{ name: 'Synthetic output' }],
      taskDefinitions: [{
        refId: 'prepare-output',
        description: 'Prepare a synthetic output',
        offsetDays: 0,
        requiredLinkName: 'Synthetic output',
      }],
    });
    const browserUserId = process.env.E2E_BROWSER_SESSION_USER_ID;
    if (browserUserId) {
      if (process.env.E2E_BROWSER_SESSION_USER_ROLE) {
        await createUserWithId(await getClient(), browserUserId, {
          name: 'E2E browser actor',
          email: 'browser-actor@example.test',
          role: process.env.E2E_BROWSER_SESSION_USER_ROLE === 'admin' ? 'admin' : 'operator',
          disabled: process.env.E2E_BROWSER_SESSION_USER_DISABLED === 'true',
        });
      }
      const session = await createBrowserSession(await getClient(), browserUserId, {
        lifetimeSeconds: Number(process.env.E2E_BROWSER_SESSION_LIFETIME_SECONDS || 3600),
      });
      e2eBrowserSessionToken = session.token;
    }
    console.log('Test server seed data initialized.');
  } catch (err) {
    console.error('Seed error (non-fatal):', err);
  }
}

export async function start(): Promise<void> {
  await runSeeds();
  return new Promise((resolve) => {
    server.listen(PORT, '127.0.0.1', () => {
      const address = server.address();
      const actualPort = address && typeof address !== 'string' ? address.port : PORT;
      console.log(
        `Test server listening at http://127.0.0.1:${actualPort} `
        + `(owner ${OWNER_TOKEN}, checkout ${OWNER_CHECKOUT})`,
      );
      resolve();
    });
  });
}

export async function stop(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) return reject(err);
      resolve();
    });
  });
  await stopLocal();
}

// Allow running directly (e.g. tsx scripts/test-server.ts)
if (require.main === module) {
  runSeeds().then(() => {
    server.listen(PORT, '127.0.0.1', () => {
      const address = server.address();
      const actualPort = address && typeof address !== 'string' ? address.port : PORT;
      console.log(
        `Test server listening at http://127.0.0.1:${actualPort} `
        + `(owner ${OWNER_TOKEN}, checkout ${OWNER_CHECKOUT})`,
      );
    });
  });

  process.on('SIGINT', () => {
    console.log('\nShutting down test server...');
    server.close(() => {
      void stopLocal().finally(() => process.exit(0));
    });
  });

  process.on('SIGTERM', () => {
    server.close(() => {
      void stopLocal().finally(() => process.exit(0));
    });
  });
}
