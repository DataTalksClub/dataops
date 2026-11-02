import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';

const configModule = new URL('../src/config.mjs', import.meta.url).href;

function fixture(run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dataops-config-'));
  const file = path.join(dir, 'credentials.json');
  const original = JSON.stringify({ defaultUrl: 'https://other.test', profiles: { 'https://other.test': { token: 'synthetic-other-token' } } });
  writeFileSync(file, original, { mode: 0o600 });
  try { run({ dir, file, original }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

function runScript(dir, script) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, DATAOPS_CONFIG_DIR: dir, DATAOPS_TOKEN: '', DATAOPS_URL: '' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
}

test('credential writes preserve other profiles, enforce owner-only modes, and leave no temporary files', () => {
  fixture(({ dir, file }) => {
    chmodSync(dir, 0o755);
    chmodSync(file, 0o644);
    runScript(dir, `
      const { saveProfile } = await import(${JSON.stringify(configModule)});
      saveProfile('https://portal.test/', { token: 'synthetic-device-token', tokenId: 'synthetic-id', kind: 'user' });
    `);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
      defaultUrl: 'https://portal.test',
      profiles: {
        'https://other.test': { token: 'synthetic-other-token' },
        'https://portal.test': { token: 'synthetic-device-token', tokenId: 'synthetic-id', kind: 'user' },
      },
    });
    // Windows reports DOS permissions through stat, not the filesystem ACL.
    if (process.platform !== 'win32') {
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
    }
    assert.deepEqual(readdirSync(dir), ['credentials.json']);
    // A separate process must be able to reuse the saved profile.
    runScript(dir, `
      import assert from 'node:assert/strict';
      const { resolveProfile } = await import(${JSON.stringify(configModule)});
      const profile = resolveProfile();
      assert.equal(profile.token, 'synthetic-device-token');
      assert.equal(profile.source, 'file');
    `);
  });
});

test('a failed credential replacement leaves the original file intact and cleans up temporary files', () => {
  fixture(({ dir, file, original }) => {
    runScript(dir, `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import assert from 'node:assert/strict';
      fs.renameSync = () => { throw new Error('Synthetic disk failure'); };
      syncBuiltinESMExports();
      const { saveProfile } = await import(${JSON.stringify(configModule)});
      assert.throws(() => saveProfile('https://portal.test', { token: 'synthetic-only' }), /Synthetic disk failure/);
      assert.deepEqual(fs.readdirSync(process.env.DATAOPS_CONFIG_DIR), ['credentials.json']);
    `);
    assert.equal(readFileSync(file, 'utf8'), original);
  });
});

test('managed-engine sessions resolve the shared Hub DataOps credential directory and refuse git worktree paths', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hub-config-'));
  try {
    const sharedDir = path.join(root, 'shared', 'dataops');
    const engineConfig = path.join(root, 'managed-engines', 'hub-antigravity-1', 'home', '.config');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const { hubSharedConfigDir, saveProfileToDir, resolveProfile, credentialsPath } = await import(${JSON.stringify(configModule)});
      assert.equal(hubSharedConfigDir(), ${JSON.stringify(sharedDir)});
      saveProfileToDir(${JSON.stringify(sharedDir)}, 'https://ops.dtcdev.click', {
        token: 'dops_shared_session_token',
        tokenId: 'shared-id',
        label: 'hub-sessions@hetzner',
        scopes: ['kb:write', 'templates:write', 'cards:write', 'newsletter:write'],
        kind: 'agent',
      });
      assert.equal(credentialsPath(), ${JSON.stringify(path.join(sharedDir, 'credentials.json'))});
      const profile = resolveProfile({ url: 'https://ops.dtcdev.click' });
      assert.equal(profile.token, 'dops_shared_session_token');
      assert.equal(profile.label, 'hub-sessions@hetzner');
      assert.deepEqual(profile.scopes, ['kb:write', 'templates:write', 'cards:write', 'newsletter:write']);
      assert.throws(
        () => saveProfileToDir(process.cwd(), 'https://ops.dtcdev.click', { token: 'dops_x' }),
        /Refusing to store DataOps credentials inside a git repository/,
      );
    `], {
      env: { ...process.env, DATAOPS_CONFIG_DIR: '', DATAOPS_TOKEN: '', DATAOPS_URL: '', XDG_CONFIG_HOME: engineConfig },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
