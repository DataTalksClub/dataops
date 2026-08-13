import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { readFrontendAssetManifest } from './frontend-assets.mjs';
import { copyFrontendArtifact } from './copy-frontend-artifact.mjs';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const verifier = join(repoRoot, 'backend', 'scripts', 'verify-frontend-artifact.mjs');
const runtimeProbe = join(repoRoot, 'backend', 'scripts', 'packaged-handler-probe.mjs');
const sourceFrontend = join(repoRoot, 'frontend');
const generatedRoot = join(repoRoot, '.tmp', 'issue-159', 'frontend-artifact-fixtures');
const allowlist = readFrontendAssetManifest().files.map((sourcePath) => [
  sourcePath,
  `dist/frontend/${sourcePath}`,
]);

function createLocalSchema(endpoint) {
  const setup = spawnSync(process.execPath, ['--import', 'tsx', '--eval', [
    "Promise.all([import('./backend/scripts/local-dynamodb.ts'), import('./backend/src/db/client.ts')])",
    '.then(async ([local, client]) => local.createTables(await client.getClient()))',
  ].join('')], {
    cwd: repoRoot,
    env: { ...process.env, DYNAMODB_ENDPOINT: endpoint },
    encoding: 'utf8',
  });
  assert.equal(setup.status, 0, setup.stderr);
}

function fixture(name) {
  const root = mkdtempSync(join(generatedRoot, `${name}-`));
  const source = join(root, 'source');
  const artifact = join(root, 'artifact');
  mkdirSync(artifact, { recursive: true });
  writeFileSync(join(artifact, 'handler.js'), 'module.exports = {};\n');
  for (const [sourcePath, canonicalPath] of allowlist) {
    const artifactPath = canonicalPath.replace(/^dist\//, '');
    mkdirSync(dirname(join(source, sourcePath)), { recursive: true });
    mkdirSync(dirname(join(artifact, artifactPath)), { recursive: true });
    const bytes = Buffer.from(`synthetic-${sourcePath}\n`);
    writeFileSync(join(source, sourcePath), bytes);
    writeFileSync(join(artifact, artifactPath), bytes);
  }
  const moduleImports = allowlist
    .map(([sourcePath]) => sourcePath)
    .filter((sourcePath) => sourcePath.startsWith('src/') && sourcePath.endsWith('.js'))
    .filter((sourcePath) => !['src/app.js', 'src/core/workspace.js'].includes(sourcePath))
    .map((sourcePath) => `import "./${sourcePath.slice('src/'.length)}";`)
    .join('\n');
  const moduleContents = new Map([
    [
      'src/app.js',
      [
        'import { routeMarker, workMarker } from "./core/workspace.js";',
        moduleImports,
        'void routeMarker;',
        'void workMarker;',
        '',
      ].join('\n'),
    ],
    ['src/core/workspace.js', 'export const routeMarker = true;\nexport const workMarker = true;\n'],
  ]);
  for (const [sourcePath] of allowlist) {
    if (!sourcePath.endsWith('.js') || moduleContents.has(sourcePath)) continue;
    moduleContents.set(sourcePath, `export const syntheticMarker = ${JSON.stringify(sourcePath)};\n`);
  }
  for (const [sourcePath, bytes] of moduleContents) {
    writeFileSync(join(source, sourcePath), bytes);
    writeFileSync(join(artifact, `frontend/${sourcePath}`), bytes);
  }
  return { root, source, artifact };
}

function run(source, artifact, extra = []) {
  return spawnSync(process.execPath, [verifier, '--source', source, '--artifact', artifact, ...extra], { encoding: 'utf8' });
}

function expectFailure(result, pattern) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, pattern);
}

describe('deterministic canonical frontend artifact verifier', () => {
  before(() => mkdirSync(generatedRoot, { recursive: true }));
  after(() => rmSync(generatedRoot, { recursive: true, force: true }));

  test('accepts exactly the manifest-declared byte-identical deployable files and reports sorted hashes', () => {
    const { source, artifact } = fixture('success');
    const result = run(source, artifact);
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(result.stdout);
    assert.deepEqual(manifest.files.map((entry) => entry.path), allowlist.map((entry) => entry[1]));
    assert.ok(manifest.files.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)));
  });

  test('requires explicit, unique, valued source and artifact arguments', () => {
    for (const [args, pattern] of [
      [[], /Missing required --source/],
      [['--source', sourceFrontend], /Missing required --artifact/],
      [['--artifact', repoRoot], /Missing required --source/],
      [['--source'], /Missing value for --source/],
      [['--source', sourceFrontend, '--source', sourceFrontend, '--artifact', repoRoot], /Duplicate argument/],
      [['--source', sourceFrontend, '--artifact', repoRoot, '--other', 'x'], /Unknown argument/],
    ]) {
      const result = spawnSync(process.execPath, [verifier, ...args], { encoding: 'utf8' });
      expectFailure(result, pattern);
    }
  });

  test('validates manifest version, paths, duplicates, and extensions', () => {
    const root = mkdtempSync(join(generatedRoot, 'manifest-validation-'));
    const manifestPath = join(root, 'manifest.json');
    for (const [payload, pattern] of [
      [{ version: 2, files: allowlist.map(([source]) => source) }, /version must be 1/],
      [{ version: 1, files: [] }, /non-empty array/],
      [{ version: 1, files: ['index.html', 'src/app.js', 'src/styles.css', 'src/../escape.js'] }, /must be normalized/],
      [{ version: 1, files: ['index.html', 'src/app.js', 'src/styles.css', 'src/app.js'] }, /Duplicate/],
      [{ version: 1, files: ['index.html', 'src/app.js', 'src/styles.css', 'src/data.json'] }, /Unsupported.*extension/],
      [{ version: 1, files: ['index.html', 'src/app.js', 'src/styles.css'], extra: true }, /schema only permits/],
    ]) {
      writeFileSync(manifestPath, JSON.stringify(payload));
      assert.throws(() => readFrontendAssetManifest(manifestPath), pattern);
    }
    const target = join(root, 'real-manifest.json');
    const link = join(root, 'linked-manifest.json');
    writeFileSync(target, JSON.stringify({ version: 1, files: ['index.html', 'src/app.js', 'src/styles.css'] }));
    symlinkSync(target, link);
    assert.throws(() => readFrontendAssetManifest(link), /non-symlink/);
  });

  test('fails closed for missing, unreadable-shaped, and non-directory roots', () => {
    const { root, source, artifact } = fixture('roots');
    expectFailure(run(join(root, 'missing-source'), artifact), /Source root is missing or unreadable/);
    expectFailure(run(source, join(root, 'missing-artifact')), /Artifact root is missing or unreadable/);
    const fileRoot = join(root, 'not-a-directory');
    writeFileSync(fileRoot, 'x');
    expectFailure(run(fileRoot, artifact), /Source root must be a real directory/);
  });

  test('rejects missing source and artifact files plus byte drift', () => {
    for (const [name, mutate, pattern] of [
      ['missing-source-file', ({ source }) => rmSync(join(source, 'src/app.js')), /missing or unreadable source file/],
      ['missing-artifact-file', ({ artifact }) => rmSync(join(artifact, 'frontend/src/app.js')), /missing artifact file/],
      ['byte-drift', ({ artifact }) => writeFileSync(join(artifact, 'frontend/src/app.js'), 'changed'), /byte drift/],
    ]) {
      const current = fixture(name);
      mutate(current);
      expectFailure(run(current.source, current.artifact), pattern);
    }
  });

  test('rejects duplicate frontend names/content and every alternate UI entrypoint tree', () => {
    for (const [name, path, contents, pattern] of [
      ['duplicate-name', 'other/app.js', 'different', /duplicate frontend filename/],
      ['duplicate-content', 'other/copy.bin', 'COPY_APP', /duplicate frontend content/],
      ['pages', 'pages/other.html', '<html>', /alternate HTML entrypoint|forbidden alternate UI tree/],
      ['public', 'public/client.js', 'x', /forbidden alternate UI tree/],
      ['static', 'static/client.js', 'x', /forbidden alternate UI tree/],
      ['other-html', 'other/shell.html', '<html>', /alternate HTML entrypoint/],
      ['ui', 'ui/client.js', 'x', /forbidden alternate UI tree/],
      ['empty-pages', 'pages/.keep', 'x', /forbidden alternate UI tree/],
      ['nested-public', 'other/public/client.js', 'x', /forbidden alternate UI tree/],
      ['nested-frontend', 'other/frontend-copy/client.js', 'x', /forbidden alternate frontend tree/],
    ]) {
      const current = fixture(name);
      const target = join(current.artifact, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents === 'COPY_APP' ? readFileSync(join(current.source, 'src/app.js')) : contents);
      expectFailure(run(current.source, current.artifact), pattern);
    }
    const emptyTree = fixture('empty-ui-tree');
    mkdirSync(join(emptyTree.artifact, 'public'), { recursive: true });
    expectFailure(run(emptyTree.source, emptyTree.artifact), /forbidden alternate UI tree/);
  });

  test('rejects extra frontend files, symlinks, and non-file allowlist entries', () => {
    const extra = fixture('extra');
    writeFileSync(join(extra.artifact, 'frontend/extra.js'), 'x');
    expectFailure(run(extra.source, extra.artifact), /extra frontend artifact/);

    const symlink = fixture('symlink');
    symlinkSync(join(symlink.source, 'src/app.js'), join(symlink.artifact, 'frontend/link.js'));
    expectFailure(run(symlink.source, symlink.artifact), /symlink/);

    const directory = fixture('directory');
    rmSync(join(directory.artifact, 'frontend/src/app.js'));
    mkdirSync(join(directory.artifact, 'frontend/src/app.js'));
    expectFailure(run(directory.source, directory.artifact), /must be a regular file|missing artifact file/);
  });

  test('rejects a production app import omitted from the explicit manifest', () => {
    const current = fixture('omitted-import');
    writeFileSync(
      join(current.source, 'src/app.js'),
      'import { omitted } from "./core/omitted.js";\nvoid omitted;\n',
    );
    writeFileSync(
      join(current.artifact, 'frontend/src/app.js'),
      readFileSync(join(current.source, 'src/app.js')),
    );
    mkdirSync(join(current.source, 'src/core'), { recursive: true });
    writeFileSync(join(current.source, 'src/core/omitted.js'), 'export const omitted = true;\n');
    expectFailure(run(current.source, current.artifact), /frontend import is missing from asset manifest/);
  });

  test('rejects unsupported module specifiers, non-literal imports, and omitted export-from modules', () => {
    for (const [name, source, pattern] of [
      ['bare-import', 'import "package-name";\n', /module specifier must be relative/],
      ['absolute-import', 'import "/src/core/workspace.js";\n', /module specifier must be relative/],
      ['dynamic-expression', 'const path = "./core/workspace.js";\nimport(path);\n', /dynamic import must use a literal relative path/],
      ['export-from', 'export { omitted } from "./core/omitted.js";\n', /import is missing from asset manifest/],
    ]) {
      const current = fixture(name);
      writeFileSync(join(current.source, 'src/app.js'), source);
      writeFileSync(join(current.artifact, 'frontend/src/app.js'), source);
      expectFailure(run(current.source, current.artifact), pattern);
    }
  });

  test('validates every source before replacing an existing artifact', () => {
    const current = fixture('copy-fails-safe');
    const marker = join(current.artifact, 'frontend', 'existing-marker.txt');
    writeFileSync(marker, 'preserve me');
    rmSync(join(current.source, 'src/core/workspace.js'));
    assert.throws(() => copyFrontendArtifact({
      sourceRoot: current.source,
      artifactRoot: current.artifact,
    }), /ENOENT|regular file/);
    assert.equal(existsSync(marker), true);
    assert.equal(readFileSync(marker, 'utf8'), 'preserve me');
  });

  test('rejects ambiguous layouts and accepts dependency HTML and un-followed dependency symlinks', () => {
    const ambiguous = fixture('ambiguous');
    mkdirSync(join(ambiguous.artifact, 'dist/frontend'), { recursive: true });
    writeFileSync(join(ambiguous.artifact, 'dist/handler.js'), 'module.exports = {};\n');
    expectFailure(run(ambiguous.source, ambiguous.artifact), /ambiguous artifact layout/);

    const incomplete = fixture('incomplete');
    rmSync(join(incomplete.artifact, 'handler.js'));
    expectFailure(run(incomplete.source, incomplete.artifact), /incomplete backend artifact layout/);

    const dependency = fixture('dependency');
    mkdirSync(join(dependency.artifact, 'node_modules/pkg'), { recursive: true });
    mkdirSync(join(dependency.artifact, 'node_modules/.bin'), { recursive: true });
    writeFileSync(join(dependency.artifact, 'node_modules/pkg/help.html'), '<html>dependency help</html>');
    writeFileSync(join(dependency.artifact, 'node_modules/pkg/cli.js'), '');
    symlinkSync('../pkg/cli.js', join(dependency.artifact, 'node_modules/.bin/pkg'));
    symlinkSync('pkg', join(dependency.artifact, 'node_modules/pkg-link'));
    const result = run(dependency.source, dependency.artifact);
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(result.stdout);
    assert.equal(manifest.dependencyInventory.htmlFiles, 1);
    assert.equal(manifest.dependencyInventory.symlinks, 2);
  });
});

describe('isolated SAM handler frontend runtime', () => {
  before(() => mkdirSync(generatedRoot, { recursive: true }));
  after(() => rmSync(generatedRoot, { recursive: true, force: true }));

  test('serves only packaged assets through real cookie auth without outside module resolution', async () => {
    const samArtifact = join(repoRoot, '.aws-sam', 'build', 'BackendFunction');
    const isolated = mkdtempSync(join(generatedRoot, 'runtime-'));
    cpSync(samArtifact, isolated, { recursive: true, dereference: false });
    const require = createRequire(import.meta.url);
    const dynalite = require('dynalite')({ createTableMs: 0 });
    await new Promise((resolveListen, rejectListen) => dynalite.listen(0, (error) => error ? rejectListen(error) : resolveListen()));
    const endpoint = `http://127.0.0.1:${dynalite.address().port}`;
    createLocalSchema(endpoint);
    const probe = (artifact, paths) => new Promise((resolveProbe, rejectProbe) => {
      const child = spawn(process.execPath, [runtimeProbe, '--artifact', artifact], {
        cwd: artifact,
        env: {
          ...process.env,
          FRONTEND_ROOT: '',
          NODE_PATH: '',
          DYNAMODB_ENDPOINT: endpoint,
          ISSUE_159_REQUEST_PATHS: JSON.stringify(paths),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', rejectProbe);
      child.once('exit', (status) => resolveProbe({ status, stdout, stderr }));
    });
    try {
      const manifestAssets = readFrontendAssetManifest().files.map((asset) => `/${asset}`);
      const positive = await probe(isolated, ['/', '/workspace/deep-link', ...manifestAssets, '/src/../package.json', '/src/missing.js', '/public/app.js', '/public/extensionless', '/unknown.js', '/api/not-a-route', '/work/api']);
      assert.equal(positive.status, 0, positive.stderr);
      const result = JSON.parse(positive.stdout);
      assert.equal(result.outsideModuleResolution, false);
      const responses = new Map(result.responses.map((response) => [response.path, response]));
      for (const path of ['/', '/workspace/deep-link']) {
        const response = responses.get(path);
        assert.equal(response.statusCode, 200);
        assert.match(response.contentType, /^text\/html/);
        assert.equal(response.body, readFileSync(join(isolated, 'dist/frontend/index.html'), 'utf8'));
      }
      for (const asset of readFrontendAssetManifest().files) {
        const requestPath = `/${asset}`;
        const response = responses.get(requestPath);
        assert.equal(response.statusCode, 200);
        assert.match(response.contentType, asset.endsWith('.css') ? /text\/css/ : asset.endsWith('.html') ? /text\/html/ : /javascript/);
        assert.equal(response.body, readFileSync(join(isolated, 'dist/frontend', asset), 'utf8'));
      }
      for (const path of ['/src/../package.json', '/src/missing.js', '/public/app.js', '/public/extensionless', '/unknown.js']) {
        const response = responses.get(path);
        assert.equal(response.statusCode, 404, path);
        assert.doesNotMatch(response.body, /<html/i);
      }
      const api = responses.get('/api/not-a-route');
      assert.equal(api.statusCode, 404);
      assert.match(api.contentType, /application\/json/);
      assert.doesNotMatch(api.body, /<html/i);
      const exactWorkApi = responses.get('/work/api');
      assert.equal(exactWorkApi.statusCode, 404);
      assert.match(exactWorkApi.contentType, /application\/json/);
      assert.doesNotMatch(exactWorkApi.body, /<html/i);

      const missing = mkdtempSync(join(generatedRoot, 'missing-runtime-'));
      cpSync(samArtifact, missing, { recursive: true, dereference: false });
      renameSync(join(missing, 'dist/frontend/index.html'), join(missing, 'dist/frontend/index.missing'));
      const missingResult = await probe(missing, ['/']);
      assert.equal(missingResult.status, 0, missingResult.stderr);
      const missingResponse = JSON.parse(missingResult.stdout).responses[0];
      assert.equal(missingResponse.statusCode, 500);
      assert.match(missingResponse.contentType, /application\/json/);
      assert.doesNotMatch(missingResponse.body, /<html/i);
    } finally {
      await new Promise((resolveClose, rejectClose) => dynalite.close((error) => error ? rejectClose(error) : resolveClose()));
    }
  });
});
