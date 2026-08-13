import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), '..', '..');
const cacheRoot = join(repoRoot, '.tmp', 'sam-build-cache');
const manifestName = '.dataops-sam-bundle.json';
const lockTimeoutMs = 20 * 60 * 1000;
const staleLockGraceMs = 10_000;
const shutdownGraceMs = 2_000;
const buildFormatVersion = 'dataops-sam-esbuild-v2-isolated-install';
const esbuildTarget = 'node24';
const samCacheEnv = 'DATAOPS_SAM_CACHE_ROOT';

export const handlerEntries = Object.freeze({
  handler: 'backend/src/handler.ts',
  'execution-worker-handler': 'backend/src/execution-worker-handler.ts',
  'result-notification-handler': 'backend/src/result-notification-handler.ts',
  'sponsor-send-worker-handler': 'backend/src/sponsor-send-worker-handler.ts',
  'sponsor-ses-event-handler': 'backend/src/sponsor-ses-event-handler.ts',
  'sponsor-private-archive-handler': 'backend/src/sponsor-private-archive-handler.ts',
});

const inputDirectories = ['backend/src', 'backend/vendor', 'frontend'];
const inputFiles = [
  'Makefile',
  'package.json',
  'package-lock.json',
  'backend/package.json',
  'backend/tsconfig.json',
  'cli/package.json',
  'backend/scripts/build-sam-artifact.mjs',
  'backend/scripts/copy-frontend-artifact.mjs',
  'backend/scripts/frontend-assets.mjs',
  'backend/scripts/verify-frontend-artifact.mjs',
  'backend/scripts/verify-runtime-boundary.mjs',
  'infra/sam-build/Makefile',
];

function normalizedPath(path) {
  return path.split(sep).join('/');
}

function walkFiles(root, path) {
  const absolute = join(root, path);
  const entry = lstatSync(absolute);
  if (entry.isSymbolicLink()) throw new Error(`SAM build input must not be a symlink: ${path}`);
  if (entry.isFile()) return [normalizedPath(path)];
  if (!entry.isDirectory()) throw new Error(`Unsupported SAM build input: ${path}`);
  return readdirSync(absolute, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((child) => walkFiles(root, join(path, child.name)));
}

export function buildInputPaths(root = repoRoot) {
  return [...inputFiles, ...inputDirectories.flatMap((path) => walkFiles(root, path))]
    .map(normalizedPath)
    .sort();
}

export function computeFingerprint(root = repoRoot) {
  const hash = createHash('sha256');
  hash.update(`${buildFormatVersion}\0${process.platform}\0${process.arch}\0${process.version}\0${esbuildTarget}\0`);
  for (const path of buildInputPaths(root)) {
    hash.update(path);
    hash.update('\0');
    hash.update(readFileSync(join(root, path)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function artifactInventory(artifactRoot) {
  return walkFiles(artifactRoot, '.')
    .filter((path) => path !== manifestName)
    .map((path) => {
      const cleanPath = path.startsWith('./') ? path.slice(2) : path;
      const absolute = join(artifactRoot, cleanPath);
      return { path: cleanPath, bytes: statSync(absolute).size, sha256: sha256(absolute) };
    });
}

export function readValidManifest(artifactRoot) {
  const manifestPath = join(artifactRoot, manifestName);
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (
      manifest.schemaVersion !== 1
      || manifest.format !== 'dataops-sam-esbuild'
      || manifest.buildFormatVersion !== buildFormatVersion
      || manifest.target !== esbuildTarget
    ) return null;
    if (!Array.isArray(manifest.files) || !Array.isArray(manifest.inputs)) return null;
    const declaredPaths = new Set();
    for (const file of manifest.files) {
      if (!file || typeof file.path !== 'string' || declaredPaths.has(file.path)) return null;
      declaredPaths.add(file.path);
      const absolute = resolve(artifactRoot, file.path);
      if (!absolute.startsWith(`${resolve(artifactRoot)}${sep}`) || !existsSync(absolute)) return null;
      const stats = statSync(absolute);
      if (!stats.isFile() || stats.size !== file.bytes || sha256(absolute) !== file.sha256) return null;
    }
    const currentFiles = artifactInventory(artifactRoot);
    if (currentFiles.length !== manifest.files.length) return null;
    const currentByPath = new Map(currentFiles.map((file) => [file.path, file]));
    for (const file of manifest.files) {
      const current = currentByPath.get(file.path);
      if (!current || current.bytes !== file.bytes || current.sha256 !== file.sha256) return null;
    }
    return manifest;
  } catch {
    return null;
  }
}

function existingValidCache(artifactCache, expectedFingerprint) {
  const manifest = readValidManifest(artifactCache);
  return manifest?.fingerprint === expectedFingerprint ? manifest : null;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function assertNoSymlinkTraversal(path, label) {
  const resolvedPath = resolve(path);
  const { root } = parse(resolvedPath);
  let current = root;
  for (const part of relative(root, resolvedPath).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`Refusing ${label} through symbolic link: ${current}`);
      }
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }
  return resolvedPath;
}

function assertOwnedDescendant(boundary, target, label) {
  const resolvedBoundary = resolve(boundary);
  const resolvedTarget = resolve(target);
  if (resolvedTarget === resolvedBoundary || !resolvedTarget.startsWith(`${resolvedBoundary}${sep}`)) {
    throw new Error(`Refusing unsafe ${label}: ${resolvedTarget}`);
  }
  assertNoSymlinkTraversal(resolvedBoundary, `${label} boundary`);
  assertNoSymlinkTraversal(resolvedTarget, label);
  return resolvedTarget;
}

function removeOwnedPath(boundary, target, label) {
  const ownedTarget = assertOwnedDescendant(boundary, target, label);
  rmSync(ownedTarget, { recursive: true, force: true });
}

function readLockOwner(lockPath) {
  try {
    const owner = JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8'));
    if (
      !Number.isInteger(owner.pid)
      || typeof owner.createdAt !== 'number'
      || typeof owner.token !== 'string'
      || owner.token.length < 16
    ) return null;
    return owner;
  } catch {
    return null;
  }
}

function lockIdentity(lockPath) {
  const stats = lstatSync(lockPath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`SAM build lock must be a real directory: ${lockPath}`);
  }
  return { dev: stats.dev, ino: stats.ino, owner: readLockOwner(lockPath) };
}

export function reclaimStaleLock(lockPath, inspected, options = {}) {
  if (options.beforeIdentityCheck) options.beforeIdentityCheck();
  let current;
  try {
    current = lockIdentity(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (current.dev !== inspected.dev || current.ino !== inspected.ino) return false;
  if ((current.owner?.token || null) !== (inspected.owner?.token || null)) return false;
  const tombstone = `${lockPath}.reclaim-${process.pid}-${randomUUID()}`;
  assertOwnedDescendant(dirname(lockPath), tombstone, 'stale SAM build lock tombstone');
  try {
    renameSync(lockPath, tombstone);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  const moved = lockIdentity(tombstone);
  if (moved.dev !== inspected.dev || moved.ino !== inspected.ino) {
    throw new Error(`Reclaimed SAM build lock identity changed unexpectedly: ${lockPath}`);
  }
  removeOwnedPath(dirname(lockPath), tombstone, 'stale SAM build lock tombstone');
  return true;
}

export async function acquireLock(lockPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? lockTimeoutMs;
  const staleAfterMs = options.staleAfterMs ?? staleLockGraceMs;
  const pollMs = options.pollMs ?? 100;
  const isAlive = options.processIsAlive ?? processIsAlive;
  const now = options.now ?? Date.now;
  const startedAt = now();
  assertOwnedDescendant(dirname(lockPath), lockPath, 'SAM build lock');
  let lastOwner = 'unreadable';
  while (true) {
    throwIfCancelled();
    try {
      mkdirSync(lockPath);
      const identity = lstatSync(lockPath);
      const owner = { pid: process.pid, createdAt: now(), token: randomUUID() };
      writeFileSync(join(lockPath, 'owner.json'), `${JSON.stringify(owner)}\n`);
      return { ...owner, dev: identity.dev, ino: identity.ino };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }

    const inspected = lockIdentity(lockPath);
    const owner = inspected.owner;
    try {
      const age = owner ? now() - owner.createdAt : now() - statSync(lockPath).mtimeMs;
      lastOwner = owner ? `pid=${owner.pid} ageMs=${Math.max(0, Math.round(age))}` : 'unreadable';
      if (age > staleAfterMs && (!owner || !isAlive(owner.pid))) {
        reclaimStaleLock(lockPath, inspected, options);
        continue;
      }
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }

    if (now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for SAM build lock ${lockPath}; owner ${lastOwner}`);
    }
    await delay(pollMs);
  }
}

export function releaseLock(lockPath, acquired) {
  try {
    const identity = lstatSync(lockPath);
    if (identity.dev !== acquired.dev || identity.ino !== acquired.ino) return false;
    const currentOwner = readLockOwner(lockPath);
    if (currentOwner && currentOwner.token !== acquired.token) return false;
    removeOwnedPath(dirname(lockPath), lockPath, 'SAM build lock');
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

export async function ensureCachedArtifact({ artifactCache, build, lockOptions, expectedFingerprint = basename(artifactCache) }) {
  assertNoSymlinkTraversal(dirname(artifactCache), 'SAM artifact cache boundary');
  assertOwnedDescendant(dirname(artifactCache), artifactCache, 'SAM artifact cache');
  if (existingValidCache(artifactCache, expectedFingerprint)) return { cache: artifactCache, built: false };
  const lockPath = `${artifactCache}.lock`;
  const artifactBoundary = dirname(artifactCache);
  mkdirSync(artifactBoundary, { recursive: true });
  const acquired = await acquireLock(lockPath, lockOptions);
  let temporary;
  try {
    if (existingValidCache(artifactCache, expectedFingerprint)) return { cache: artifactCache, built: false };
    removeOwnedPath(artifactBoundary, artifactCache, 'SAM artifact cache');
    temporary = `${artifactCache}.building-${process.pid}-${Date.now()}-${randomUUID()}`;
    removeOwnedPath(artifactBoundary, temporary, 'SAM artifact attempt');
    mkdirSync(temporary, { recursive: true });
    await build(temporary);
    if (!existingValidCache(temporary, expectedFingerprint)) {
      throw new Error('Shared SAM build did not produce a valid manifest for the requested fingerprint');
    }
    renameSync(temporary, artifactCache);
    temporary = undefined;
    return { cache: artifactCache, built: true };
  } finally {
    if (temporary) removeOwnedPath(artifactBoundary, temporary, 'SAM artifact attempt');
    releaseLock(lockPath, acquired);
  }
}

const activeCommands = new Set();
let cancellationSignal = null;
let cancellationEscalation = null;

function signalCommandGroup(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

export function requestCancellation(signal) {
  if (cancellationSignal) return;
  cancellationSignal = signal;
  for (const child of activeCommands) signalCommandGroup(child, signal);
  cancellationEscalation = setTimeout(() => {
    for (const child of activeCommands) signalCommandGroup(child, 'SIGKILL');
  }, shutdownGraceMs);
  cancellationEscalation.unref();
}

function throwIfCancelled() {
  if (!cancellationSignal) return;
  const error = new Error(`SAM build cancelled by ${cancellationSignal}`);
  error.exitCode = cancellationSignal === 'SIGINT' ? 130 : 143;
  throw error;
}

export async function runOwnedCommand(command, args, options = {}) {
  throwIfCancelled();
  const phase = options.phase || command;
  const child = spawn(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    detached: process.platform !== 'win32',
    stdio: 'inherit',
  });
  activeCommands.add(child);
  if (options.onSpawn) options.onSpawn(child);
  if (cancellationSignal) signalCommandGroup(child, cancellationSignal);
  const result = await new Promise((resolveCommand, rejectCommand) => {
    child.once('error', rejectCommand);
    child.once('close', (status, signal) => resolveCommand({ status, signal }));
  }).finally(() => activeCommands.delete(child));
  throwIfCancelled();
  if (result.status !== 0) {
    const detail = result.signal ? `signal ${result.signal}` : `status ${result.status ?? 1}`;
    throw new Error(`SAM build phase ${phase} failed with ${detail}`);
  }
}

export function resetCancellationForTest() {
  if (activeCommands.size > 0) throw new Error('Cannot reset SAM cancellation while commands are active');
  clearTimeout(cancellationEscalation);
  cancellationEscalation = null;
  cancellationSignal = null;
}

export function copyIsolatedBuildWorkspace(sourceRoot, workspaceRoot) {
  mkdirSync(workspaceRoot, { recursive: true });
  for (const path of buildInputPaths(sourceRoot)) {
    const source = join(sourceRoot, path);
    const target = join(workspaceRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { force: false, preserveTimestamps: true });
  }
}

export function workspaceRequire(workspaceRoot, specifier) {
  const require = createRequire(join(workspaceRoot, 'backend', 'package.json'));
  const modulePath = require.resolve(specifier);
  const resolvedWorkspace = resolve(workspaceRoot);
  const resolvedModule = resolve(modulePath);
  if (!resolvedModule.startsWith(`${resolvedWorkspace}${sep}`)) {
    throw new Error(`Isolated SAM dependency escaped the build workspace: ${specifier} -> ${resolvedModule}`);
  }
  return require(specifier);
}

function phaseMessage(fingerprint, phase) {
  console.log(`[sam-shared] fingerprint=${fingerprint.slice(0, 12)} phase=${phase}`);
}

async function buildSharedArtifact(destination, fingerprint) {
  console.log(`[sam-shared] building ${fingerprint.slice(0, 12)} once for all Lambda functions`);
  const workspaceBoundary = dirname(destination);
  const workspace = `${destination}.workspace`;
  removeOwnedPath(workspaceBoundary, workspace, 'SAM isolated build workspace');
  mkdirSync(workspace, { recursive: true });
  try {
    phaseMessage(fingerprint, 'workspace-copy-start');
    copyIsolatedBuildWorkspace(repoRoot, workspace);
    phaseMessage(fingerprint, 'workspace-copy-complete');
    const copiedFingerprint = computeFingerprint(workspace);
    if (copiedFingerprint !== fingerprint) {
      throw new Error(`Isolated SAM workspace fingerprint mismatch: expected ${fingerprint}, copied ${copiedFingerprint}`);
    }
    throwIfCancelled();

    const copiedLockHash = sha256(join(workspace, 'package-lock.json'));
    phaseMessage(fingerprint, 'install-start');
    await runOwnedCommand('npm', ['ci', '--workspace', 'dataops-backend', '--no-audit', '--no-fund'], {
      cwd: workspace,
      phase: 'isolated dependency install',
      env: { ...process.env, NODE_PATH: '' },
      onSpawn: () => phaseMessage(fingerprint, 'install-running'),
    });
    phaseMessage(fingerprint, 'install-complete');
    if (sha256(join(workspace, 'package-lock.json')) !== copiedLockHash) {
      throw new Error('Isolated npm ci changed package-lock.json');
    }
    throwIfCancelled();

    phaseMessage(fingerprint, 'compile-start');
    await runOwnedCommand(join(workspace, 'node_modules', '.bin', 'tsc'), ['--project', 'backend/tsconfig.json'], {
      cwd: workspace,
      phase: 'isolated TypeScript build',
      env: { ...process.env, NODE_PATH: '' },
    });
    phaseMessage(fingerprint, 'compile-complete');
    throwIfCancelled();

    const { build } = workspaceRequire(workspace, 'esbuild');
    const dist = join(destination, 'dist');
    mkdirSync(dist, { recursive: true });
    phaseMessage(fingerprint, 'bundle-start');
    const result = await build({
      absWorkingDir: workspace,
      bundle: true,
      entryPoints: handlerEntries,
      format: 'cjs',
      logLevel: 'info',
      metafile: true,
      outdir: dist,
      platform: 'node',
      target: esbuildTarget,
    });
    phaseMessage(fingerprint, 'bundle-complete');
    throwIfCancelled();

    await runOwnedCommand(process.execPath, ['backend/scripts/copy-frontend-artifact.mjs', '--source', 'frontend', '--artifact', dist], {
      cwd: workspace,
      phase: 'canonical frontend copy',
      env: { ...process.env, NODE_PATH: '' },
    });
    await runOwnedCommand(process.execPath, ['backend/scripts/verify-frontend-artifact.mjs', '--source', 'frontend', '--artifact', destination], {
      cwd: workspace,
      phase: 'canonical frontend verification',
      env: { ...process.env, NODE_PATH: '' },
    });

    const finalWorkspaceFingerprint = computeFingerprint(workspace);
    if (finalWorkspaceFingerprint !== fingerprint) {
      throw new Error(`Isolated SAM workspace inputs changed during build: expected ${fingerprint}, found ${finalWorkspaceFingerprint}`);
    }
    const finalSourceFingerprint = computeFingerprint(repoRoot);
    if (finalSourceFingerprint !== fingerprint) {
      throw new Error(`SAM build inputs changed while the isolated artifact was being built: expected ${fingerprint}, found ${finalSourceFingerprint}`);
    }
    const bundledOutputs = Object.keys(handlerEntries).map((name) => `dist/${name}.js`).sort();
    const manifest = {
      schemaVersion: 1,
      format: 'dataops-sam-esbuild',
      fingerprint,
      buildFormatVersion,
      target: esbuildTarget,
      bundledOutputs,
      inputs: Object.keys(result.metafile.inputs).map(normalizedPath).sort(),
      files: [],
    };
    writeFileSync(join(destination, manifestName), `${JSON.stringify(manifest, null, 2)}\n`);
    manifest.files = artifactInventory(destination);
    writeFileSync(join(destination, manifestName), `${JSON.stringify(manifest, null, 2)}\n`);
    await runOwnedCommand(process.execPath, ['backend/scripts/verify-runtime-boundary.mjs', destination], {
      cwd: workspace,
      phase: 'runtime infrastructure boundary verification',
      env: { ...process.env, NODE_PATH: '' },
    });
    phaseMessage(fingerprint, 'artifact-verified');
  } finally {
    removeOwnedPath(workspaceBoundary, workspace, 'SAM isolated build workspace');
  }
}

function emptyDirectory(directory, allowedBoundary) {
  const resolved = resolve(directory);
  if (resolved === repoRoot || resolved === dirname(repoRoot) || resolved === resolve('/')) {
    throw new Error(`Refusing unsafe SAM artifact directory: ${resolved}`);
  }
  if (!allowedBoundary) throw new Error('SAM artifact directory requires an explicit owned boundary');
  assertOwnedDescendant(allowedBoundary, resolved, 'SAM artifact directory');
  mkdirSync(resolved, { recursive: true });
  for (const entry of readdirSync(resolved)) {
    removeOwnedPath(resolved, join(resolved, entry), 'SAM artifact entry');
  }
  return resolved;
}

export function copyIsolatedArtifact(source, destination, options = {}) {
  assertNoSymlinkTraversal(source, 'shared SAM artifact source');
  if (!readValidManifest(source)) throw new Error(`Cannot copy invalid shared SAM artifact: ${source}`);
  const target = emptyDirectory(destination, options.allowedBoundary);
  for (const entry of readdirSync(source)) cpSync(join(source, entry), join(target, entry), { recursive: true });
  if (!readValidManifest(target)) throw new Error(`Copied SAM artifact failed integrity verification: ${target}`);
}

async function main() {
  const artifactsDir = process.env.ARTIFACTS_DIR || process.argv[2];
  if (!artifactsDir) throw new Error('ARTIFACTS_DIR is required');
  const fingerprint = computeFingerprint();
  const configuredCacheRoot = resolve(process.env[samCacheEnv] || cacheRoot);
  assertOwnedDescendant(join(repoRoot, '.tmp'), configuredCacheRoot, samCacheEnv);
  const artifactCache = join(configuredCacheRoot, fingerprint);
  const result = await ensureCachedArtifact({
    artifactCache,
    build: (destination) => buildSharedArtifact(destination, fingerprint),
  });
  console.log(`[sam-shared] ${result.built ? 'built' : 'reusing'} ${fingerprint.slice(0, 12)} for ${basename(artifactsDir)}`);
  const resolvedArtifacts = resolve(artifactsDir);
  const artifactBoundary = [join(repoRoot, '.aws-sam'), join(repoRoot, '.tmp')]
    .find((boundary) => resolvedArtifacts.startsWith(`${resolve(boundary)}${sep}`));
  if (!artifactBoundary) throw new Error(`Refusing SAM artifact directory outside .aws-sam or .tmp: ${resolvedArtifacts}`);
  copyIsolatedArtifact(result.cache, resolvedArtifacts, { allowedBoundary: artifactBoundary });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => requestCancellation(signal));
  }
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = error?.exitCode || 1;
  });
}
