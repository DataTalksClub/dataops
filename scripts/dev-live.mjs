#!/usr/bin/env node
// Local portal against LIVE production data (not a copy).
//
// Reads and writes the real prod tables and buckets with your ambient AWS
// credentials. There is no safety net: every click that writes (edits,
// pairings, packages, uploads, sends) hits production exactly as if you used
// ops.dtcdev.click. Use it to try uncommitted UI code against real data.
//
// The dev seed never runs here (SEED_MODE is pinned to none) so nothing can
// overwrite prod with demo data.
//
// Usage: npm run dev:live
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolveDependencyCli(packageName) {
  const requireFromRepository = createRequire(path.join(repoRoot, 'package.json'));
  const manifest = requireFromRepository(`${packageName}/package.json`);
  const cliPath = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[packageName];
  if (!cliPath) throw new Error(`${packageName} does not declare a CLI entry`);
  return path.join(path.dirname(requireFromRepository.resolve(`${packageName}/package.json`)), cliPath);
}

const FRONTEND_PORT = process.env.DATAOPS_DEV_FRONTEND_PORT || '3000';
const BACKEND_PORT = process.env.DATAOPS_DEV_BACKEND_PORT || '3001';

function assertProdShootYourselfInTheFoot() {
  if (process.env.DYNAMODB_ENDPOINT) {
    throw new Error('dev:live talks to prod: unset DYNAMODB_ENDPOINT first');
  }
  for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) {
    if (/^(local|fake|test|dummy|offline|dynalite)/i.test(process.env[key] || '')) {
      throw new Error(`dev:live needs real AWS credentials, but ${key} looks like a local fake`);
    }
  }
}

function waitForPort(host, port, label, timeoutMs = 60000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      const socket = net.connect(port, host);
      socket.once('connect', () => { socket.end(); resolve(); });
      socket.once('error', () => {
        if (Date.now() - started > timeoutMs) reject(new Error(`${label} did not open in time`));
        else setTimeout(probe, 500);
      });
    };
    probe();
  });
}

const children = new Set();
function run(name, command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, env, stdio: 'inherit' });
    children.add(child);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      children.delete(child);
      if (signal) reject(new Error(`${name} killed by ${signal}`));
      else if (code !== 0) reject(new Error(`${name} exited with ${code}`));
      else resolve();
    });
  });
}

async function shutdown() {
  for (const child of [...children]) {
    if (!child.killed) child.kill('SIGTERM');
  }
}
process.once('SIGINT', () => void shutdown().finally(() => process.exit(130)));
process.once('SIGTERM', () => void shutdown().finally(() => process.exit(143)));

try {
  assertProdShootYourselfInTheFoot();
  console.log('');
  console.log('  !!! dev:live — LOCAL CODE AGAINST LIVE PROD DATA !!!');
  console.log('  Reads AND writes go to production (tables dataops-v1-*, prod S3).');
  console.log('  Seeding is disabled; deploys still happen only via git push + CI.');
  console.log('');

  const env = {
    ...process.env,
    PORT: BACKEND_PORT,
    DATAOPS_DEV_BACKEND_HOST: '127.0.0.1',
    DATAOPS_DEV_FRONTEND_PORT: FRONTEND_PORT,
    DATAOPS_DEV_BACKEND_PORT: BACKEND_PORT,
    DATAOPS_DEV_SEED_MODE: 'none',
    WORK_ENGINE_AUTH_MODE: 'portal',
    AWS_REGION: process.env.AWS_REGION || 'eu-west-1',
    BOOKKEEPING_DOCUMENTS_BUCKET: process.env.BOOKKEEPING_DOCUMENTS_BUCKET || 'dataops-v1-bookkeepingdocumentsbucket-k5bud5suzf8k',
    EMAIL_DOCUMENTS_BUCKET: process.env.EMAIL_DOCUMENTS_BUCKET || 'dataops-v1-emaildocumentsbucket-1dbv70hrd4al',
    TASK_FILES_BUCKET: process.env.TASK_FILES_BUCKET || 'dataops-v1-taskfilesbucket-r1aa5zd9bdgg',
    DATAOPS_EXPORT_ARCHIVE_LOCAL_DIR: process.env.DATAOPS_EXPORT_ARCHIVE_LOCAL_DIR || 'dataops-v1-dataopsexportarchivebucket-iqwwwmalyjbl',
    SPONSOR_COMMUNICATION_SEND_ENABLED: process.env.SPONSOR_COMMUNICATION_SEND_ENABLED === 'true' ? 'true' : 'false',
  };
  delete env.DYNAMODB_ENDPOINT;
  delete env.IS_LOCAL;
  delete env.DTC_OFFLINE;
  delete env.DATAOPS_FILE_STORAGE_PROVIDER;

  const node = process.execPath;
  const backend = run('backend',
    node,
    [resolveDependencyCli('tsx'), 'watch', 'backend/scripts/dev-server.ts'],
    env);
  await waitForPort('127.0.0.1', Number(BACKEND_PORT), 'backend');
  const frontend = run('vite',
    node,
    [resolveDependencyCli('vite'), '--config', path.join(repoRoot, 'vite.config.mjs')],
    env);
  await waitForPort('127.0.0.1', Number(FRONTEND_PORT), 'frontend');
  console.log(`dev:live ready: frontend http://localhost:${FRONTEND_PORT}/ backend http://127.0.0.1:${BACKEND_PORT}/`);
  await Promise.all([backend, frontend]);
} catch (error) {
  console.error(`[dev:live] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await shutdown();
}
