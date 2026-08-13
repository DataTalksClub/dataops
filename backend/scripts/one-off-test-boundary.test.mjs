import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolve } from 'node:path';

const backendRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(backendRoot, '..');
const backendPackage = JSON.parse(readFileSync(resolve(backendRoot, 'package.json'), 'utf8'));
const manualCommand = 'test:one-off:dry-run-import';

test('one-off dry-run import verification is manual and absent from ongoing CI', () => {
  assert.match(
    backendPackage.scripts[manualCommand],
    /tests\/one-off\/dry-run-import\.test\.ts$/,
  );
  assert.doesNotMatch(
    backendPackage.scripts.test,
    /tests\/one-off|dry-run-import\.test\.ts/,
  );

  for (const path of [
    '.github/workflows/deploy-dataops-v1.yml',
    '.github/workflows/validate-backend-e2e.yml',
    'Makefile',
    'package.json',
  ]) {
    const source = readFileSync(resolve(repoRoot, path), 'utf8');
    assert.doesNotMatch(source, /test:one-off:dry-run-import|tests\/one-off\/dry-run-import\.test\.ts/);
  }

  for (const [name, command] of Object.entries(backendPackage.scripts)) {
    if (name === manualCommand) continue;
    assert.doesNotMatch(String(command), /tests\/one-off\/dry-run-import\.test\.ts/);
  }
});
