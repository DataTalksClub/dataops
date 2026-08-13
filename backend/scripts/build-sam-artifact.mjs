import { createHash } from 'node:crypto';
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
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), '..', '..');
const cacheRoot = join(repoRoot, '.tmp', 'sam-build-cache');
const manifestName = '.dataops-sam-bundle.json';
const lockTimeoutMs = 20 * 60 * 1000;

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
  hash.update(`dataops-sam-esbuild-v1\0${process.platform}\0${process.arch}\0${process.version}\0`);
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
    if (manifest.schemaVersion !== 1 || manifest.format !== 'dataops-sam-esbuild') return null;
    if (!Array.isArray(manifest.files) || !Array.isArray(manifest.inputs)) return null;
    for (const file of manifest.files) {
      const absolute = resolve(artifactRoot, file.path);
      if (!absolute.startsWith(`${resolve(artifactRoot)}${sep}`) || !existsSync(absolute)) return null;
      const stats = statSync(absolute);
      if (!stats.isFile() || stats.size !== file.bytes || sha256(absolute) !== file.sha256) return null;
    }
    return manifest;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function acquireLock(lockPath) {
  const startedAt = Date.now();
  while (true) {
    try {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, 'owner.json'), `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`);
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }

    const ownerPath = join(lockPath, 'owner.json');
    try {
      const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
      if (!processIsAlive(owner.pid) && Date.now() - owner.createdAt > 1000) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
    } catch {
      const age = Date.now() - statSync(lockPath).mtimeMs;
      if (age > lockTimeoutMs) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
    }

    if (Date.now() - startedAt > lockTimeoutMs) throw new Error(`Timed out waiting for SAM build lock: ${lockPath}`);
    await delay(100);
  }
}

export async function ensureCachedArtifact({ artifactCache, build }) {
  if (readValidManifest(artifactCache)) return { cache: artifactCache, built: false };
  const lockPath = `${artifactCache}.lock`;
  mkdirSync(dirname(artifactCache), { recursive: true });
  await acquireLock(lockPath);
  let temporary;
  try {
    if (readValidManifest(artifactCache)) return { cache: artifactCache, built: false };
    rmSync(artifactCache, { recursive: true, force: true });
    temporary = `${artifactCache}.building-${process.pid}-${Date.now()}`;
    rmSync(temporary, { recursive: true, force: true });
    mkdirSync(temporary, { recursive: true });
    await build(temporary);
    if (!readValidManifest(temporary)) throw new Error('Shared SAM build did not produce a valid manifest');
    renameSync(temporary, artifactCache);
    temporary = undefined;
    return { cache: artifactCache, built: true };
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8', stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`);
}

async function buildSharedArtifact(destination, fingerprint) {
  console.log(`[sam-shared] building ${fingerprint.slice(0, 12)} once for all Lambda functions`);
  run('npm', ['ci']);
  run('npm', ['run', 'build:backend']);

  const { build } = await import('esbuild');
  const dist = join(destination, 'dist');
  mkdirSync(dist, { recursive: true });
  const result = await build({
    absWorkingDir: repoRoot,
    bundle: true,
    entryPoints: handlerEntries,
    format: 'cjs',
    logLevel: 'info',
    metafile: true,
    outdir: dist,
    platform: 'node',
    target: 'node24',
  });

  run('node', ['backend/scripts/copy-frontend-artifact.mjs', '--source', 'frontend', '--artifact', dist]);
  run('node', ['backend/scripts/verify-frontend-artifact.mjs', '--source', 'frontend', '--artifact', destination]);

  const bundledOutputs = Object.keys(handlerEntries).map((name) => `dist/${name}.js`).sort();
  const manifest = {
    schemaVersion: 1,
    format: 'dataops-sam-esbuild',
    fingerprint,
    bundledOutputs,
    inputs: Object.keys(result.metafile.inputs).map(normalizedPath).sort(),
    files: [],
  };
  writeFileSync(join(destination, manifestName), `${JSON.stringify(manifest, null, 2)}\n`);
  manifest.files = artifactInventory(destination);
  writeFileSync(join(destination, manifestName), `${JSON.stringify(manifest, null, 2)}\n`);
  run('node', ['backend/scripts/verify-runtime-boundary.mjs', destination]);
}

function emptyDirectory(directory) {
  const resolved = resolve(directory);
  if (resolved === repoRoot || resolved === dirname(repoRoot) || resolved === resolve('/')) {
    throw new Error(`Refusing unsafe SAM artifact directory: ${resolved}`);
  }
  mkdirSync(resolved, { recursive: true });
  for (const entry of readdirSync(resolved)) rmSync(join(resolved, entry), { recursive: true, force: true });
  return resolved;
}

export function copyIsolatedArtifact(source, destination) {
  if (!readValidManifest(source)) throw new Error(`Cannot copy invalid shared SAM artifact: ${source}`);
  const target = emptyDirectory(destination);
  for (const entry of readdirSync(source)) cpSync(join(source, entry), join(target, entry), { recursive: true });
  if (!readValidManifest(target)) throw new Error(`Copied SAM artifact failed integrity verification: ${target}`);
}

async function main() {
  const artifactsDir = process.env.ARTIFACTS_DIR || process.argv[2];
  if (!artifactsDir) throw new Error('ARTIFACTS_DIR is required');
  const fingerprint = computeFingerprint();
  const artifactCache = join(cacheRoot, fingerprint);
  const result = await ensureCachedArtifact({
    artifactCache,
    build: (destination) => buildSharedArtifact(destination, fingerprint),
  });
  console.log(`[sam-shared] ${result.built ? 'built' : 'reusing'} ${fingerprint.slice(0, 12)} for ${basename(artifactsDir)}`);
  copyIsolatedArtifact(result.cache, artifactsDir);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
