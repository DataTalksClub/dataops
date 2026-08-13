#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const testRoot = join(repoRoot, '.tmp', 'issue-185', `concurrency-${process.pid}-${randomUUID()}`);
const cacheRoot = join(testRoot, 'cache');
const artifactRoot = join(testRoot, 'artifact');
const importProbe = [
  "require('tsx')",
  "require('esbuild')",
  "require('js-yaml')",
  "process.stdout.write('imports-ok')",
].join(';');
const requiredOverlapPhases = new Set(['install', 'compile', 'bundle']);
const functionArtifacts = [
  'BackendFunction',
  'ConversationalExecutionWorkerFunction',
  'ConversationalResultDispatcherFunction',
  'SponsorSendWorkerFunction',
  'SponsorSesEventFunction',
  'SponsorPrivateArchiveFunction',
];
const childTailLimit = 32_768;
let child = null;
let stdout = '';
let stderr = '';
let stopping = false;
const seenPhases = new Set();
const phaseCounts = new Map();
const overlapByPhase = new Map([...requiredOverlapPhases].map((phase) => [phase, 0]));
let activePhase = null;
let activePhaseGeneration = 0;
let pendingProbe = null;
const controlLineCarry = { stdout: '', stderr: '' };
const activeImportProbes = new Set();

function appendTail(current, chunk) {
  const combined = current + chunk.toString();
  return combined.length > childTailLimit ? combined.slice(-childTailLimit) : combined;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function fileInventory(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) return fileInventory(root, absolute);
      assert.equal(entry.isFile(), true, `SAM artifact entry is not a file: ${absolute}`);
      return [{ path: absolute.slice(root.length + 1), bytes: statSync(absolute).size, sha256: sha256(absolute) }];
    });
}

function collectControlLines(chunk, channel) {
  const lines = `${controlLineCarry[channel]}${chunk}`.split('\n');
  controlLineCarry[channel] = lines.pop() || '';
  for (const line of lines) {
    const match = line.match(/\[sam-shared\].* phase=([a-z-]+)/);
    if (!match) continue;
    seenPhases.add(match[1]);
    phaseCounts.set(match[1], (phaseCounts.get(match[1]) || 0) + 1);
    if (match[1] === 'install-running') {
      activePhase = 'install';
      activePhaseGeneration += 1;
      if (pendingProbe === null) pendingProbe = runFreshImport();
    }
    if (match[1] === 'compile-start') {
      activePhase = 'compile';
      activePhaseGeneration += 1;
      if (pendingProbe === null) pendingProbe = runFreshImport();
    }
    if (match[1] === 'bundle-start') {
      activePhase = 'bundle';
      activePhaseGeneration += 1;
      if (pendingProbe === null) pendingProbe = runFreshImport();
    }
    if (
      (match[1] === 'install-complete' && activePhase === 'install')
      || (match[1] === 'compile-complete' && activePhase === 'compile')
      || (match[1] === 'bundle-complete' && activePhase === 'bundle')
    ) activePhase = null;
  }
}

function snapshot(path) {
  const stats = statSync(path);
  return {
    path,
    kind: stats.isDirectory() ? 'directory' : 'file',
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    sha256: stats.isFile() ? sha256(path) : null,
    entries: stats.isDirectory() ? readdirSync(path).sort() : null,
  };
}

function assertSnapshotUnchanged(expected) {
  assert.equal(existsSync(expected.path), true, `root dependency disappeared: ${expected.path}`);
  const actual = snapshot(expected.path);
  assert.deepEqual(actual, expected, `root dependency was replaced or changed: ${expected.path}`);
}

function signalChild(signal) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function cleanup() {
  if (child && child.exitCode === null && child.signalCode === null) signalChild('SIGKILL');
  for (const probe of activeImportProbes) probe.kill('SIGKILL');
  rmSync(testRoot, { recursive: true, force: true });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    stopping = true;
    signalChild(signal);
  });
}

function trackedBuildStatus() {
  const result = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=no', '--',
    'package.json',
    'package-lock.json',
    'backend/package.json',
    'backend/tsconfig.json',
    'backend/scripts',
    'backend/src',
    'backend/vendor',
    'frontend',
    'infra/sam-build/Makefile',
  ], { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'git status failed');
  return result.stdout;
}

async function runFreshImport() {
  const probe = spawn(process.execPath, ['--eval', importProbe], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeImportProbes.add(probe);
  let probeStdout = '';
  let probeStderr = '';
  probe.stdout.on('data', (chunk) => { probeStdout += chunk; });
  probe.stderr.on('data', (chunk) => { probeStderr += chunk; });
  let timeout;
  const result = await Promise.race([
    new Promise((resolveProbe, rejectProbe) => {
      probe.once('error', rejectProbe);
      probe.once('close', (status, signal) => resolveProbe({ status, signal }));
    }),
    new Promise((_, rejectTimeout) => {
      timeout = setTimeout(() => {
        probe.kill('SIGKILL');
        rejectTimeout(new Error(`fresh root dependency import timed out\nstdout:\n${probeStdout}\nstderr:\n${probeStderr}`));
      }, 10_000);
    }),
  ]).finally(() => {
    clearTimeout(timeout);
    activeImportProbes.delete(probe);
  });
  assert.equal(
    result.status,
    0,
    `fresh root dependency import failed (signal=${result.signal || 'none'})\nstdout:\n${probeStdout}\nstderr:\n${probeStderr}`,
  );
  assert.equal(probeStdout, 'imports-ok');
}

function processGroupInventory(processGroup) {
  if (process.platform === 'win32') return [];
  const result = spawnSync('ps', ['-eo', 'pid=,ppid=,pgid=,stat=,args='], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'process inventory failed');
  return result.stdout.split('\n').filter((line) => {
    const fields = line.trim().split(/\s+/, 3);
    return fields.length === 3 && Number(fields[2]) === processGroup;
  });
}

function currentPhases() {
  return seenPhases;
}

async function waitForExit(timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      new Promise((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('close', (status, signal) => resolveExit({ status, signal }));
      }),
      new Promise((_, rejectTimeout) => {
        timeout = setTimeout(() => {
          rejectTimeout(new Error(`SAM concurrency build timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  mkdirSync(testRoot, { recursive: true });
  const dependencyPaths = [
    join(repoRoot, 'package-lock.json'),
    join(repoRoot, 'node_modules'),
    join(repoRoot, 'node_modules', 'tsx'),
    join(repoRoot, 'node_modules', 'tsx', 'package.json'),
    join(repoRoot, 'node_modules', 'esbuild'),
    join(repoRoot, 'node_modules', 'esbuild', 'package.json'),
    join(repoRoot, 'node_modules', 'js-yaml', 'package.json'),
  ];
  for (const path of dependencyPaths) {
    if (!existsSync(path)) throw new Error(`Root dependency baseline is missing; run npm ci first: ${path}`);
  }
  const before = dependencyPaths.map(snapshot);
  const statusBefore = trackedBuildStatus();
  await runFreshImport();

  const cleanStartedAt = process.hrtime.bigint();
  child = spawn('make', ['sam-build', `SAM_BUILD_DIR=${artifactRoot}`], {
    cwd: repoRoot,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      ARTIFACTS_DIR: artifactRoot,
      DATAOPS_SAM_CACHE_ROOT: cacheRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    collectControlLines(chunk.toString(), 'stdout');
    stdout = appendTail(stdout, chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    collectControlLines(chunk.toString(), 'stderr');
    stderr = appendTail(stderr, chunk);
    process.stderr.write(chunk);
  });

  let importIterations = 0;
  const deadline = Date.now() + 120_000;
  const exited = waitForExit(120_000);
  while (child.exitCode === null && child.signalCode === null) {
    if (stopping) throw new Error('SAM concurrency proof interrupted');
    if (Date.now() > deadline) {
      signalChild('SIGTERM');
      throw new Error('SAM concurrency build exceeded its 120000ms deadline');
    }
    if (pendingProbe === null) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
      continue;
    }
    const probe = pendingProbe;
    const phaseBeforeImport = activePhase;
    const generationBeforeImport = activePhaseGeneration;
    await probe;
    if (pendingProbe === probe) pendingProbe = null;
    importIterations += 1;
    for (const expected of before) assertSnapshotUnchanged(expected);
    if (
      phaseBeforeImport
      && activePhase === phaseBeforeImport
      && activePhaseGeneration === generationBeforeImport
    ) {
      overlapByPhase.set(phaseBeforeImport, overlapByPhase.get(phaseBeforeImport) + 1);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
  }
  if (pendingProbe) await pendingProbe;
  const result = await exited;
  const cleanElapsedMs = Number(process.hrtime.bigint() - cleanStartedAt) / 1_000_000;
  await runFreshImport();
  importIterations += 1;
  for (const expected of before) assertSnapshotUnchanged(expected);
  assert.equal(result.status, 0, `SAM build failed (signal=${result.signal || 'none'})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.equal(result.signal, null);
  for (const phase of requiredOverlapPhases) {
    assert.ok(
      overlapByPhase.get(phase) > 0,
      `No successful fresh import was wholly bounded by the active SAM ${phase} phase\nstdout:\n${stdout}`,
    );
  }
  assert.equal(phaseCounts.get('install-start'), 1);
  assert.equal(phaseCounts.get('bundle-start'), 1);
  const statusAfter = trackedBuildStatus();
  assert.equal(statusAfter, statusBefore, `SAM build changed tracked source/build inputs\nbefore:\n${statusBefore}\nafter:\n${statusAfter}`);

  const artifactDirectories = functionArtifacts.map((name) => join(artifactRoot, name));
  const inventories = artifactDirectories.map((directory) => fileInventory(directory));
  for (const inventory of inventories.slice(1)) assert.deepEqual(inventory, inventories[0]);
  const manifest = JSON.parse(readFileSync(join(artifactDirectories[0], '.dataops-sam-bundle.json'), 'utf8'));
  assert.equal(manifest.target, 'node24');
  assert.match(manifest.buildFormatVersion, /isolated-install/);
  for (const directory of artifactDirectories) {
    assert.equal(existsSync(join(directory, 'dist', 'handler.js')), true);
  }
  const remaining = readdirSync(cacheRoot).filter((name) => name.includes('.lock') || name.includes('.building-'));
  assert.deepEqual(remaining, [], `owned lock/build state survived: ${remaining.join(', ')}`);
  const artifactStats = lstatSync(artifactRoot);
  assert.equal(artifactStats.isDirectory(), true);

  const warmStartedAt = process.hrtime.bigint();
  const warm = spawnSync('make', ['sam-build', `SAM_BUILD_DIR=${artifactRoot}`], {
    cwd: repoRoot,
    env: { ...process.env, DATAOPS_SAM_CACHE_ROOT: cacheRoot },
    encoding: 'utf8',
    timeout: 30_000,
  });
  const warmElapsedMs = Number(process.hrtime.bigint() - warmStartedAt) / 1_000_000;
  assert.equal(
    warm.status,
    0,
    `warm SAM build failed (signal=${warm.signal || 'none'})\nstdout:\n${warm.stdout}\nstderr:\n${warm.stderr}`,
  );
  const warmOutput = `${warm.stdout}\n${warm.stderr}`;
  assert.doesNotMatch(warmOutput, /phase=(?:install|compile|bundle)-start/);
  assert.equal((warmOutput.match(/\[sam-shared\] reusing /g) || []).length, functionArtifacts.length);
  const warmInventories = artifactDirectories.map((directory) => fileInventory(directory));
  for (const inventory of warmInventories) assert.deepEqual(inventory, inventories[0]);
  const remainingOwnedProcesses = processGroupInventory(child.pid);
  assert.deepEqual(remainingOwnedProcesses, [], `owned SAM processes survived:\n${remainingOwnedProcesses.join('\n')}`);
  assert.equal(activeImportProbes.size, 0);

  console.log(JSON.stringify({
    samExit: result.status,
    importIterations,
    overlapByPhase: Object.fromEntries(overlapByPhase),
    phases: [...currentPhases()].sort(),
    phaseCounts: Object.fromEntries([...phaseCounts.entries()].sort()),
    cacheRoot,
    artifacts: Object.fromEntries(functionArtifacts.map((name, index) => [name, {
      bytes: inventories[index].reduce((total, file) => total + file.bytes, 0),
      sha256: createHash('sha256').update(JSON.stringify(inventories[index])).digest('hex'),
    }])),
    rootSnapshotUnchanged: true,
    trackedInputsUnchanged: true,
    cleanElapsedMs: Math.round(cleanElapsedMs),
    warmElapsedMs: Math.round(warmElapsedMs),
    warmInstallCompileBundlePhases: 0,
    postRunProcessInventory: {
      samProcessGroup: remainingOwnedProcesses,
      freshImportProcesses: activeImportProbes.size,
    },
  }));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  console.error(`final SAM stdout tail:\n${stdout || '(empty)'}`);
  console.error(`final SAM stderr tail:\n${stderr || '(empty)'}`);
  process.exitCode = 1;
} finally {
  cleanup();
}
