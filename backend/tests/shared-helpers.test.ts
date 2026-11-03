import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanItem, cleanRequiredItem } from '../src/db/cleanItem';
import {
  json,
  jsonResponse,
  noStoreJson,
  parseJsonBody,
  parseJsonEvent,
  parseJsonObjectBody,
  parseJsonObjectBodyOrEmpty,
  parseJsonObjectEvent,
  parseJsonObjectEventOrEmpty,
} from '../src/http';
import { isDict, isRecord } from '../src/records';

describe('shared helpers (intake 96e9567a AC4)', () => {
  it('isRecord and isDict accept plain objects and reject null, arrays, and primitives', () => {
    assert.equal(isRecord({ a: 1 }), true);
    assert.equal(isDict({}), true);
    assert.equal(isRecord(null), false);
    assert.equal(isRecord(undefined), false);
    assert.equal(isRecord([1, 2]), false);
    assert.equal(isRecord('str'), false);
    assert.equal(isRecord(42), false);
  });

  it('cleanItem and cleanRequiredItem strip PK and SK while preserving other attributes', () => {
    assert.equal(cleanItem(undefined), null);
    assert.deepEqual(cleanItem({ PK: 'A#1', SK: 'A#1', id: '1', name: 'Test' }), {
      id: '1',
      name: 'Test',
    });
    assert.deepEqual(cleanRequiredItem({ PK: 'B#2', SK: 'B#2', id: '2', count: 0 }), {
      id: '2',
      count: 0,
    });
  });

  it('json, jsonResponse, and noStoreJson preserve their distinct header and body contracts', () => {
    const plain = json(200, { ok: true });
    assert.deepEqual(plain, {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: '{"ok":true}',
    });

    const passthrough = jsonResponse(200, '{"pre":"serialized"}');
    assert.equal(passthrough.body, '{"pre":"serialized"}');
    assert.equal(jsonResponse(201, { created: 1 }).body, '{"created":1}');

    const noStore = noStoreJson(200, { secret: false });
    assert.deepEqual(noStore, {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: '{"secret":false}',
    });
  });

  it('parseBody behaviour groups preserve missing-body, array, and invalid-JSON semantics', () => {
    // Group A: requires non-empty plain object
    assert.equal(parseJsonObjectBody(null), null);
    assert.equal(parseJsonObjectBody(''), null);
    assert.equal(parseJsonObjectBody('[]'), null);
    assert.equal(parseJsonObjectBody('"str"'), null);
    assert.equal(parseJsonObjectBody('{bad'), null);
    assert.deepEqual(parseJsonObjectBody('{"a":1}'), { a: 1 });
    assert.deepEqual(parseJsonObjectEvent({ body: '{"x":2}' } as any), { x: 2 });

    // Group B: defaults missing/empty to {}, rejects arrays/primitives/invalid JSON
    assert.deepEqual(parseJsonObjectBodyOrEmpty(null), {});
    assert.deepEqual(parseJsonObjectBodyOrEmpty(''), {});
    assert.equal(parseJsonObjectBodyOrEmpty('[]'), null);
    assert.equal(parseJsonObjectBodyOrEmpty('"str"'), null);
    assert.equal(parseJsonObjectBodyOrEmpty('{bad'), null);
    assert.deepEqual(parseJsonObjectBodyOrEmpty('{"a":1}'), { a: 1 });
    assert.deepEqual(parseJsonObjectEventOrEmpty({ body: undefined } as any), {});

    // Group C: returns null on missing/invalid JSON without filtering parsed values
    assert.equal(parseJsonBody(null), null);
    assert.equal(parseJsonBody('{bad'), null);
    assert.deepEqual(parseJsonBody('{"a":1}'), { a: 1 });
    assert.deepEqual(parseJsonEvent({ body: '[1,2]' } as any), [1, 2]);
  });
});
