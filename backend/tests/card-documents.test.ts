import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../src/db/client';
import { TABLE_CARDS, TABLE_USERS } from '../src/db/tableNames';
import { startLocal, stopLocal, createTables } from '../scripts/local-dynamodb';
import { handleCardDocumentRoutes } from '../src/routes/cardDocuments';
import { getDocument } from '../src/db/documents';
import { handleDocumentReviewRoutes } from '../src/documents/reviews';
import { createDocumentReviewer } from '../src/db/documentReviews';
import { createCardDocument, updateCardDocument, CardDocumentVersionConflict } from '../src/db/cardDocuments';

describe('Staff-only card documents', () => {
  let client: DynamoDBDocumentClient;
  before(async () => {
    process.env.SKIP_AUTH = 'true'; client = await getClient(await startLocal()); await createTables(client);
    for (const id of ['webinar', 'workshop', 'q-and-a']) await client.send(new PutCommand({ TableName: TABLE_CARDS, Item: { PK: `CARD#${id}`, SK: `CARD#${id}`, id, version: 1, title: id, status: 'active', stage: 'preparation', taskCount: 0, openTaskCount: 0, templateId: id, templateVersion: 1, templateDefinitionSnapshot: { taskRefs: [] }, selectedOptionalGroups: [] } }));
  });
  after(async () => { await stopLocal(); });
  async function request(method: string, suffix = '', body?: unknown, queryStringParameters?: Record<string, string>, headers?: Record<string, string>) {
    const res = await handleCardDocumentRoutes({ httpMethod: method, path: `/api/card-documents${suffix}`, body: body === undefined ? undefined : JSON.stringify(body), queryStringParameters, headers }, client);
    assert.ok(res); return res;
  }
  it('creates and edits private documents attached to each event card, with scoped listings', async () => {
    for (const cardId of ['webinar', 'workshop', 'q-and-a']) {
      const result = await request('POST', '', { cardId, kind: 'note', title: 'Private host notes', content: 'Staff café — こんにちは\nNext step' });
      assert.equal(result.statusCode, 201);
      const doc = JSON.parse(result.body).document;
      assert.equal(doc.cardId, cardId);
      assert.equal((await request('PUT', `/${doc.id}`, { title: doc.title, content: 'Edited privately', version: 1 })).statusCode, 200);
      assert.equal((await request('PUT', `/${doc.id}`, { title: doc.title, content: 'Stale', version: 1 })).statusCode, 409);
      const listed = JSON.parse((await request('GET', '', undefined, { cardId })).body).documents;
      assert.equal(listed.length, 1); assert.equal(listed[0].content, 'Edited privately');
      assert.equal(await getDocument(client, doc.id), null, 'guest-review document loader cannot see card docs');
      const { token } = await createDocumentReviewer(client, doc.id, 'Unrelated guest');
      const review = await handleDocumentReviewRoutes({ httpMethod: 'GET', path: `/api/documents/${doc.id}/review`, headers: { 'x-document-review-token': token } }, client, id => getDocument(client, id));
      assert.equal(review?.statusCode, 404);
    }
  });
  it('rejects guest codes and review tokens on every data operation', async () => {
    const doc = await createCardDocument(client, { cardId: 'webinar', kind: 'note', title: 'Secret', content: 'Private' });
    delete process.env.SKIP_AUTH;
    try {
      for (const [method, suffix] of [['GET', ''], ['GET', `/${doc.id}`], ['GET', `/${doc.id}/export`], ['POST', ''], ['PUT', `/${doc.id}`], ['DELETE', `/${doc.id}`]]) {
        const result = await request(method, suffix, { cardId: 'webinar', title: 'Secret', content: '', kind: 'note', version: 1, code: 'guest-code' }, { cardId: 'webinar', code: 'guest-code', version: '1' }, { 'x-sponsor-doc-code': 'guest-code', 'x-document-review-token': 'review-token' });
        assert.equal(result.statusCode, 401, `${method} ${suffix}`);
      }
    } finally { process.env.SKIP_AUTH = 'true'; }
  });
  it('validates input and rejects disabled or unsupported identities', async () => {
    const body = { cardId: 'webinar', kind: 'note', title: 'Host', content: '' };
    for (const patch of [{ title: ' ' }, { content: '😀'.repeat(62501) }, { kind: 'unknown' }, { cardId: '' }]) {
      assert.equal((await request('POST', '', { ...body, ...patch })).statusCode, 400);
    }
    assert.equal((await request('GET')).statusCode, 400);
    assert.equal((await request('GET', '/missing')).statusCode, 404);
    delete process.env.SKIP_AUTH;
    try {
      for (const [id, role, disabled, status] of [['disabled', 'admin', true, 401], ['unsupported', 'viewer', false, 403]] as const) {
        await client.send(new PutCommand({ TableName: TABLE_USERS, Item: { PK: `USER#${id}`, SK: `USER#${id}`, id, role, disabled } }));
        assert.equal((await request('GET', '', undefined, { cardId: 'webinar' }, { 'x-user-id': id })).statusCode, status);
      }
    } finally { process.env.SKIP_AUTH = 'true'; }
  });
  it('copies without sharing identity, exports saved content, and enforces deletion versions', async () => {
    const doc = await createCardDocument(client, { cardId: 'workshop', kind: 'note', title: 'Host', content: 'Café\nPrivate' });
    const copied = JSON.parse((await request('POST', '', { cardId: 'q-and-a', from: doc.id })).body).document;
    assert.notEqual(copied.id, doc.id); assert.equal(copied.content, doc.content);
    for (const format of ['md', 'txt', 'docx']) {
      const result = await request('GET', `/${doc.id}/export`, undefined, { format });
      assert.equal(result.statusCode, 200);
      if (format === 'docx') assert.equal(Buffer.from(result.body, 'base64').subarray(0, 2).toString(), 'PK');
      else assert.equal(result.body, doc.content);
    }
    assert.equal((await request('DELETE', `/${doc.id}`, undefined, { version: '2' })).statusCode, 409);
    assert.equal((await request('DELETE', `/${doc.id}`, undefined, { version: '1' })).statusCode, 200);
    assert.equal((await request('GET', `/${doc.id}`)).statusCode, 404);
  });
  it('does not lose concurrent edits and hides documents whose owning card was removed', async () => {
    const doc = await createCardDocument(client, { cardId: 'q-and-a', kind: 'note', title: 'Host', content: '' });
    const results = await Promise.allSettled(['A', 'B'].map(content => updateCardDocument(client, doc.id, { title: doc.title, content }, 1)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.ok(results.some(r => r.status === 'rejected' && r.reason instanceof CardDocumentVersionConflict));
    await client.send(new DeleteCommand({ TableName: TABLE_CARDS, Key: { PK: 'CARD#q-and-a', SK: 'CARD#q-and-a' } }));
    assert.equal((await request('GET', `/${doc.id}`)).statusCode, 404);
    assert.equal((await request('POST', '', { cardId: 'missing', kind: 'note', title: 'No', content: '' })).statusCode, 404);
  });
});
