import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { handler } from '../src/handler';
import { getClient } from '../src/db/client';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { startLocal, stopLocal, createTables } from '../scripts/local-dynamodb';
import { createUserWithId } from '../src/db/users';
import { truncateTestTables } from './helpers/db';
import type { LambdaResponse } from '../src/types';

function invoke(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
  query?: Record<string, string>,
): Promise<LambdaResponse> {
  const event = {
    httpMethod: method,
    path,
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : null,
    headers: headers || {},
    queryStringParameters: query || null,
  };
  return handler(event, {});
}

const ADMIN_ID = 'texttpl-admin-0001';
const OPERATOR_ID = 'texttpl-operator-01';
const adminHeaders = { 'x-user-id': ADMIN_ID };
const operatorHeaders = { 'x-user-id': OPERATOR_ID };

const BODY = 'Hi <RECIPIENT_NAME>,\n\nAlexey is out until <RETURN_DATE>. See <B>bold</B> tags stay.';

describe('API — generic text templates (/api/text-templates)', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    await createUserWithId(client, ADMIN_ID, { name: 'Admin', email: 'admin@datatalks.club', role: 'admin' });
    await createUserWithId(client, OPERATOR_ID, { name: 'Orin', email: 'orin@datatalks.club', role: 'operator' });
  });

  afterEach(async () => {
    await truncateTestTables(client);
    await createUserWithId(client, ADMIN_ID, { name: 'Admin', email: 'admin@datatalks.club', role: 'admin' });
    await createUserWithId(client, OPERATOR_ID, { name: 'Orin', email: 'orin@datatalks.club', role: 'operator' });
  });

  after(async () => {
    await stopLocal();
  });

  it('starts at version 0 with no templates and lets any actor read', async () => {
    const res = await invoke('GET', '/api/text-templates', undefined, operatorHeaders);
    assert.equal(res.statusCode, 200);
    const record = JSON.parse(res.body);
    assert.equal(record.version, 0);
    assert.deepEqual(record.templates, []);
  });

  it('rejects mutations from non-admin actors', async () => {
    const create = await invoke('POST', '/api/text-templates', {
      id: 'reply.out-of-office', title: 'Out of office', body: 'Hi <NAME>', expectedVersion: 0,
    }, operatorHeaders);
    assert.equal(create.statusCode, 403);

    const del = await invoke('DELETE', '/api/text-templates/reply.out-of-office?expectedVersion=0', undefined, operatorHeaders);
    assert.equal(del.statusCode, 403);
  });

  it('creates a template, deriving placeholders from the body', async () => {
    const res = await invoke('POST', '/api/text-templates', {
      id: 'reply.out-of-office',
      title: 'Out of office',
      body: BODY,
      description: 'Used when Alexey is travelling',
      expectedVersion: 0,
    }, adminHeaders);
    assert.equal(res.statusCode, 201);
    const { template, version } = JSON.parse(res.body);
    assert.equal(template.id, 'reply.out-of-office');
    assert.deepEqual(template.placeholders, ['RECIPIENT_NAME', 'RETURN_DATE']);
    assert.equal(version, 1);
    assert.equal(template.updatedBy, ADMIN_ID);
  });

  it('rejects invalid ids and bodies', async () => {
    const badId = await invoke('POST', '/api/text-templates', {
      id: 'bad id!', title: 'x', body: 'y', expectedVersion: 0,
    }, adminHeaders);
    assert.equal(badId.statusCode, 400);

    const noBody = await invoke('POST', '/api/text-templates', {
      id: 'reply.x', title: 'x', expectedVersion: 0,
    }, adminHeaders);
    assert.equal(noBody.statusCode, 400);

    const noVersion = await invoke('POST', '/api/text-templates', {
      id: 'reply.x', title: 'x', body: 'y',
    }, adminHeaders);
    assert.equal(noVersion.statusCode, 400);
  });

  it('refuses duplicate ids and unknown updates', async () => {
    const create = await invoke('POST', '/api/text-templates', {
      id: 'reply.a', title: 'A', body: 'a <X>', expectedVersion: 0,
    }, adminHeaders);
    assert.equal(create.statusCode, 201);

    const duplicate = await invoke('POST', '/api/text-templates', {
      id: 'reply.a', title: 'A2', body: 'b', expectedVersion: 1,
    }, adminHeaders);
    assert.equal(duplicate.statusCode, 409);
    assert.match(JSON.parse(duplicate.body).error, /already exists/);

    const missingUpdate = await invoke('PUT', '/api/text-templates/reply.missing', {
      title: 'A2', expectedVersion: 1,
    }, adminHeaders);
    assert.equal(missingUpdate.statusCode, 404);
  });

  it('shows and lists templates', async () => {
    await invoke('POST', '/api/text-templates', {
      id: 'reply.a', title: 'A', body: 'a <X>', expectedVersion: 0,
    }, adminHeaders);
    const one = await invoke('GET', '/api/text-templates/reply.a', undefined, operatorHeaders);
    assert.equal(one.statusCode, 200);
    assert.equal(JSON.parse(one.body).template.placeholders.join(','), 'X');

    const missing = await invoke('GET', '/api/text-templates/reply.zzz', undefined, operatorHeaders);
    assert.equal(missing.statusCode, 404);

    const list = await invoke('GET', '/api/text-templates', undefined, operatorHeaders);
    assert.equal(JSON.parse(list.body).templates.length, 1);
  });

  it('updates a template with optimistic concurrency', async () => {
    await invoke('POST', '/api/text-templates', {
      id: 'reply.a', title: 'A', body: 'a <X>', expectedVersion: 0,
    }, adminHeaders);

    const conflict = await invoke('PUT', '/api/text-templates/reply.a', {
      title: 'A2', expectedVersion: 0,
    }, adminHeaders);
    assert.equal(conflict.statusCode, 409);
    assert.equal(JSON.parse(conflict.body).code, 'version_conflict');
    assert.equal(JSON.parse(conflict.body).current.version, 1);

    const ok = await invoke('PUT', '/api/text-templates/reply.a', {
      title: 'A2', expectedVersion: 1,
    }, adminHeaders);
    assert.equal(ok.statusCode, 200);
    const updated = JSON.parse(ok.body);
    assert.equal(updated.template.title, 'A2');
    assert.equal(updated.template.body, 'a <X>');
    assert.equal(updated.version, 2);
  });

  it('renders values into placeholders and reports missing and unused', async () => {
    await invoke('POST', '/api/text-templates', {
      id: 'reply.a', title: 'A', body: 'Hello <NAME>, see <B>bold</B> (<EXTRA> kept).', expectedVersion: 0,
    }, adminHeaders);

    const rendered = await invoke('POST', '/api/text-templates/reply.a/render', {
      values: { NAME: 'Anna', EXTRA: 'x', SPARE: 'y' },
    }, operatorHeaders);
    assert.equal(rendered.statusCode, 200);
    const body = JSON.parse(rendered.body);
    assert.equal(body.text, 'Hello Anna, see <B>bold</B> (x kept).');
    assert.deepEqual(body.unused, ['SPARE']);

    const missing = await invoke('POST', '/api/text-templates/reply.a/render', {
      values: { NAME: 'Anna' },
    }, operatorHeaders);
    assert.equal(missing.statusCode, 400);
    assert.deepEqual(JSON.parse(missing.body).missing, ['EXTRA']);

    const absent = await invoke('POST', '/api/text-templates/reply.absent/render', { values: {} }, operatorHeaders);
    assert.equal(absent.statusCode, 404);
  });

  it('deletes a template with the record version', async () => {
    await invoke('POST', '/api/text-templates', {
      id: 'reply.a', title: 'A', body: 'a', expectedVersion: 0,
    }, adminHeaders);

    const conflict = await invoke('DELETE', '/api/text-templates/reply.a', undefined, adminHeaders, { expectedVersion: '0' });
    assert.equal(conflict.statusCode, 409);

    const ok = await invoke('DELETE', '/api/text-templates/reply.a', undefined, adminHeaders, { expectedVersion: '1' });
    assert.equal(ok.statusCode, 200);
    assert.equal(JSON.parse(ok.body).deleted, 'reply.a');

    const again = await invoke('DELETE', '/api/text-templates/reply.a', undefined, adminHeaders, { expectedVersion: '2' });
    assert.equal(again.statusCode, 404);
  });
});
