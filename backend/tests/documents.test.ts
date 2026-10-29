import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../src/db/client';
import { TABLE_TASKS, TABLE_ARTIFACTS } from '../src/db/tableNames';
import { startLocal, stopLocal, createTables } from '../scripts/local-dynamodb';
import { handleDocumentRoutes } from '../src/routes/documents';
import { createDocument, updateDocument, DocumentVersionConflict, listDocuments } from '../src/db/documents';

describe('Task document workspace', () => {
  let client: DynamoDBDocumentClient;
  before(async () => { process.env.SKIP_AUTH = 'true'; client = await getClient(await startLocal()); await createTables(client); await client.send(new PutCommand({ TableName: TABLE_TASKS, Item: { PK: 'TASK#doc-task', SK: 'TASK#doc-task', id: 'doc-task', version: 1, taskHistory: [] } })); });
  after(async () => { await stopLocal(); });
  async function request(method: string, path: string, body?: unknown, queryStringParameters?: Record<string, string>) {
    const res = await handleDocumentRoutes({ httpMethod: method, path, body: body === undefined ? undefined : JSON.stringify(body), queryStringParameters }, client);
    assert.ok(res);
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }
  it('creates all document kinds on a task and retains multiline Unicode content across saves', async () => {
    for (const kind of ['transcript', 'timecodes', 'summary', 'note']) {
      const content = '00:00 Intro\n00:12 café — こんにちは\n\nSummary';
      const created = await request('POST', '/api/documents', { taskId: 'doc-task', kind, title: kind, content });
      assert.equal(created.status, 201);
      const doc = created.body.document;
      assert.equal(doc.content, content);
      assert.equal((await request('PUT', `/api/documents/${doc.id}`, { title: 'Reviewed', content: content + '\nGuest edit', version: 1 })).status, 200);
      assert.equal((await request('PUT', `/api/documents/${doc.id}`, { title: 'Stale', content: 'lost edit', version: 1 })).status, 409);
      const saved = (await request('GET', `/api/documents/${doc.id}`)).body.document;
      assert.equal(saved.version, 2); assert.equal(saved.content, content + '\nGuest edit');
      assert.equal(saved.taskId, 'doc-task');
    }
    const listed = await request('GET', '/api/documents', undefined, { taskId: 'doc-task' });
    assert.equal(listed.body.documents.length, 4);
  });
  it('does not create orphan or oversized documents and requires a bounded task query', async () => {
    const body = { taskId: 'missing', kind: 'summary', title: 'Title', content: '' };
    assert.equal((await request('POST', '/api/documents', body)).status, 404);
    assert.equal((await request('POST', '/api/documents', { ...body, taskId: 'doc-task', kind: 'unknown' })).status, 400);
    assert.equal((await request('POST', '/api/documents', { ...body, content: '😀'.repeat(62501) })).status, 400);
    assert.equal((await request('GET', '/api/documents')).status, 400);
    assert.equal((await request('GET', '/api/documents/no-such-doc')).status, 404);
  });
  it('copies content to another document without copying review identity or version', async () => {
    const source = await createDocument(client, { taskId: 'doc-task', kind: 'summary', title: 'Original', content: 'Summary text' });
    const result = await request('POST', '/api/documents', { taskId: 'doc-task', from: source.id, title: 'Copy' });
    assert.equal(result.status, 201); assert.notEqual(result.body.document.id, source.id);
    assert.equal(result.body.document.content, source.content); assert.equal(result.body.document.version, 1);
  });
  it('allows exactly one concurrent writer at a version', async () => {
    const doc = await createDocument(client, { taskId: 'doc-task', kind: 'note', title: 'Concurrent', content: '' });
    const results = await Promise.allSettled(['A', 'B'].map(content => updateDocument(client, doc.id, { title: doc.title, content }, 1)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.ok(results.some(r => r.status === 'rejected' && r.reason instanceof DocumentVersionConflict));
  });
  it('does not include artifact records in document listings', async () => {
    await client.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: { PK: 'ARTIFACT#fake', SK: 'ARTIFACT#fake', taskId: 'doc-task' } }));
    assert.ok((await listDocuments(client, 'doc-task')).every(doc => doc.id && doc.content !== undefined));
  });
});
