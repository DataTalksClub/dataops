import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  acquireLock,
  artifactInventory,
  copyIsolatedBuildWorkspace,
  copyIsolatedArtifact,
  computeFingerprint,
  ensureCachedArtifact,
  readValidManifest,
  reclaimStaleLock,
  releaseLock,
  requestCancellation,
  resetCancellationForTest,
  runOwnedCommand,
  workspaceRequire,
} from './build-sam-artifact.mjs';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const testRoot = join(repoRoot, '.tmp', 'issue-185');

function writeFixtureArtifact(destination, contents = 'handler bytes') {
  mkdirSync(join(destination, 'dist'), { recursive: true });
  writeFileSync(join(destination, 'dist', 'handler.js'), contents);
  const manifest = {
    schemaVersion: 1,
    format: 'dataops-sam-esbuild',
    buildFormatVersion: 'dataops-sam-esbuild-v2-isolated-install',
    target: 'node24',
    fingerprint: 'fixture',
    bundledOutputs: ['dist/handler.js'],
    inputs: ['backend/src/handler.ts'],
    files: [],
  };
  writeFileSync(join(destination, '.dataops-sam-bundle.json'), `${JSON.stringify(manifest)}\n`);
  manifest.files = artifactInventory(destination);
  writeFileSync(join(destination, '.dataops-sam-bundle.json'), `${JSON.stringify(manifest)}\n`);
}

test('concurrent SAM function builds publish one complete shared artifact', async () => {
  mkdirSync(testRoot, { recursive: true });
  const root = mkdtempSync(join(testRoot, 'concurrency-'));
  const cache = join(root, 'cache', 'fingerprint');
  let builds = 0;
  const build = async (destination) => {
    builds += 1;
    await delay(150);
    writeFixtureArtifact(destination);
  };

  try {
    const results = await Promise.all([
      ensureCachedArtifact({ artifactCache: cache, expectedFingerprint: 'fixture', build }),
      ensureCachedArtifact({ artifactCache: cache, expectedFingerprint: 'fixture', build }),
      ensureCachedArtifact({ artifactCache: cache, expectedFingerprint: 'fixture', build }),
    ]);
    assert.equal(builds, 1);
    assert.equal(results.filter((result) => result.built).length, 1);
    assert.ok(readValidManifest(cache));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SAM function copies are complete and isolated from one another', () => {
  mkdirSync(testRoot, { recursive: true });
  const root = mkdtempSync(join(testRoot, 'isolation-'));
  const cache = join(root, 'cache');
  const first = join(root, 'first');
  const second = join(root, 'second');

  try {
    mkdirSync(cache);
    writeFixtureArtifact(cache);
    copyIsolatedArtifact(cache, first, { allowedBoundary: root });
    copyIsolatedArtifact(cache, second, { allowedBoundary: root });
    writeFileSync(join(first, 'dist', 'handler.js'), 'mutated first copy');

    assert.equal(readFileSync(join(second, 'dist', 'handler.js'), 'utf8'), 'handler bytes');
    assert.equal(readFileSync(join(cache, 'dist', 'handler.js'), 'utf8'), 'handler bytes');
    assert.equal(readValidManifest(first), null);
    assert.ok(readValidManifest(second));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cache and artifact deletion boundaries refuse symlinked ancestors', async () => {
  mkdirSync(testRoot, { recursive: true });
  const root = mkdtempSync(join(testRoot, 'symlink-boundary-'));
  const outside = mkdtempSync(join(testRoot, 'symlink-outside-'));
  const allowed = join(root, 'allowed');
  const linked = join(allowed, 'linked-outside');
  const artifactWithLinkedEntry = join(allowed, 'artifact-with-linked-entry');
  const cache = join(root, 'source');
  const sentinel = join(outside, 'sentinel.txt');
  try {
    mkdirSync(allowed);
    mkdirSync(cache);
    writeFixtureArtifact(cache);
    writeFileSync(sentinel, 'must survive');
    symlinkSync(outside, linked, 'dir');

    assert.throws(
      () => copyIsolatedArtifact(cache, join(linked, 'artifact'), { allowedBoundary: allowed }),
      /symbolic link/,
    );
    await assert.rejects(
      ensureCachedArtifact({
        artifactCache: join(linked, 'cache', 'fixture'),
        expectedFingerprint: 'fixture',
        build: async () => assert.fail('build must not run through a symlinked cache root'),
      }),
      /symbolic link/,
    );
    mkdirSync(artifactWithLinkedEntry);
    symlinkSync(outside, join(artifactWithLinkedEntry, 'linked-entry'), 'dir');
    assert.throws(
      () => copyIsolatedArtifact(cache, artifactWithLinkedEntry, { allowedBoundary: allowed }),
      /symbolic link/,
    );
    assert.equal(readFileSync(sentinel, 'utf8'), 'must survive');
    assert.equal(readdirSync(outside).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('extra or corrupt cache files are never accepted as a warm artifact', () => {
  mkdirSync(testRoot, { recursive: true });
  const root = mkdtempSync(join(testRoot, 'corruption-'));
  const artifact = join(root, 'artifact');
  try {
    mkdirSync(artifact);
    writeFixtureArtifact(artifact);
    assert.ok(readValidManifest(artifact));
    writeFileSync(join(artifact, 'unexpected.js'), 'not declared by the manifest');
    assert.equal(readValidManifest(artifact), null);
    rmSync(join(artifact, 'unexpected.js'));
    writeFileSync(join(artifact, 'dist', 'handler.js'), 'corrupt bytes');
    assert.equal(readValidManifest(artifact), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed builds remove only their attempt and owned lock', async () => {
  mkdirSync(testRoot, { recursive: true });
  const root = mkdtempSync(join(testRoot, 'failure-cleanup-'));
  const cache = join(root, 'cache', 'fingerprint');
  const unrelated = join(root, 'cache', 'unrelated');
  mkdirSync(unrelated, { recursive: true });
  writeFileSync(join(unrelated, 'keep.txt'), 'keep');
  try {
    await assert.rejects(
      ensureCachedArtifact({
        artifactCache: cache,
        expectedFingerprint: 'fixture',
        build: async (destination) => {
          mkdirSync(join(destination, 'dist'));
          writeFileSync(join(destination, 'dist', 'partial.js'), 'partial');
          throw new Error('synthetic isolated install failure');
        },
      }),
      /synthetic isolated install failure/,
    );
    assert.equal(existsSync(cache), false);
    assert.equal(existsSync(`${cache}.lock`), false);
    assert.equal(existsSync(join(unrelated, 'keep.txt')), true);
    assert.deepEqual(
      readFileSync(join(unrelated, 'keep.txt'), 'utf8'),
      'keep',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dead and malformed stale locks recover while live locks time out with owner evidence', async () => {
  mkdirSync(testRoot, { recursive: true });
  const root = mkdtempSync(join(testRoot, 'locks-'));
  const deadLock = join(root, 'dead.lock');
  const malformedLock = join(root, 'malformed.lock');
  const liveLock = join(root, 'live.lock');
  try {
    mkdirSync(deadLock);
    writeFileSync(join(deadLock, 'owner.json'), `${JSON.stringify({
      pid: 999999999,
      createdAt: 1,
      token: 'dead-owner-token-1234',
    })}\n`);
    const deadAcquired = await acquireLock(deadLock, { staleAfterMs: 0, pollMs: 1 });
    assert.equal(deadAcquired.pid, process.pid);
    assert.equal(releaseLock(deadLock, deadAcquired), true);

    mkdirSync(malformedLock);
    writeFileSync(join(malformedLock, 'owner.json'), 'not json');
    const malformedAcquired = await acquireLock(malformedLock, { staleAfterMs: -1, pollMs: 1 });
    assert.equal(releaseLock(malformedLock, malformedAcquired), true);

    mkdirSync(liveLock);
    writeFileSync(join(liveLock, 'owner.json'), `${JSON.stringify({
      pid: process.pid,
      createdAt: Date.now(),
      token: 'live-owner-token-1234',
    })}\n`);
    await assert.rejects(
      acquireLock(liveLock, { timeoutMs: 10, staleAfterMs: 0, pollMs: 1 }),
      new RegExp(`Timed out waiting for SAM build lock.*pid=${process.pid}`),
    );
    assert.equal(existsSync(liveLock), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lock release cannot remove ownership that was replaced after acquisition', async () => {
  mkdirSync(testRoot, { recursive: true });
  const root = mkdtempSync(join(testRoot, 'lock-replaced-'));
  const lock = join(root, 'artifact.lock');
  try {
    const acquired = await acquireLock(lock);
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner.json'), `${JSON.stringify({
      pid: process.pid,
      createdAt: Date.now(),
      token: 'replacement-token-1234',
    })}\n`);
    assert.equal(releaseLock(lock, acquired), false);
    assert.equal(existsSync(lock), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stale reclamation cannot delete a replacement live owner', () => {
  mkdirSync(testRoot, { recursive: true });
  const root = mkdtempSync(join(testRoot, 'stale-race-'));
  const lock = join(root, 'artifact.lock');
  const oldOwner = { pid: 999999999, createdAt: 1, token: 'stale-owner-token-1234' };
  const newOwner = { pid: process.pid, createdAt: Date.now(), token: 'new-live-owner-token-1234' };
  try {
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner.json'), `${JSON.stringify(oldOwner)}\n`);
    const stats = lstatSync(lock);
    const inspected = { dev: stats.dev, ino: stats.ino, owner: oldOwner };
    const reclaimed = reclaimStaleLock(lock, inspected, {
      beforeIdentityCheck: () => {
        rmSync(lock, { recursive: true, force: true });
        mkdirSync(lock);
        writeFileSync(join(lock, 'owner.json'), `${JSON.stringify(newOwner)}\n`);
      },
    });
    assert.equal(reclaimed, false);
    assert.equal(existsSync(lock), true);
    assert.deepEqual(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')), newOwner);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('different fingerprints build in independent mutable directories', async () => {
  mkdirSync(testRoot, { recursive: true });
  const root = mkdtempSync(join(testRoot, 'fingerprints-'));
  const destinations = [];
  const build = (contents) => async (destination) => {
    destinations.push(destination);
    await delay(20);
    writeFixtureArtifact(destination, contents);
  };
  try {
    const [first, second] = await Promise.all([
      ensureCachedArtifact({ artifactCache: join(root, 'cache', 'fingerprint-a'), expectedFingerprint: 'fixture', build: build('a') }),
      ensureCachedArtifact({ artifactCache: join(root, 'cache', 'fingerprint-b'), expectedFingerprint: 'fixture', build: build('b') }),
    ]);
    assert.equal(first.built, true);
    assert.equal(second.built, true);
    assert.equal(destinations.length, 2);
    assert.notEqual(destinations[0], destinations[1]);
    assert.equal(readFileSync(join(first.cache, 'dist', 'handler.js'), 'utf8'), 'a');
    assert.equal(readFileSync(join(second.cache, 'dist', 'handler.js'), 'utf8'), 'b');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('isolated workspace copies fingerprint inputs without source links or checkout dependencies', () => {
  mkdirSync(testRoot, { recursive: true });
  const root = mkdtempSync(join(testRoot, 'workspace-'));
  const workspace = join(root, 'workspace');
  try {
    copyIsolatedBuildWorkspace(repoRoot, workspace);
    assert.equal(existsSync(join(workspace, 'package-lock.json')), true);
    assert.equal(existsSync(join(workspace, 'backend', 'src', 'handler.ts')), true);
    assert.equal(existsSync(join(workspace, 'frontend', 'index.html')), true);
    assert.equal(existsSync(join(workspace, 'node_modules')), false);
    assert.equal(existsSync(join(workspace, 'backend', 'node_modules')), false);
    assert.equal(lstatSync(join(workspace, 'backend', 'src', 'handler.ts')).isSymbolicLink(), false);
    assert.notEqual(
      statSync(join(workspace, 'backend', 'src', 'handler.ts')).ino,
      statSync(join(repoRoot, 'backend', 'src', 'handler.ts')).ino,
    );
    assert.equal(computeFingerprint(workspace), computeFingerprint(repoRoot));
    writeFileSync(join(workspace, 'frontend', 'index.html'), 'fingerprint mutation');
    assert.notEqual(computeFingerprint(workspace), computeFingerprint(repoRoot));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dependency resolution must stay inside the isolated build workspace', () => {
  mkdirSync(testRoot, { recursive: true });
  const root = mkdtempSync(join(testRoot, 'resolution-'));
  const workspace = join(root, 'workspace');
  try {
    mkdirSync(join(workspace, 'backend'), { recursive: true });
    writeFileSync(join(workspace, 'backend', 'package.json'), '{"name":"isolated"}\n');
    assert.throws(() => workspaceRequire(workspace, 'esbuild'), /escaped the build workspace/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('artifact copy refuses a destination outside an explicit SAM output boundary', () => {
  mkdirSync(testRoot, { recursive: true });
  const root = mkdtempSync(join(testRoot, 'safe-copy-'));
  const cache = join(root, 'cache');
  const allowed = join(root, 'allowed');
  const outside = join(root, 'outside');
  try {
    mkdirSync(cache);
    mkdirSync(allowed);
    writeFixtureArtifact(cache);
    assert.throws(
      () => copyIsolatedArtifact(cache, outside, { allowedBoundary: allowed }),
      /Refusing unsafe SAM artifact directory/,
    );
    assert.equal(existsSync(outside), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cancellation terminates the owned command group and cleans its attempt and lock', async () => {
  mkdirSync(testRoot, { recursive: true });
  const root = mkdtempSync(join(testRoot, 'cancel-cleanup-'));
  const cache = join(root, 'cache', 'fingerprint');
  const running = ensureCachedArtifact({
    artifactCache: cache,
    expectedFingerprint: 'fixture',
    build: async (destination) => {
      writeFileSync(join(destination, 'partial.txt'), 'partial');
      await runOwnedCommand(process.execPath, [
        '--eval',
        "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)",
      ], { phase: 'synthetic cancellation fixture' });
    },
  });
  try {
    await delay(40);
    requestCancellation('SIGTERM');
    await assert.rejects(running, (error) => {
      assert.match(error.message, /cancelled by SIGTERM/);
      assert.equal(error.exitCode, 143);
      return true;
    });
    assert.equal(existsSync(cache), false);
    assert.equal(existsSync(`${cache}.lock`), false);
    assert.deepEqual(
      readdirSync(dirname(cache)).filter((name) => name.includes('.building-')),
      [],
    );
  } finally {
    resetCancellationForTest();
    rmSync(root, { recursive: true, force: true });
  }
});
