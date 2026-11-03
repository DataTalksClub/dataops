#!/usr/bin/env node
// Start the local dev portal with production data: ensure the local dynalite
// instance, copy prod DynamoDB tables into it (never secrets), then run the
// normal dev stack against that copy.
//
// Usage: npm run dev:prod
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DYNALITE_PORT = 8000;
const DYNALITE_HOST = '127.0.0.1';
const DYNAMODB_ENDPOINT = `http://${DYNALITE_HOST}:${DYNALITE_PORT}`;

function portOpen(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    socket.once('connect', () => { socket.end(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

async function waitForPort(host, port, label, timeoutMs = 30000) {
  const started = Date.now();
  for (;;) {
    if (await portOpen(host, port)) return;
    if (Date.now() - started > timeoutMs) throw new Error(`${label} did not open in time`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function ensureDynalite() {
  if (await portOpen(DYNALITE_HOST, DYNALITE_PORT)) {
    console.log(`[dev:prod] reusing dynalite on ${DYNAMODB_ENDPOINT}`);
    return null;
  }
  console.log(`[dev:prod] starting dynalite on ${DYNAMODB_ENDPOINT}`);
  const child = spawn('node_modules/.bin/dynalite', ['--port', String(DYNALITE_PORT), '--path', 'backend/.data'], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
  await waitForPort(DYNALITE_HOST, DYNALITE_PORT, 'dynalite');
  return child;
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`${command} killed by ${signal}`));
      else if (code !== 0) reject(new Error(`${command} exited with ${code}`));
      else resolve();
    });
  });
}

let dynalite = null;
async function shutdown() {
  if (dynalite && !dynalite.killed) dynalite.kill('SIGTERM');
}
process.once('SIGINT', () => void shutdown().finally(() => process.exit(130)));
process.once('SIGTERM', () => void shutdown().finally(() => process.exit(143)));

try {
  dynalite = await ensureDynalite();
  console.log('[dev:prod] copying prod DynamoDB tables to local (secrets excluded)');
  await run('npx', ['tsx', 'backend/scripts/sync-prod-to-local.ts'], { ...process.env });
  console.log('[dev:prod] starting dev portal against the local copy');
  await run('npm', ['run', 'dev'], {
    ...process.env,
    DYNAMODB_ENDPOINT,
    AWS_ACCESS_KEY_ID: 'local-dev',
    AWS_SECRET_ACCESS_KEY: 'local-dev',
    IS_LOCAL: 'true',
    DATAOPS_DEV_SEED_MODE: 'none',
  });
} catch (error) {
  console.error(`[dev:prod] ${(error instanceof Error ? error.message : error)}`);
  process.exitCode = 1;
} finally {
  await shutdown();
}
