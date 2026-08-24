import { spawn } from 'node:child_process';
import { mkdirSync, lstatSync, writeFileSync } from 'node:fs';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const backendRoot = join(repoRoot, 'backend');

function isInsideDirectory(root, target) {
  const relativePath = relative(resolve(root), resolve(target));
  return relativePath === '' || (!relativePath.startsWith('..') && !relativePath.startsWith('/'));
}

function requireRegularFile(path, description) {
  let entry;
  try {
    entry = lstatSync(path);
  } catch {
    throw new Error(`${description} is missing: ${path}`);
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(`${description} must be a regular file: ${path}`);
  }
  return path;
}

export function resolveTargetHandlerPath({ mode, moduleRoot }) {
  if (mode !== 'source' && mode !== 'sam') {
    throw new Error(`Unknown frontend parity target mode: ${String(mode)}`);
  }
  const relativePath = mode === 'source' ? 'src/handler.ts' : 'dist/handler.js';
  const absolutePath = resolve(moduleRoot, relativePath);
  try {
    requireRegularFile(absolutePath, `${mode.toUpperCase()} parity handler`);
  } catch (error) {
    throw new Error(`${error.message} (expected ${relativePath}; no alternate handler is permitted)`);
  }
  return absolutePath;
}

export function repositoryFixtureSupportPath() {
  return requireRegularFile(
    join(backendRoot, 'scripts', 'frontend-parity-support.ts'),
    'Repository-owned parity fixture support',
  );
}

export function resolveParityModulePaths({ mode, moduleRoot }) {
  return {
    handler: resolveTargetHandlerPath({ mode, moduleRoot }),
    fixtureSupport: repositoryFixtureSupportPath(),
  };
}

export function assertSamResolution({ moduleRoot, importer, resolved }) {
  if (!isInsideDirectory(moduleRoot, importer)) return;
  if (Module.isBuiltin(resolved)) return;
  const absolute = resolve(resolved);
  if (isInsideDirectory(moduleRoot, absolute)) return;
  throw new Error(
    `Isolated SAM parity target attempted outside module resolution: `
    + `${absolute} imported by ${importer} (artifact boundary ${moduleRoot})`,
  );
}

export function installSamResolutionGuard(moduleRoot) {
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function guardedResolve(request, parent, isMain, options) {
    const result = originalResolve.call(this, request, parent, isMain, options);
    if (typeof result === 'string') {
      assertSamResolution({
        moduleRoot,
        importer: parent?.filename || '',
        resolved: result,
      });
    }
    return result;
  };
  return originalResolve;
}

export function createDocsCache(cacheRoot) {
  mkdirSync(join(cacheRoot, 'content', 'synthetic'), { recursive: true });
  writeFileSync(join(cacheRoot, 'content', 'synthetic', 'parity.md'), `---
id: sop.synthetic.parity
aliases: []
title: Synthetic parity process
summary: Public-safe local fixture for canonical frontend behavior evidence.
doc_type: sop
schema_version: 1
systems:
  - synthetic-system
tags:
  - synthetic
---

# Synthetic parity process

<!-- sop-section-start: summary -->
## Summary
Public-safe local fixture for canonical frontend behavior evidence.
<!-- sop-section-end -->

<!-- sop-section-start: prerequisites -->
## Prerequisites
Use synthetic records only.
<!-- sop-section-end -->

<!-- sop-section-start: procedure -->
## Procedure
<!-- sop-step-start id=1 systems="synthetic-system" -->
1. Verify synthetic proof.
Record a synthetic completion note and confirm the local result.
<!-- sop-step-end -->
<!-- sop-section-end -->

<!-- sop-section-start: validation -->
## Validation
The local result is visible.
<!-- sop-section-end -->

<!-- sop-section-start: troubleshooting -->
## Troubleshooting
Retry the local request.
<!-- sop-section-end -->

<!-- sop-section-start: references -->
## References
None.
<!-- sop-section-end -->
`);
  return cacheRoot;
}

export async function startThrowawayDynalite() {
  const require = createRequire(join(backendRoot, 'package.json'));
  const dynalite = require('dynalite')({ createTableMs: 0 });
  await new Promise((resolveListen, rejectListen) => {
    dynalite.listen(0, '127.0.0.1', (error) => error ? rejectListen(error) : resolveListen());
  });
  const address = dynalite.address();
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolveClose) => dynalite.close(() => resolveClose()));
    },
  };
}

export function createLocalSchema(endpoint) {
  return new Promise((resolveSetup, rejectSetup) => {
    const setup = spawn(process.execPath, ['--import', 'tsx', '--eval', [
      "Promise.all([import('./backend/scripts/local-dynamodb.ts'), import('./backend/src/db/client.ts')])",
      '.then(async ([local, client]) => local.createTables(await client.getClient()))',
    ].join(' ')], {
      cwd: repoRoot,
      env: { ...process.env, DYNAMODB_ENDPOINT: endpoint },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    setup.stderr.setEncoding('utf8');
    setup.stderr.on('data', (chunk) => { stderr += chunk; });
    setup.once('error', rejectSetup);
    setup.once('exit', (status) => {
      if (status === 0) resolveSetup();
      else rejectSetup(new Error(`Local schema setup failed:\n${stderr}`));
    });
  });
}

async function waitForReadyChild(child, mode) {
  const timeout = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  }, 30_000);
  timeout.unref();
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolveReady, rejectReady) => {
    let pending = '';
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      for (const line of lines) {
        try {
          const payload = JSON.parse(line);
          if (payload.ready === true && payload.mode === mode) {
            clearTimeout(timeout);
            resolveReady(payload);
            return;
          }
        } catch {}
      }
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectReady(new Error(`Parity target failed to start: ${error.message}\n${stdout}\n${stderr}`));
    });
    child.once('exit', (status, signal) => {
      clearTimeout(timeout);
      rejectReady(new Error(
        `Parity target exited before readiness (status=${status ?? 'none'}, signal=${signal ?? 'none'})\n${stdout}\n${stderr}`,
      ));
    });
  });
}

export async function launchParityTarget({ mode, root, cacheRoot }) {
  const database = await startThrowawayDynalite();
  try {
    await createLocalSchema(database.endpoint);
    const cache = createDocsCache(cacheRoot);
    const child = spawn(process.execPath, [
      '--import', 'tsx',
      join(backendRoot, 'scripts', 'frontend-parity-target.mjs'),
      '--mode', mode,
      '--root', root,
      '--port', '0',
      '--dynamo', database.endpoint,
      '--cache', cache,
    ], {
      cwd: repoRoot,
      env: { ...process.env, NODE_PATH: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const ready = await waitForReadyChild(child, mode);
    return {
      baseURL: `http://127.0.0.1:${ready.port}`,
      mode,
      port: ready.port,
      async close() {
        const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
        await Promise.race([
          exited,
          new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
        ]);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await database.close();
      },
    };
  } catch (error) {
    await database.close();
    throw error;
  }
}
