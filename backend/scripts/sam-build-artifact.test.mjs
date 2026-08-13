import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  artifactInventory,
  copyIsolatedArtifact,
  ensureCachedArtifact,
  readValidManifest,
} from './build-sam-artifact.mjs';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const testRoot = join(repoRoot, '.tmp', 'issue-172');

function writeFixtureArtifact(destination, contents = 'handler bytes') {
  mkdirSync(join(destination, 'dist'), { recursive: true });
  writeFileSync(join(destination, 'dist', 'handler.js'), contents);
  const manifest = {
    schemaVersion: 1,
    format: 'dataops-sam-esbuild',
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
      ensureCachedArtifact({ artifactCache: cache, build }),
      ensureCachedArtifact({ artifactCache: cache, build }),
      ensureCachedArtifact({ artifactCache: cache, build }),
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
    copyIsolatedArtifact(cache, first);
    copyIsolatedArtifact(cache, second);
    writeFileSync(join(first, 'dist', 'handler.js'), 'mutated first copy');

    assert.equal(readFileSync(join(second, 'dist', 'handler.js'), 'utf8'), 'handler bytes');
    assert.equal(readFileSync(join(cache, 'dist', 'handler.js'), 'utf8'), 'handler bytes');
    assert.equal(readValidManifest(first), null);
    assert.ok(readValidManifest(second));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
