import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';

import {
  assertSamResolution,
  resolveParityModulePaths,
} from './frontend-parity-runtime.mjs';

describe('frontend parity module ownership', () => {
  const backendRoot = resolve(import.meta.dirname, '..');
  let artifactRoot;
  let temporaryRoot;

  before(() => {
    temporaryRoot = mkdtempSync(join(tmpdir(), 'dataops-parity-runtime-'));
    artifactRoot = join(temporaryRoot, 'sam-artifact');
    mkdirSync(join(artifactRoot, 'dist'), { recursive: true });
    writeFileSync(join(artifactRoot, 'dist', 'handler.js'), 'export {};\n');
  });

  after(() => {
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  test('selects the TypeScript source handler and repository fixture support', () => {
    const paths = resolveParityModulePaths({ mode: 'source', moduleRoot: backendRoot });
    assert.equal(paths.handler, join(backendRoot, 'src', 'handler.ts'));
    assert.equal(
      paths.fixtureSupport,
      join(backendRoot, 'scripts', 'frontend-parity-support.ts'),
    );
  });

  test('selects only the built SAM handler while keeping repository fixture support', () => {
    const paths = resolveParityModulePaths({ mode: 'sam', moduleRoot: artifactRoot });
    assert.equal(paths.handler, join(artifactRoot, 'dist', 'handler.js'));
    assert.equal(
      paths.fixtureSupport,
      join(backendRoot, 'scripts', 'frontend-parity-support.ts'),
    );
  });

  test('fails a renamed SAM handler without selecting a source fallback', () => {
    assert.throws(
      () => resolveParityModulePaths({
        mode: 'sam',
        moduleRoot: join(artifactRoot, 'missing'),
      }),
      /SAM parity handler is missing.*no alternate handler/,
    );
  });

  test('narrows resolution confinement to importers inside the SAM artifact', () => {
    const externalPath = join(temporaryRoot, 'outside-artifact.js');
    mkdirSync(dirname(externalPath), { recursive: true });
    writeFileSync(externalPath, 'export {};\n');

    assert.doesNotThrow(() => assertSamResolution({
      moduleRoot: artifactRoot,
      importer: join(backendRoot, 'scripts', 'frontend-parity-support.ts'),
      resolved: externalPath,
    }));
    assert.throws(() => assertSamResolution({
      moduleRoot: artifactRoot,
      importer: join(artifactRoot, 'dist', 'handler.js'),
      resolved: externalPath,
    }), /outside module resolution/);
  });
});
