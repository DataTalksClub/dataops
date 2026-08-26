import assert from 'node:assert';
import { after, describe, it } from 'node:test';
import {
  createCipheriv,
  hkdfSync,
} from 'node:crypto';

import { decodeCollectionCursor, encodeCollectionCursor, parseCollectionLimit } from '../src/db/collectionPagination';
import { CollectionCursorError } from '../src/db/collectionPagination';
import type { CursorBinding, ExclusiveStartKey } from '../src/db/collectionPagination';

const TEST_SECRET = 'synthetic-collection-cursor-security-secret';
const CURSOR_SALT = 'dataops:collection-cursor:salt:v1';
const CURSOR_INFO = 'dataops:collection-cursor:v1';
const TEST_START_KEY: ExclusiveStartKey = { cursor: 'synthetic-boundary' };

const environment = {
  NODE_ENV: process.env.NODE_ENV,
  SKIP_AUTH: process.env.SKIP_AUTH,
  IS_LOCAL: process.env.IS_LOCAL,
  WORK_ENGINE_PORTAL_SECRET: process.env.WORK_ENGINE_PORTAL_SECRET,
};

process.env.NODE_ENV = 'test';
process.env.SKIP_AUTH = 'true';
process.env.IS_LOCAL = 'true';
process.env.WORK_ENGINE_PORTAL_SECRET = TEST_SECRET;

const binding: CursorBinding = {
  collection: 'synthetic-collection',
  filters: { scope: 'synthetic', state: 'active' },
  principal: 'synthetic-viewer',
};

function restoreEnvironmentVariable(name: keyof typeof environment): void {
  const value = environment[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

after(() => {
  restoreEnvironmentVariable('NODE_ENV');
  restoreEnvironmentVariable('SKIP_AUTH');
  restoreEnvironmentVariable('IS_LOCAL');
  restoreEnvironmentVariable('WORK_ENGINE_PORTAL_SECRET');
});

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(',')}}`;
}

function makeVersionedCursor(cursorBinding: CursorBinding, version: number): string {
  const key = Buffer.from(hkdfSync(
    'sha256',
    Buffer.from(TEST_SECRET, 'utf-8'),
    Buffer.from(CURSOR_SALT, 'utf-8'),
    Buffer.from(CURSOR_INFO, 'utf-8'),
    32,
  ));
  const initializationVector = Buffer.alloc(12, 0x53);
  const cipher = createCipheriv('aes-256-gcm', key, initializationVector);
  const payload = Buffer.from(JSON.stringify({
    v: version,
    c: cursorBinding.collection,
    f: canonical(cursorBinding.filters),
    p: cursorBinding.principal,
    k: TEST_START_KEY,
  }), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([
    initializationVector,
    cipher.getAuthTag(),
    encrypted,
  ]).toString('base64url');
}

function tamper(cursor: string): string {
  const replacement = cursor[5] === 'A' ? 'B' : 'A';
  return `${cursor.slice(0, 5)}${replacement}${cursor.slice(6)}`;
}

async function assertCursorCode(
  operation: () => Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(
    operation,
    (error: unknown) => error instanceof CollectionCursorError
      && error.code === code
      && error.message === 'Invalid pagination input',
  );
}

describe('collection cursor rejection classes', () => {
  it('rejects cursors bound to a different collection, filter set, or principal', async () => {
    const cursor = await encodeCollectionCursor(binding, TEST_START_KEY);

    await assertCursorCode(
      () => decodeCollectionCursor({ ...binding, collection: 'other-collection' }, cursor),
      'cursor-binding-mismatch',
    );
    await assertCursorCode(
      () => decodeCollectionCursor({ ...binding, filters: { scope: 'synthetic', state: 'archived' } }, cursor),
      'cursor-binding-mismatch',
    );
    await assertCursorCode(
      () => decodeCollectionCursor({ ...binding, principal: 'other-viewer' }, cursor),
      'cursor-binding-mismatch',
    );
  });

  it('rejects tampered, truncated, malformed, unknown-version, and oversized tokens', async () => {
    const cursor = await encodeCollectionCursor(binding, TEST_START_KEY);

    await assertCursorCode(
      () => decodeCollectionCursor(binding, tamper(cursor)),
      'cursor-tampered-or-malformed',
    );
    await assertCursorCode(
      () => decodeCollectionCursor(binding, Buffer.alloc(30, 0x53).toString('base64url')),
      'cursor-truncated',
    );

    for (const malformed of [undefined, null, 42, [], '', 'not a cursor', 'bad$cursor']) {
      await assertCursorCode(
        () => decodeCollectionCursor(binding, malformed),
        'cursor-malformed',
      );
    }

    await assertCursorCode(
      () => decodeCollectionCursor(binding, makeVersionedCursor(binding, 999)),
      'cursor-version-unsupported',
    );
    await assertCursorCode(
      () => decodeCollectionCursor(binding, 'A'.repeat(4097)),
      'cursor-too-large',
    );
  });

  it('rejects a cursor sealed with a previous rotated secret', async () => {
    const cursor = await encodeCollectionCursor(binding, TEST_START_KEY);
    process.env.WORK_ENGINE_PORTAL_SECRET = 'synthetic-collection-cursor-rotated-secret';
    try {
      await assertCursorCode(
        () => decodeCollectionCursor(binding, cursor),
        'cursor-tampered-or-malformed',
      );
    } finally {
      process.env.WORK_ENGINE_PORTAL_SECRET = TEST_SECRET;
    }
  });

  it('accepts the default and maximum limits but rejects malformed and out-of-range limits', async () => {
    assert.strictEqual(parseCollectionLimit(undefined), 100);
    assert.strictEqual(parseCollectionLimit(''), 100);
    assert.strictEqual(parseCollectionLimit('200'), 200);

    for (const invalid of [undefined, null, 1, '0', '-1', '01', '1e2', '100.0', ' 1', '1 ']) {
      if (invalid === undefined || invalid === null) continue;
      await assert.rejects(
        async () => parseCollectionLimit(invalid),
        (error: unknown) => error instanceof CollectionCursorError
          && error.code === 'invalid-limit'
          && error.message === 'Invalid pagination input',
      );
    }
    await assertCursorCode(
      async () => parseCollectionLimit('201'),
      'limit-out-of-range',
    );
  });
});
