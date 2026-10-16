import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { handler } from '../src/handler';
import { getClient } from '../src/db/client';
import { startLocal, stopLocal, TABLE_SECRETS, TABLE_AUDIT_EVENTS } from '../scripts/local-dynamodb';
import { createTables } from '../scripts/local-dynamodb';
import { createUserWithId } from '../src/db/users';
import { truncateTestTables } from './helpers/db';
import type { LambdaResponse } from '../src/types';

function invoke(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<LambdaResponse> {
  const event = {
    httpMethod: method,
    path,
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : null,
    headers: headers || {},
  };
  return handler(event, {});
}

const ADMIN_ID = 'secrets-admin-0001';
const OPERATOR_ID = 'secrets-operator-01';
const adminHeaders = { 'x-user-id': ADMIN_ID };
const operatorHeaders = { 'x-user-id': OPERATOR_ID };

/** A value distinctive enough that a substring leak check is meaningful. */
const MARKER_PASSWORD = 's3cr3t-MARKER-9f8e7d6c5b4a';
const AIRTABLE_FIELDS: Record<string, string> = {
  username: 'ops@datatalks.club',
  password: MARKER_PASSWORD,
  url: 'https://airtable.com',
};

describe('API — Secrets store', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    await createUserWithId(client, ADMIN_ID, { name: 'Admin', email: 'admin@datatalks.club', role: 'admin' });
    await createUserWithId(client, OPERATOR_ID, { name: 'Op', email: 'op@datatalks.club', role: 'operator' });
  });

  afterEach(async () => {
    await truncateTestTables(client);
    // truncateTestTables wipes the seeded users too; restore them.
    await createUserWithId(client, ADMIN_ID, { name: 'Admin', email: 'admin@datatalks.club', role: 'admin' });
    await createUserWithId(client, OPERATOR_ID, { name: 'Op', email: 'op@datatalks.club', role: 'operator' });
  });

  async function seedAirtable(): Promise<void> {
    const res = await invoke('PUT', '/api/secrets/airtable', { fields: AIRTABLE_FIELDS }, adminHeaders);
    assert.strictEqual(res.statusCode, 200);
  }

  describe('admin round trip', () => {
    it('PUT stores a secret and returns metadata without values', async () => {
      const res = await invoke('PUT', '/api/secrets/airtable', { fields: AIRTABLE_FIELDS }, adminHeaders);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.secret.name, 'airtable');
      assert.deepStrictEqual(body.secret.fields, ['password', 'url', 'username']);
      assert.strictEqual(body.secret.createdBy, ADMIN_ID);
      assert.strictEqual(body.secret.updatedBy, ADMIN_ID);
      assert.strictEqual(res.body.includes(MARKER_PASSWORD), false);
    });

    it('GET returns the decrypted fields', async () => {
      await seedAirtable();
      const res = await invoke('GET', '/api/secrets/airtable', undefined, adminHeaders);
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.secret.fields.username, AIRTABLE_FIELDS.username);
      assert.strictEqual(body.secret.fields.password, MARKER_PASSWORD);
      assert.strictEqual(body.secret.fields.url, AIRTABLE_FIELDS.url);
    });

    it('GET list shows names and field names, never values', async () => {
      await seedAirtable();
      const res = await invoke('GET', '/api/secrets', undefined, adminHeaders);
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.deepStrictEqual(body.secrets.map((s: { name: string }) => s.name), ['airtable']);
      assert.deepStrictEqual(body.secrets[0].fields, ['password', 'url', 'username']);
      assert.strictEqual(res.body.includes(MARKER_PASSWORD), false);
    });

    it('PUT replaces the whole field set and preserves createdAt', async () => {
      await seedAirtable();
      const first = JSON.parse((await invoke('GET', '/api/secrets/airtable', undefined, adminHeaders)).body).secret;
      const res = await invoke('PUT', '/api/secrets/airtable', { fields: { username: 'only' } }, adminHeaders);
      assert.strictEqual(res.statusCode, 200);
      const second = JSON.parse((await invoke('GET', '/api/secrets/airtable', undefined, adminHeaders)).body).secret;
      assert.deepStrictEqual(second.fields, { username: 'only' });
      assert.strictEqual(second.createdAt, first.createdAt);
      assert.strictEqual(second.createdBy, first.createdBy);
    });

    it('DELETE removes the secret and a second delete 404s', async () => {
      await seedAirtable();
      const res = await invoke('DELETE', '/api/secrets/airtable', undefined, adminHeaders);
      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(JSON.parse(res.body), { deleted: true, name: 'airtable' });
      const gone = await invoke('GET', '/api/secrets/airtable', undefined, adminHeaders);
      assert.strictEqual(gone.statusCode, 404);
      const again = await invoke('DELETE', '/api/secrets/airtable', undefined, adminHeaders);
      assert.strictEqual(again.statusCode, 404);
    });

    it('GET of an unknown secret 404s without leaking anything', async () => {
      const res = await invoke('GET', '/api/secrets/nope', undefined, adminHeaders);
      assert.strictEqual(res.statusCode, 404);
    });
  });

  describe('admin-only', () => {
    it('operator gets 403 on every route', async () => {
      for (const [method, path] of [
        ['GET', '/api/secrets'],
        ['PUT', '/api/secrets/airtable'],
        ['GET', '/api/secrets/airtable'],
        ['DELETE', '/api/secrets/airtable'],
        ['GET', '/api/secrets/airtable/audit'],
      ] as const) {
        const res = await invoke(method, path, method === 'PUT' ? { fields: { username: 'x' } } : undefined, operatorHeaders);
        assert.strictEqual(res.statusCode, 403, `${method} ${path}`);
        assert.strictEqual(JSON.parse(res.body).error, 'Admin access required');
      }
    });

    it('an unknown actor id gets 403', async () => {
      const res = await invoke('GET', '/api/secrets', undefined, { 'x-user-id': 'not-a-user' });
      assert.strictEqual(res.statusCode, 403);
    });

    it('no actor at all gets 403', async () => {
      const res = await invoke('GET', '/api/secrets', undefined, {});
      assert.strictEqual(res.statusCode, 403);
    });
  });

  describe('values never appear at rest, in lists, or in audit records', () => {
    it('the stored item holds only ciphertext', async () => {
      await seedAirtable();
      const scan = await client.send(new ScanCommand({ TableName: TABLE_SECRETS }));
      const items = scan.Items || [];
      assert.strictEqual(items.length, 1);
      const data = String(items[0].data);
      assert.strictEqual(data.includes(MARKER_PASSWORD), false, 'plaintext found in stored item');
      assert.strictEqual(data.includes(AIRTABLE_FIELDS.username), false, 'plaintext username found in stored item');
      // And it round-trips through the same cipher configuration.
      const got = await invoke('GET', '/api/secrets/airtable', undefined, adminHeaders);
      assert.strictEqual(JSON.parse(got.body).secret.fields.password, MARKER_PASSWORD);
    });

    it('audit events record who, when, which secret — never values', async () => {
      await seedAirtable();
      await invoke('GET', '/api/secrets/airtable', undefined, adminHeaders);
      await invoke('GET', '/api/secrets', undefined, adminHeaders);
      const auditScan = await client.send(new ScanCommand({ TableName: TABLE_AUDIT_EVENTS }));
      for (const item of auditScan.Items || []) {
        assert.strictEqual(JSON.stringify(item).includes(MARKER_PASSWORD), false);
        assert.strictEqual(JSON.stringify(item).includes(AIRTABLE_FIELDS.username), false);
      }
      const res = await invoke('GET', '/api/secrets/airtable/audit', undefined, adminHeaders);
      assert.strictEqual(res.statusCode, 200);
      const events = JSON.parse(res.body).events;
      const actions = events.map((e: { action: string }) => e.action);
      assert.ok(actions.includes('write'));
      assert.ok(actions.includes('read'));
      const write = events.find((e: { action: string }) => e.action === 'write');
      assert.strictEqual(write.actorId, ADMIN_ID);
      assert.deepStrictEqual([...write.fields].sort(), ['password', 'url', 'username']);
      assert.strictEqual(res.body.includes(MARKER_PASSWORD), false);
    });

    it('input errors name the problem without echoing values', async () => {
      const res = await invoke('PUT', '/api/secrets/airtable', { fields: { password: MARKER_PASSWORD, 'bad key': 'x' } }, adminHeaders);
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.body.includes(MARKER_PASSWORD), false);
    });
  });

  describe('validation', () => {
    it('rejects invalid names', async () => {
      // An empty name routes to the collection (405 there), so it is not a name case.
      for (const name of ['UPPER', 'has space', 'slash%2Fs', '-lead', 'a'.repeat(65)]) {
        const res = await invoke('PUT', `/api/secrets/${encodeURIComponent(name)}`, { fields: { a: 'b' } }, adminHeaders);
        assert.strictEqual(res.statusCode, 400, `name '${name}'`);
      }
    });

    it('rejects bad bodies', async () => {
      for (const body of [null, 'not-json', [], {}, { fields: {} }, { fields: { a: 5 } }, { fields: { '9bad': 'x' } }, { extra: 1, fields: { a: 'b' } }]) {
        const res = await invoke('PUT', '/api/secrets/airtable', body as unknown, adminHeaders);
        assert.strictEqual(res.statusCode, 400, `body ${JSON.stringify(body)}`);
      }
    });

    it('rejects oversized payloads', async () => {
      const big = 'x'.repeat(5000);
      const res = await invoke('PUT', '/api/secrets/airtable', { fields: { note: big } }, adminHeaders);
      assert.strictEqual(res.statusCode, 400);
    });

    it('allows every accepted name shape', async () => {
      for (const name of ['airtable', 'a1', 'svc.mail-router', 'under_score', 'dotted.name-2']) {
        const res = await invoke('PUT', `/api/secrets/${name}`, { fields: { a: 'b' } }, adminHeaders);
        assert.strictEqual(res.statusCode, 200, name);
      }
    });
  });

});
