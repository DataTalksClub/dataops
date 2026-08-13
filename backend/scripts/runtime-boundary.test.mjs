import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const verifier = join(import.meta.dirname, 'verify-runtime-boundary.mjs');

function verify(artifact) {
  return spawnSync(process.execPath, [verifier, artifact], { encoding: 'utf8' });
}

test('runtime boundary rejects removed framework directories', () => {
  const artifact = mkdtempSync(join(tmpdir(), 'dataops-runtime-boundary-'));
  try {
    mkdirSync(join(artifact, 'sponsorCrmMigration'));
    const result = verify(artifact);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /sponsorCrmMigration/);
  } finally {
    rmSync(artifact, { recursive: true, force: true });
  }
});

test('runtime boundary rejects importer inputs in a SAM bundle manifest', () => {
  const artifact = mkdtempSync(join(tmpdir(), 'dataops-runtime-boundary-'));
  try {
    writeFileSync(join(artifact, '.dataops-sam-bundle.json'), JSON.stringify({
      schemaVersion: 1,
      format: 'dataops-sam-esbuild',
      bundledOutputs: [],
      inputs: ['backend/scripts/import-calendar.ts'],
    }));
    const result = verify(artifact);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /import-calendar\.ts/);
  } finally {
    rmSync(artifact, { recursive: true, force: true });
  }
});
