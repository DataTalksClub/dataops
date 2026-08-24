import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildChildEnvironment,
  classifyBrowserPath,
  FORBIDDEN_BROWSER_NAMESPACES,
  isProxyPath,
  loadLocalDevEnvironment,
  parsePort,
  probePort,
  PROXY_FAMILIES,
  readDevConfig,
  rewriteInternalLocation,
  validateDynamoEndpoint,
} from './dev-portal-lib.mjs';
import { __testing as supervisorTesting } from './dev-portal.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND_ASSETS = JSON.parse(readFileSync(
  path.join(ROOT, 'backend', 'src', 'docs', 'frontend-assets.json'),
  'utf8',
)).files;
const SCRATCH_PARENT = path.join(ROOT, '.tmp');
let scratchRoot;
let fixturePath;

before(() => {
  mkdirSync(SCRATCH_PARENT, { recursive: true });
  scratchRoot = mkdtempSync(path.join(SCRATCH_PARENT, 'issue-165-unit-'));
  fixturePath = path.join(scratchRoot, 'child-fixture.mjs');
  writeFileSync(fixturePath, `
import http from 'node:http';
import { appendFileSync } from 'node:fs';
const [role, rawPort] = process.argv.slice(2);
const port = Number(rawPort);
const mode = process.env.DATAOPS_DEV_TEST_FIXTURE_MODE || 'normal';
appendFileSync(process.env.DATAOPS_DEV_TEST_MARKER, role + ':' + process.pid + '\\n');
if (mode === 'backend-exit' && role === 'backend') {
  process.stdout.write('[fixture] synthetic startup stdout\\n');
  process.stderr.write('[fixture] synthetic startup stderr\\n');
  process.exit(23);
}
const server = http.createServer((_request, response) => response.end(role));
server.listen(port, '127.0.0.1', () => {
  process.stdout.write('[fixture] ' + role + ' ready\\n');
  if (mode === 'exit-after-ready' && role === 'backend') {
    setTimeout(() => server.close(() => process.exit(0)), 250);
  }
});
if (mode === 'ignore-term') {
  process.on('SIGTERM', () => process.stdout.write('[fixture] ignoring SIGTERM\\n'));
} else {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
`);
});

after(() => {
  if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
});

function listen(port = 0) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function freePort() {
  const server = await listen();
  const { port } = server.address();
  await close(server);
  return port;
}

async function freePortPair() {
  const frontendPort = await freePort();
  let backendPort = await freePort();
  while (backendPort === frontendPort) backendPort = await freePort();
  return { frontendPort, backendPort };
}

function isolatedSupervisorEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('DATAOPS_') || key.startsWith('DTC_') || key.startsWith('AWS_')) {
      delete env[key];
    }
  }
  for (const key of [
    'DYNAMODB_ENDPOINT',
    'IS_LOCAL',
    'UPLOAD_DIR',
  ]) delete env[key];
  return env;
}

function startSupervisor({ frontendPort, backendPort, mode = 'normal', suffix }) {
  const marker = path.join(scratchRoot, `${suffix}.marker`);
  const stateRoot = path.join(scratchRoot, `${suffix}-state`);
  const child = spawn(process.execPath, ['scripts/dev-portal.mjs'], {
    cwd: ROOT,
    env: {
      ...isolatedSupervisorEnvironment(),
      NODE_ENV: 'test',
      DATAOPS_DEV_FRONTEND_PORT: String(frontendPort),
      DATAOPS_DEV_BACKEND_PORT: String(backendPort),
      DATAOPS_DEV_STATE_ROOT: stateRoot,
      DTC_CACHE_ROOT: path.join(stateRoot, 'cache'),
      DATAOPS_DEV_TEST_CHILD_SCRIPT: fixturePath,
      DATAOPS_DEV_TEST_FIXTURE_MODE: mode,
      DATAOPS_DEV_TEST_MARKER: marker,
      DATAOPS_DEV_TEST_READINESS_TIMEOUT_MS: '4000',
      DATAOPS_DEV_TEST_SHUTDOWN_GRACE_MS: '150',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, exited, marker, stdout: () => stdout, stderr: () => stderr };
}

async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(message);
}

async function exitWithin(run, timeoutMs = 5000) {
  return Promise.race([
    run.exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('supervisor did not exit')), timeoutMs)),
  ]);
}

async function assertPortsFree(...ports) {
  await waitFor(
    async () => (await Promise.all(ports.map((port) => probePort('127.0.0.1', port)))).every(Boolean),
    `owned listeners survived on ${ports.join(', ')}`,
  );
}

function fixturePids(marker) {
  try {
    return readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).map((line) => Number(line.split(':')[1]));
  } catch {
    return [];
  }
}

async function assertPidsGone(pids) {
  await waitFor(() => pids.every((pid) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error.code === 'ESRCH';
    }
  }), `owned child process survived: ${pids.join(', ')}`);
}

test('validates default and override port configuration', () => {
  const defaults = readDevConfig({}, ROOT);
  assert.equal(defaults.frontendPort, 3000);
  assert.equal(defaults.backendPort, 3001);
  assert.equal(defaults.frontendUrl, 'http://localhost:3000');
  assert.equal(defaults.backendUrl, 'http://127.0.0.1:3001');
  assert.equal(parsePort('49152', 'TEST_PORT', 1), 49152);
  assert.throws(() => parsePort('3e3', 'TEST_PORT', 1), /numeric TCP port/);
  assert.throws(() => parsePort('0', 'TEST_PORT', 1), /between 1 and 65535/);
  assert.throws(
    () => readDevConfig({ DATAOPS_DEV_FRONTEND_PORT: '41000', DATAOPS_DEV_BACKEND_PORT: '41000' }, ROOT),
    /must be distinct/,
  );
});

test('resolves development child CLIs through installed package manifests', () => {
  const [backend, vite] = supervisorTesting.productionChildSpecs(ROOT);

  assert.equal(backend.command, process.execPath);
  assert.equal(backend.args[1], 'watch');
  assert.equal(backend.args[2], 'backend/scripts/dev-server.ts');
  assert.match(backend.args[0], /node_modules[\\/]tsx[\\/]dist[\\/]cli\.mjs$/);
  assert.doesNotMatch(backend.args[0], /[\\/]\.bin[\\/]/);

  assert.equal(vite.command, process.execPath);
  assert.equal(vite.args[0].endsWith(path.join('vite', 'bin', 'vite.js')), true);
  assert.equal(vite.args[1], '--config');
  assert.equal(vite.args[2], path.join(ROOT, 'vite.config.mjs'));
});

test('loads only the local docs cache setting from the ignored env file', () => {
  const envRoot = path.join(scratchRoot, 'local-env');
  mkdirSync(envRoot, { recursive: true });
  writeFileSync(
    path.join(envRoot, '.env'),
    [
      'DTC_CACHE_ROOT=/home/alexey/git/dataops-knowledge',
      'GITHUB_TOKEN=must-stay-out-of-child-environment',
      '',
    ].join('\n'),
  );

  const loaded = loadLocalDevEnvironment({ PARENT_SETTING: 'kept' }, envRoot);
  assert.equal(loaded.DTC_CACHE_ROOT, '/home/alexey/git/dataops-knowledge');
  assert.equal(loaded.PARENT_SETTING, 'kept');
  assert.equal(loaded.GITHUB_TOKEN, undefined);
  assert.equal(
    loadLocalDevEnvironment({ DTC_CACHE_ROOT: '/explicit/cache' }, envRoot).DTC_CACHE_ROOT,
    '/explicit/cache',
  );
});

test('accepts only loopback DynamoDB with explicit local credentials', () => {
  const local = { AWS_ACCESS_KEY_ID: 'local', AWS_SECRET_ACCESS_KEY: 'local' };
  assert.equal(validateDynamoEndpoint('http://127.0.0.1:4567', local).port, '4567');
  assert.equal(validateDynamoEndpoint('http://[::1]:4567', local).hostname, '[::1]');
  assert.throws(() => validateDynamoEndpoint('https://127.0.0.1:4567', local), /http: loopback/);
  assert.throws(() => validateDynamoEndpoint('http://example.test:4567', local), /http: loopback/);
  assert.throws(() => validateDynamoEndpoint('http://127.0.0.1:4567', {}), /explicit local/);
  assert.throws(
    () => validateDynamoEndpoint('http://127.0.0.1:4567', { AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_SECRET_ACCESS_KEY: 'local' }),
    /look like live AWS credentials/,
  );
  assert.throws(
    () => readDevConfig({ DATAOPS_DEV_SEED_MODE: 'none' }, ROOT),
    /requires DYNAMODB_ENDPOINT/,
  );
  assert.throws(
    () => readDevConfig({
      DYNAMODB_ENDPOINT: 'http://127.0.0.1:4567',
      AWS_ACCESS_KEY_ID: 'local',
      AWS_SECRET_ACCESS_KEY: 'local',
      DATAOPS_DEV_SEED_MODE: 'none',
    }, ROOT),
    /requires IS_LOCAL=true/,
  );
  assert.throws(
    () => readDevConfig({
      DYNAMODB_ENDPOINT: 'http://127.0.0.1:4567',
      AWS_ACCESS_KEY_ID: 'local',
      AWS_SECRET_ACCESS_KEY: 'local',
      IS_LOCAL: 'true',
    }, ROOT),
    /requires DATAOPS_DEV_SEED_MODE=none/,
  );
});

test('matches every proxy family exactly without prefix collisions', () => {
  for (const family of PROXY_FAMILIES) {
    assert.equal(isProxyPath(family), true, family);
    assert.equal(isProxyPath(`${family}/child`), true, `${family}/child`);
    assert.equal(isProxyPath(`${family}-lookalike`), false, `${family}-lookalike`);
  }
  assert.equal(isProxyPath('/@vite/client'), false);
  assert.equal(isProxyPath('/'), false);
});

test('classifies deep links, canonical assets, and fail-closed static paths', () => {
  for (const pathname of ['/', ...FRONTEND_ASSETS.map((asset) => `/${asset}`)]) {
    assert.equal(classifyBrowserPath(pathname), 'frontend', pathname);
  }
  for (const pathname of ['/tasks', '/workflows/current', '/content/process/example.md']) {
    const expected = pathname.startsWith('/content/') ? 'proxy' : 'app-shell';
    assert.equal(classifyBrowserPath(pathname), expected, pathname);
  }
  assert.equal(classifyBrowserPath('/process/example.md'), 'app-shell');
  for (const namespace of FORBIDDEN_BROWSER_NAMESPACES) {
    assert.equal(classifyBrowserPath(`/${namespace}/anything`), 'not-found', namespace);
  }
  for (const pathname of ['/src/unknown.js', '/unknown.js', '/favicon.ico', '/tasks', '/docs-ish']) {
    const expected = pathname === '/tasks' || pathname === '/docs-ish' ? 'app-shell' : 'not-found';
    assert.equal(classifyBrowserPath(pathname), expected, pathname);
  }
  assert.equal(classifyBrowserPath('/tasks', 'POST'), 'not-found');
});

test('accepts a newly manifested module without restarting the development server', () => {
  const modulePath = 'src/surfaces/new-checkpoint.js';
  assert.equal(classifyBrowserPath(`/${modulePath}`), 'not-found');
  assert.equal(
    classifyBrowserPath(`/${modulePath}`, 'GET', [...FRONTEND_ASSETS, modulePath]),
    'frontend',
  );
});

test('representative child environment is visibly labeled and fail-closed', () => {
  const parentEnv = {
    DYNAMODB_ENDPOINT: 'http://127.0.0.1:4567',
    AWS_ACCESS_KEY_ID: 'local',
    AWS_SECRET_ACCESS_KEY: 'local',
    DATAOPS_DEV_SEED_MODE: 'none',
    IS_LOCAL: 'true',
    DATAOPS_DEV_ACTOR_EMAIL: 'operator@example.invalid',
    GITHUB_TOKEN: 'must-not-survive',
    AUTH_BASE_URL: 'https://auth.example.test',
    SPONSOR_COMMUNICATION_SEND_ENABLED: 'true',
    CONVERSATIONAL_EXECUTION_ENABLED: 'true',
  };
  const config = readDevConfig(parentEnv, ROOT);
  const child = buildChildEnvironment(config, parentEnv);
  assert.equal(config.representative, true);
  assert.equal(config.actorEmail, 'operator@example.invalid');
  assert.equal(child.DATAOPS_LOCAL_MODE_LABEL, 'local representative replica');
  assert.equal(child.DATAOPS_DEV_SEED_MODE, 'none');
  assert.equal(child.DATAOPS_AUTO_CREATE_TABLES, 'false');
  assert.equal(child.WORK_ENGINE_AUTH_MODE, 'portal');
  assert.equal(child.CONVERSATIONAL_EXECUTION_ENABLED, 'false');
  assert.equal(child.SPONSOR_COMMUNICATION_SEND_ENABLED, 'false');
  assert.equal(child.DATAOPS_FILE_STORAGE_PROVIDER, 'local-dev');
  assert.equal(child.AWS_EC2_METADATA_DISABLED, 'true');
  assert.equal(child.GITHUB_TOKEN, undefined);
  assert.equal(child.AUTH_BASE_URL, undefined);
  assert.throws(
    () => readDevConfig({ DATAOPS_DEV_ACTOR_EMAIL: 'operator@example.invalid' }, ROOT),
    /requires a local representative replica/,
  );
  assert.throws(
    () => readDevConfig({ ...parentEnv, DATAOPS_DEV_ACTOR_EMAIL: 'not-an-email' }, ROOT),
    /must be a single email address/,
  );
});

test('rewrites only internal backend redirects to the browser origin', () => {
  const config = readDevConfig({}, ROOT);
  assert.equal(rewriteInternalLocation('http://127.0.0.1:3001/tasks?x=1#row', config), '/tasks?x=1#row');
  assert.equal(rewriteInternalLocation('http://localhost:3001/logout', config), '/logout');
  assert.equal(rewriteInternalLocation('/relative', config), '/relative');
  assert.equal(rewriteInternalLocation('https://identity.example.test/login', config), 'https://identity.example.test/login');
});

test('keeps Vite development-only and out of backend runtime dependencies', () => {
  const rootPackage = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const backendPackage = JSON.parse(readFileSync(path.join(ROOT, 'backend/package.json'), 'utf8'));
  const dockerfile = readFileSync(path.join(ROOT, 'backend/Dockerfile.lambda'), 'utf8');
  const lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.match(rootPackage.devDependencies.vite, /^\^?6\./);
  assert.equal(rootPackage.dependencies?.vite, undefined);
  assert.equal(backendPackage.dependencies?.vite, undefined);
  assert.equal(backendPackage.devDependencies?.vite, undefined);
  assert.match(lock.packages[''].devDependencies.vite, /^\^?6\./);
  assert.match(dockerfile, /npm ci --omit=dev --workspace dataops-backend/);
  assert.doesNotMatch(dockerfile, /vite/i);
});

test('occupied frontend port starts no child process', async () => {
  const occupied = await listen();
  const frontendPort = occupied.address().port;
  const backendPort = await freePort();
  const run = startSupervisor({ frontendPort, backendPort, suffix: 'occupied-frontend' });
  const exit = await exitWithin(run);
  await close(occupied);
  assert.equal(exit.code, 1);
  assert.match(run.stderr(), new RegExp(`Port ${frontendPort} is occupied`));
  assert.deepEqual(fixturePids(run.marker), []);
  await assertPortsFree(frontendPort, backendPort);
});

test('occupied backend port starts no child process', async () => {
  const frontendPort = await freePort();
  const occupied = await listen();
  const backendPort = occupied.address().port;
  const run = startSupervisor({ frontendPort, backendPort, suffix: 'occupied-backend' });
  const exit = await exitWithin(run);
  await close(occupied);
  assert.equal(exit.code, 1);
  assert.match(run.stderr(), new RegExp(`Port ${backendPort} is occupied`));
  assert.deepEqual(fixturePids(run.marker), []);
  await assertPortsFree(frontendPort, backendPort);
});

test('early child failure stops and reaps the sibling', async () => {
  const { frontendPort, backendPort } = await freePortPair();
  const run = startSupervisor({ frontendPort, backendPort, mode: 'backend-exit', suffix: 'early-exit' });
  const exit = await exitWithin(run);
  const pids = fixturePids(run.marker);
  assert.equal(exit.code, 23);
  assert.match(run.stderr(), /backend stopped unexpectedly/);
  assert.match(run.stderr(), new RegExp(`frontend=http://localhost:${frontendPort}`));
  assert.match(run.stderr(), new RegExp(`backend=http://127\\.0\\.0\\.1:${backendPort}`));
  assert.match(run.stderr(), /backend exit 23/);
  assert.match(run.stderr(), /final stdout:[\s\S]*synthetic startup stdout/);
  assert.match(run.stderr(), /final stderr:[\s\S]*synthetic startup stderr/);
  assert.ok(pids.length >= 1);
  await assertPortsFree(frontendPort, backendPort);
  await assertPidsGone(pids);
});

test('readiness timeout reports ports and the final child output', async () => {
  const { frontendPort, backendPort } = await freePortPair();
  const config = {
    host: '127.0.0.1',
    frontendPort,
    backendPort,
    frontendUrl: `http://localhost:${frontendPort}`,
    backendUrl: `http://127.0.0.1:${backendPort}`,
  };
  const children = [
    {
      name: 'backend',
      child: { exitCode: null, signalCode: null },
      stdout: 'backend still starting',
      stderr: 'backend diagnostic',
    },
    {
      name: 'vite',
      child: { exitCode: null, signalCode: null },
      stdout: 'vite still starting',
      stderr: '',
    },
  ];

  await assert.rejects(
    () => supervisorTesting.waitForStack(config, children, 0),
    (error) => {
      assert.match(error.message, new RegExp(`frontend=http://localhost:${frontendPort}`));
      assert.match(error.message, new RegExp(`backend=http://127\\.0\\.0\\.1:${backendPort}`));
      assert.match(error.message, /backend still running/);
      assert.match(error.message, /final stdout:\nbackend still starting/);
      assert.match(error.message, /final stderr:\nbackend diagnostic/);
      assert.match(error.message, /vite still running/);
      return true;
    },
  );
});

test('SIGTERM cleans up both listeners and all owned child processes', async () => {
  const { frontendPort, backendPort } = await freePortPair();
  const run = startSupervisor({ frontendPort, backendPort, suffix: 'signal' });
  await waitFor(() => run.stdout().includes(`open http://localhost:${frontendPort}`), 'stack did not become ready');
  const pids = fixturePids(run.marker);
  assert.equal(pids.length, 2);
  run.child.kill('SIGTERM');
  const exit = await exitWithin(run);
  assert.equal(exit.code, 143);
  assert.match(run.stderr(), /received SIGTERM/);
  await assertPortsFree(frontendPort, backendPort);
  await assertPidsGone(pids);
});

test('bounded shutdown escalates to SIGKILL for stubborn children', async () => {
  const { frontendPort, backendPort } = await freePortPair();
  const run = startSupervisor({ frontendPort, backendPort, mode: 'ignore-term', suffix: 'stubborn' });
  await waitFor(() => run.stdout().includes(`open http://localhost:${frontendPort}`), 'stack did not become ready');
  const pids = fixturePids(run.marker);
  const started = Date.now();
  run.child.kill('SIGTERM');
  const exit = await exitWithin(run);
  assert.equal(exit.code, 143);
  assert.ok(Date.now() - started < 3000, 'bounded escalation took too long');
  await assertPortsFree(frontendPort, backendPort);
  await assertPidsGone(pids);
});

test('normal child exit tears down the remaining stack', async () => {
  const { frontendPort, backendPort } = await freePortPair();
  const run = startSupervisor({ frontendPort, backendPort, mode: 'exit-after-ready', suffix: 'normal-exit' });
  const exit = await exitWithin(run);
  const pids = fixturePids(run.marker);
  assert.equal(exit.code, 1);
  assert.match(run.stderr(), /backend stopped unexpectedly \(exit 0\)/);
  await assertPortsFree(frontendPort, backendPort);
  await assertPidsGone(pids);
});
