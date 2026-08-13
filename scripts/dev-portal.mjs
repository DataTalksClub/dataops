#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertPortsAvailable,
  buildChildEnvironment,
  DevPortalConfigError,
  readDevConfig,
} from './dev-portal-lib.mjs';

const modulePath = fileURLToPath(import.meta.url);
const moduleDir = path.dirname(modulePath);
const DEFAULT_READINESS_TIMEOUT_MS = 60_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;
const CHILD_OUTPUT_TAIL_CHARACTERS = 16_384;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function stackAddresses(config) {
  return `frontend=${config.frontendUrl} backend=${config.backendUrl}`;
}

function appendOutputTail(current, chunk) {
  const combined = current + chunk.toString();
  return combined.length > CHILD_OUTPUT_TAIL_CHARACTERS
    ? combined.slice(-CHILD_OUTPUT_TAIL_CHARACTERS)
    : combined;
}

function childDiagnostics(owned) {
  const status = owned.child.signalCode
    ? `signal ${owned.child.signalCode}`
    : owned.child.exitCode === null
      ? 'still running'
      : `exit ${owned.child.exitCode}`;
  return `${owned.name} ${status}`
    + `\nfinal stdout:\n${owned.stdout || '(empty)'}`
    + `\nfinal stderr:\n${owned.stderr || '(empty)'}`;
}

function ensureLocalPaths(config, cwd) {
  mkdirSync(config.stateRoot, { recursive: true });
  mkdirSync(config.cacheRoot, { recursive: true });
  mkdirSync(config.uploadRoot, { recursive: true });
  mkdirSync(config.exportRoot, { recursive: true });
  const cachedContent = path.join(config.cacheRoot, 'content');
  const repositoryContent = path.join(cwd, 'content');
  if (!existsSync(cachedContent) && existsSync(repositoryContent)) {
    symlinkSync(repositoryContent, cachedContent, 'dir');
  }
}

function productionChildSpecs(cwd) {
  return [
    {
      name: 'backend',
      command: path.join(cwd, 'node_modules', '.bin', 'tsx'),
      args: ['watch', 'backend/scripts/dev-server.ts'],
    },
    {
      name: 'vite',
      command: path.join(cwd, 'node_modules', '.bin', 'vite'),
      args: ['--config', path.join(cwd, 'vite.config.mjs')],
    },
  ];
}

function testChildSpecs(env, config) {
  if (env.NODE_ENV !== 'test' || !env.DATAOPS_DEV_TEST_CHILD_SCRIPT) return null;
  const script = path.resolve(env.DATAOPS_DEV_TEST_CHILD_SCRIPT);
  return [
    {
      name: 'backend',
      command: process.execPath,
      args: [script, 'backend', String(config.backendPort)],
    },
    {
      name: 'vite',
      command: process.execPath,
      args: [script, 'vite', String(config.frontendPort)],
    },
  ];
}

function spawnOwnedChild(spec, env, cwd) {
  const child = spawn(spec.command, spec.args, {
    cwd,
    env,
    detached: process.platform !== 'win32',
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  const owned = { ...spec, child, stdout: '', stderr: '' };
  owned.closed = new Promise((resolve) => child.once('close', (code, signal) => {
    resolve({ code, signal });
  }));
  child.stdout.on('data', (chunk) => {
    owned.stdout = appendOutputTail(owned.stdout, chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    owned.stderr = appendOutputTail(owned.stderr, chunk);
    process.stderr.write(chunk);
  });
  child.once('error', (error) => {
    process.stderr.write(`[dataops-dev] ${spec.name} failed to start: ${error.message}\n`);
  });
  return owned;
}

function signalOwnedGroup(owned, signal) {
  if (!owned?.child?.pid) return;
  try {
    if (process.platform === 'win32') owned.child.kill(signal);
    else process.kill(-owned.child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function waitForExit(owned) {
  return owned.closed;
}

async function stopChildren(children, graceMs) {
  for (const owned of children) signalOwnedGroup(owned, 'SIGTERM');
  const exited = Promise.all(children.map(waitForExit));
  const graceful = await Promise.race([
    exited.then(() => true),
    delay(graceMs).then(() => false),
  ]);
  if (!graceful) {
    for (const owned of children) signalOwnedGroup(owned, 'SIGKILL');
    await Promise.race([exited, delay(2_000)]);
  }
  // A watcher can exit before a descendant. Address the owned process group
  // once more so no listener survives under the original group id.
  for (const owned of children) {
    try {
      signalOwnedGroup(owned, 'SIGKILL');
    } catch {
      // Best effort after the child exit event; ESRCH is handled above.
    }
  }
}

async function portAcceptsConnections(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.unref();
    const finish = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(250, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function waitForStack(config, children, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stopped = children.find(({ child }) => child.exitCode !== null || child.signalCode !== null);
    if (stopped) {
      await stopped.closed;
      const detail = stopped.child.signalCode
        ? `signal ${stopped.child.signalCode}`
        : `exit ${stopped.child.exitCode ?? 1}`;
      throw new Error(
        `${stopped.name} stopped before readiness (${detail}); ${stackAddresses(config)}`
        + `\n${childDiagnostics(stopped)}`,
      );
    }
    const [frontendReady, backendReady] = await Promise.all([
      portAcceptsConnections(config.host, config.frontendPort),
      portAcceptsConnections(config.host, config.backendPort),
    ]);
    if (frontendReady && backendReady) return;
    await delay(100);
  }
  throw new Error(
    `Development stack readiness timed out; ${stackAddresses(config)}`
    + `\n${children.map(childDiagnostics).join('\n')}`,
  );
}

export async function runDevPortal(options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const testReadinessTimeout = env.NODE_ENV === 'test'
    ? Number(env.DATAOPS_DEV_TEST_READINESS_TIMEOUT_MS || '')
    : Number.NaN;
  const testShutdownGrace = env.NODE_ENV === 'test'
    ? Number(env.DATAOPS_DEV_TEST_SHUTDOWN_GRACE_MS || '')
    : Number.NaN;
  const readinessTimeoutMs = options.readinessTimeoutMs
    ?? (Number.isFinite(testReadinessTimeout) && testReadinessTimeout > 0
      ? testReadinessTimeout
      : DEFAULT_READINESS_TIMEOUT_MS);
  const shutdownGraceMs = options.shutdownGraceMs
    ?? (Number.isFinite(testShutdownGrace) && testShutdownGrace > 0
      ? testShutdownGrace
      : DEFAULT_SHUTDOWN_GRACE_MS);
  const config = readDevConfig(env, cwd);

  await assertPortsAvailable(config);
  ensureLocalPaths(config, cwd);

  const childEnv = buildChildEnvironment(config, env);
  const specs = options.childSpecs || testChildSpecs(env, config) || productionChildSpecs(cwd);
  const children = [];
  let settled = false;
  let shuttingDown = false;
  let settle;
  const result = new Promise((resolve) => { settle = resolve; });

  const finish = async (exitCode, reason) => {
    if (shuttingDown || settled) return;
    shuttingDown = true;
    if (reason) process.stderr.write(`[dataops-dev] ${reason}\n`);
    await stopChildren(children, shutdownGraceMs);
    settled = true;
    settle(exitCode);
  };

  const signalHandlers = new Map();
  for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const handler = () => { void finish(exitCode, `received ${signal}; stopping development stack`); };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  try {
    for (const spec of specs) {
      const owned = spawnOwnedChild(spec, childEnv, cwd);
      children.push(owned);
      owned.child.once('close', (code, signal) => {
        if (shuttingDown || settled) return;
        const detail = signal ? `signal ${signal}` : `exit ${code ?? 1}`;
        void finish(
          code && code > 0 ? code : 1,
          `${owned.name} stopped unexpectedly (${detail}); ${stackAddresses(config)}`
          + `\n${childDiagnostics(owned)}`,
        );
      });
    }
    await waitForStack(config, children, readinessTimeoutMs);
    if (!shuttingDown) {
      process.stdout.write(`[dataops-dev] ${config.modeLabel}\n`);
      process.stdout.write(`[dataops-dev] open ${config.frontendUrl}\n`);
      process.stdout.write(`[dataops-dev] backend is private on ${config.backendUrl}\n`);
    }
  } catch (error) {
    await finish(1, error instanceof Error ? error.message : String(error));
  }

  try {
    return await result;
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  }
}

async function main() {
  try {
    process.exitCode = await runDevPortal();
  } catch (error) {
    const message = error instanceof DevPortalConfigError || error instanceof Error
      ? error.message
      : String(error);
    process.stderr.write(`[dataops-dev] ${message}\n`);
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] || '') === modulePath) {
  await main();
}

export const __testing = Object.freeze({
  appendOutputTail,
  childDiagnostics,
  ensureLocalPaths,
  portAcceptsConnections,
  stopChildren,
  waitForStack,
});
