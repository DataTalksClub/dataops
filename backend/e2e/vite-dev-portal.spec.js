const { test, expect } = require('@playwright/test');
const { DynamoDBClient, CreateTableCommand } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const dynalite = require('dynalite');

const ROOT = path.resolve(__dirname, '..', '..');
const FRONTEND_ASSETS = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'backend', 'src', 'docs', 'frontend-assets.json'),
  'utf8',
)).files;

const OWNED_STACKS = new Set();
const SYNTHETIC_DOC = `---
id: reference.synthetic-vite-development
title: Synthetic Vite development reference
domain: testing
type: reference
systems:
  - dataops
tags:
  - testing
status: active
---

# Synthetic Vite development reference

Public-safe content used only by the isolated browser journey.
`;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function listen(port = 0) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function freePort() {
  const server = await listen();
  const port = server.address().port;
  await closeServer(server);
  return port;
}

async function freePortPair() {
  const frontendPort = await freePort();
  let backendPort = await freePort();
  while (backendPort === frontendPort) backendPort = await freePort();
  return { frontendPort, backendPort };
}

async function waitFor(predicate, message, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await delay(75);
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}

async function portIsFree(port) {
  try {
    const server = await listen(port);
    await closeServer(server);
    return true;
  } catch {
    return false;
  }
}

function createSyntheticRoots(testInfo) {
  const scratchParent = path.join(ROOT, '.tmp');
  fs.mkdirSync(scratchParent, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(scratchParent, `issue-165-e2e-${testInfo.workerIndex}-`));
  const frontendRoot = path.join(scratch, 'frontend');
  const cacheRoot = path.join(scratch, 'cache');
  const stateRoot = path.join(scratch, 'state');
  const uploadRoot = path.join(scratch, 'uploads');
  fs.mkdirSync(path.join(cacheRoot, 'content', 'testing'), { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.mkdirSync(uploadRoot, { recursive: true });
  for (const relative of FRONTEND_ASSETS) {
    fs.mkdirSync(path.dirname(path.join(frontendRoot, relative)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'frontend', relative), path.join(frontendRoot, relative));
  }
  fs.writeFileSync(path.join(cacheRoot, 'content', 'testing', 'synthetic-vite-development.md'), SYNTHETIC_DOC);
  return { scratch, frontendRoot, cacheRoot, stateRoot, uploadRoot };
}

function startStack(testInfo, overrides = {}) {
  const ports = overrides.ports;
  const roots = createSyntheticRoots(testInfo);
  const child = spawn(process.execPath, ['scripts/dev-portal.mjs'], {
    cwd: ROOT,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATAOPS_DEV_FRONTEND_PORT: String(ports.frontendPort),
      DATAOPS_DEV_BACKEND_PORT: String(ports.backendPort),
      DATAOPS_DEV_FRONTEND_ROOT: roots.frontendRoot,
      DATAOPS_DEV_STATE_ROOT: roots.stateRoot,
      DTC_CACHE_ROOT: roots.cacheRoot,
      UPLOAD_DIR: roots.uploadRoot,
      DATAOPS_EXPORT_ARCHIVE_LOCAL_DIR: path.join(roots.stateRoot, 'exports'),
      ...overrides.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const stack = {
    child,
    exited,
    ports,
    roots,
    origin: `http://localhost:${ports.frontendPort}`,
    stdout: () => stdout,
    stderr: () => stderr,
  };
  OWNED_STACKS.add(stack);
  return stack;
}

async function waitForStack(stack) {
  await waitFor(
    () => stack.stdout().includes(`[dataops-dev] open ${stack.origin}`),
    `development stack did not become ready\nstdout:\n${stack.stdout()}\nstderr:\n${stack.stderr()}`,
  );
}

async function stopStack(stack) {
  if (!OWNED_STACKS.has(stack)) return;
  if (stack.child.exitCode === null && stack.child.signalCode === null) {
    try {
      if (process.platform === 'win32') stack.child.kill('SIGTERM');
      else process.kill(-stack.child.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  const stopped = await Promise.race([stack.exited.then(() => true), delay(10_000).then(() => false)]);
  if (!stopped) {
    try {
      if (process.platform === 'win32') stack.child.kill('SIGKILL');
      else process.kill(-stack.child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    await Promise.race([stack.exited, delay(2_000)]);
  }
  await waitFor(
    async () => (await Promise.all([
      portIsFree(stack.ports.frontendPort),
      portIsFree(stack.ports.backendPort),
    ])).every(Boolean),
    `owned listeners survived on ${stack.ports.frontendPort}/${stack.ports.backendPort}`,
    10_000,
  );
  OWNED_STACKS.delete(stack);
  fs.rmSync(stack.roots.scratch, { recursive: true, force: true });
}

function listenerPid(port) {
  const output = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim();
  const pids = output.split(/\s+/).filter(Boolean).map(Number);
  if (pids.length !== 1) throw new Error(`expected one listener on ${port}, got ${output || 'none'}`);
  return pids[0];
}

function observeBrowserTraffic(page, stack) {
  const urls = [];
  page.on('request', (request) => urls.push(request.url()));
  return {
    assertLocalOnly() {
      for (const raw of urls) {
        const url = new URL(raw);
        expect(['http:', 'ws:']).toContain(url.protocol);
        expect(['localhost', '127.0.0.1', '[::1]']).toContain(url.hostname);
        expect(url.port).not.toBe(String(stack.ports.backendPort));
      }
    },
  };
}

async function browserJson(page, pathName, options = {}) {
  return page.evaluate(async ({ pathName: requestPath, options: requestOptions }) => {
    const response = await fetch(requestPath, requestOptions);
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('json') ? await response.json() : await response.text();
    return { status: response.status, contentType, body };
  }, { pathName, options });
}

async function startDynalite(port) {
  const server = dynalite({ createTableMs: 0 });
  await new Promise((resolve, reject) => server.listen(port, '127.0.0.1', (error) => (error ? reject(error) : resolve())));
  return server;
}

function representativeClient(port) {
  return DynamoDBDocumentClient.from(new DynamoDBClient({
    endpoint: `http://127.0.0.1:${port}`,
    region: 'us-east-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  }));
}

async function createRepresentativeTaskTable(client) {
  await client.send(new CreateTableCommand({
    TableName: 'Tasks',
    KeySchema: [
      { AttributeName: 'PK', KeyType: 'HASH' },
      { AttributeName: 'SK', KeyType: 'RANGE' },
    ],
    AttributeDefinitions: [
      { AttributeName: 'PK', AttributeType: 'S' },
      { AttributeName: 'SK', AttributeType: 'S' },
      { AttributeName: 'date', AttributeType: 'S' },
      { AttributeName: 'status', AttributeType: 'S' },
      { AttributeName: 'cardId', AttributeType: 'S' },
    ],
    GlobalSecondaryIndexes: [
      { IndexName: 'GSI-Date', KeySchema: [{ AttributeName: 'date', KeyType: 'HASH' }, { AttributeName: 'status', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } },
      { IndexName: 'GSI-Card', KeySchema: [{ AttributeName: 'cardId', KeyType: 'HASH' }, { AttributeName: 'date', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } },
      { IndexName: 'GSI-Status', KeySchema: [{ AttributeName: 'status', KeyType: 'HASH' }, { AttributeName: 'date', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  }));
}

test.afterAll(async () => {
  await Promise.all(Array.from(OWNED_STACKS).map((stack) => stopStack(stack)));
});

test('Vite HMR and real backend proxy preserve one localhost browser origin', async ({ browser }, testInfo) => {
  test.setTimeout(150_000);
  const ports = await freePortPair();
  const stack = startStack(testInfo, { ports });
  let context;
  try {
    await waitForStack(stack);
    console.log(`[issue-165] normal mode ports: frontend=${ports.frontendPort} backend=${ports.backendPort}`);
    context = await browser.newContext();
    const page = await context.newPage();
    const traffic = observeBrowserTraffic(page, stack);
    let loadCount = 0;
    page.on('load', () => { loadCount += 1; });

    await page.goto(`${stack.origin}/`, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(`${stack.origin}/#/`);
    await expect(page.locator('body')).toBeVisible();

    const canonicalRoute = `${stack.origin}/#/tasks?date=2026-08-12`;
    await page.goto(canonicalRoute, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(canonicalRoute);
    await expect(page.locator('body')).toBeVisible();
    const backendPidBeforeFrontendEdits = listenerPid(ports.backendPort);
    const loadCountBeforeCss = loadCount;

    fs.appendFileSync(
      path.join(stack.roots.frontendRoot, 'src', 'styles.css'),
      '\nbody { --issue-165-css-hmr: 165; }\n',
    );
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--issue-165-css-hmr').trim())).toBe('165');
    expect(loadCount).toBe(loadCountBeforeCss);
    expect(listenerPid(ports.backendPort)).toBe(backendPidBeforeFrontendEdits);

    const loadCountBeforeHtml = loadCount;
    fs.appendFileSync(
      path.join(stack.roots.frontendRoot, 'index.html'),
      '\n<!-- issue-165 automatic reload -->\n',
    );
    await expect.poll(() => loadCount).toBeGreaterThan(loadCountBeforeHtml);
    await expect(page).toHaveURL(canonicalRoute);
    expect(listenerPid(ports.backendPort)).toBe(backendPidBeforeFrontendEdits);

    const login = await browserJson(page, '/work/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alexey@datatalks.club', password: '111' }),
    });
    expect(login.status).toBe(200);
    expect(login.contentType).toContain('application/json');
    expect(login.body.user.name).toBe('Alexey');
    expect(login.body.token).toBeTruthy();
    const authorization = { Authorization: `Bearer ${login.body.token}` };

    const me = await browserJson(page, '/work/api/me', { headers: authorization });
    expect(me.status).toBe(200);
    expect(me.body.user.name).toBe('Alexey');

    const created = await browserJson(page, '/work/api/tasks', {
      method: 'POST',
      headers: { ...authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'Synthetic proxy task', date: '2026-08-12' }),
    });
    expect(created.status).toBe(201);
    const tasks = await browserJson(page, '/work/api/tasks?date=2026-08-12', { headers: authorization });
    expect(tasks.status).toBe(200);
    expect(tasks.body.tasks.some((task) => task.id === created.body.id)).toBe(true);
    const workflows = await browserJson(page, '/work/api/cards', { headers: authorization });
    expect(workflows.status).toBe(200);
    expect(Array.isArray(workflows.body.cards)).toBe(true);

    const docs = await browserJson(page, '/docs');
    expect(docs.status).toBe(200);
    expect(Array.isArray(docs.body.documents)).toBe(true);
    const search = await browserJson(page, '/search?q=synthetic');
    expect(search.status).toBe(200);
    const gitStatus = await browserJson(page, '/git/status');
    expect(gitStatus.status).toBe(200);
    const content = await browserJson(page, '/content/testing/synthetic-vite-development.md');
    expect(content.status).toBe(200);
    expect(content.contentType).toContain('text/markdown');
    expect(content.body).toContain('Public-safe content');

    const unauthorized = await browserJson(page, '/work/api/me');
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.contentType).toContain('application/json');
    const missingApi = await browserJson(page, '/work/api/not-a-real-route', { headers: authorization });
    expect(missingApi.status).toBe(404);
    expect(missingApi.contentType).toContain('application/json');
    expect(JSON.stringify(missingApi.body)).not.toContain('<!doctype html>');

    const fileBytes = [0, 1, 2, 127, 128, 254, 255];
    const upload = await page.evaluate(async ({ taskId, token, bytes }) => {
      const form = new FormData();
      form.append('taskId', taskId);
      form.append('category', 'document');
      form.append('file', new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }), 'synthetic.bin');
      const response = await fetch('/work/api/files', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      return { status: response.status, body: await response.json() };
    }, { taskId: created.body.id, token: login.body.token, bytes: fileBytes });
    expect(upload.status).toBe(201);
    const download = await page.evaluate(async ({ fileId, token }) => {
      const response = await fetch(`/work/api/files/${fileId}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return {
        status: response.status,
        contentType: response.headers.get('content-type'),
        disposition: response.headers.get('content-disposition'),
        bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
      };
    }, { fileId: upload.body.file.id, token: login.body.token });
    expect(download.status).toBe(200);
    expect(download.contentType).toContain('application/octet-stream');
    expect(download.disposition).toContain('synthetic.bin');
    expect(download.bytes).toEqual(fileBytes);

    const logout = await fetch(`${stack.origin}/logout`, { redirect: 'manual' });
    expect(logout.status).toBe(302);
    expect(logout.headers.get('location')).toBe('/');
    expect(logout.headers.get('set-cookie')).toContain('dataops_session=');
    expect(logout.headers.get('set-cookie')).toContain('HttpOnly');
    expect(logout.headers.get('set-cookie')).not.toContain(String(ports.backendPort));

    for (const pathname of ['/unknown.js', '/src/unknown.js', '/assets/legacy.js', '/frontend/app.js', '/pages/old', '/public/old', '/static/old', '/ui/old']) {
      const response = await fetch(`${stack.origin}${pathname}`, { redirect: 'manual' });
      expect(response.status, pathname).toBe(404);
      expect(response.headers.get('content-type'), pathname).toContain('application/json');
    }
    for (const pathname of ['/another-deep-link', '/testing/synthetic-vite-development.md']) {
      const response = await fetch(`${stack.origin}${pathname}`);
      expect(response.status, pathname).toBe(200);
      expect(response.headers.get('content-type'), pathname).toContain('text/html');
      expect(await response.text(), pathname).toContain('/@vite/client');
    }

    traffic.assertLocalOnly();

    const backendPidBeforeRestart = listenerPid(ports.backendPort);
    const backendEntry = path.join(ROOT, 'backend', 'scripts', 'dev-server.ts');
    const restartTime = new Date(Date.now() + 1000);
    fs.utimesSync(backendEntry, restartTime, restartTime);
    await expect.poll(() => {
      try { return listenerPid(ports.backendPort); } catch { return 0; }
    }, { timeout: 30_000 }).not.toBe(backendPidBeforeRestart);
    await expect.poll(async () => {
      try { return (await fetch(`${stack.origin}/work/health`)).status; } catch { return 0; }
    }, { timeout: 30_000 }).toBe(200);
    await expect(page).toHaveURL(canonicalRoute);
  } finally {
    if (context) await context.close();
    await stopStack(stack);
  }
});

test('representative mode mutates and restores only an isolated loopback Dynalite fixture', async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const ports = await freePortPair();
  const dynamoPort = await freePort();
  const dynamo = await startDynalite(dynamoPort);
  const client = representativeClient(dynamoPort);
  const originalDescription = 'Synthetic representative task';
  const changedDescription = 'Synthetic representative task updated locally';
  const taskId = 'synthetic-representative-task';
  await createRepresentativeTaskTable(client);
  await client.send(new PutCommand({
    TableName: 'Tasks',
    Item: {
      PK: `TASK#${taskId}`,
      SK: `TASK#${taskId}`,
      id: taskId,
      description: originalDescription,
      date: '2026-08-12',
      status: 'todo',
      cardId: 'synthetic-card',
      source: 'import',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
    },
  }));

  const stack = startStack(testInfo, {
    ports,
    env: {
      DYNAMODB_ENDPOINT: `http://127.0.0.1:${dynamoPort}`,
      AWS_ACCESS_KEY_ID: 'local',
      AWS_SECRET_ACCESS_KEY: 'local',
      IS_LOCAL: 'true',
      DATAOPS_DEV_SEED_MODE: 'none',
      GITHUB_TOKEN: 'synthetic-value-that-must-be-removed',
      AUTH_BASE_URL: 'https://auth.invalid.example',
    },
  });
  let context;
  try {
    await waitForStack(stack);
    console.log(`[issue-165] representative mode ports: frontend=${ports.frontendPort} backend=${ports.backendPort} dynamodb=${dynamoPort}`);
    expect(stack.stdout()).toContain('local representative replica');
    expect(stack.stdout()).toContain('Seed mode none; existing local tables are unchanged.');
    expect(stack.stdout()).not.toContain('Seed data initialized.');

    context = await browser.newContext();
    const page = await context.newPage();
    const traffic = observeBrowserTraffic(page, stack);
    const canonicalRoute = `${stack.origin}/#/tasks?date=2026-08-12`;
    await page.goto(canonicalRoute, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#dataops-local-mode-banner')).toHaveCount(0);

    const copiedSessionCannotAuthenticate = await browserJson(page, '/work/api/me', {
      headers: { Authorization: 'Bearer synthetic-copied-session' },
    });
    expect(copiedSessionCannotAuthenticate.status).toBe(401);

    const before = await browserJson(page, `/work/api/tasks/${taskId}`);
    expect(before.status).toBe(200);
    expect(before.body.description).toBe(originalDescription);
    const changed = await browserJson(page, `/work/api/tasks/${taskId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: changedDescription }),
    });
    expect(changed.status).toBe(200);
    expect(changed.body.description).toBe(changedDescription);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(canonicalRoute);
    const afterReload = await browserJson(page, `/work/api/tasks/${taskId}`);
    expect(afterReload.status).toBe(200);
    expect(afterReload.body.description).toBe(changedDescription);
    const localRecord = await client.send(new GetCommand({
      TableName: 'Tasks',
      Key: { PK: `TASK#${taskId}`, SK: `TASK#${taskId}` },
    }));
    expect(localRecord.Item.description).toBe(changedDescription);

    const restored = await browserJson(page, `/work/api/tasks/${taskId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: originalDescription }),
    });
    expect(restored.status).toBe(200);
    const restoredLocalRecord = await client.send(new GetCommand({
      TableName: 'Tasks',
      Key: { PK: `TASK#${taskId}`, SK: `TASK#${taskId}` },
    }));
    expect(restoredLocalRecord.Item.description).toBe(originalDescription);
    traffic.assertLocalOnly();
  } finally {
    if (context) await context.close();
    await stopStack(stack);
    client.destroy();
    await closeServer(dynamo);
  }
});
