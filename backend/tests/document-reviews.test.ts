import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { useTestDatabase } from './helpers/db';
import { TABLE_TASKS, TABLE_ARTIFACTS } from '../src/db/tableNames';
import { deleteDocumentThread, createDocumentReviewer, verifyDocumentReviewer, revokeDocumentReviewer, listDocumentReviewers, createDocumentThread, changeDocumentThread, listDocumentThreads } from '../src/db/documentReviews';
import { handleDocumentReviewRoutes, isAnonymousDocumentReviewRequest } from '../src/documents/reviews';
const staff = { id: 'staff', name: 'Staff', kind: 'staff' as const };
test('review tokens are scoped, hashed, expiring and revocable; listings never expose secrets', async () => {
  const { client } = await useTestDatabase();
  const { reviewer, token } = await createDocumentReviewer(client, 'doc-a', 'Guest');
  assert.equal((await verifyDocumentReviewer(client, 'doc-a', token))?.name, 'Guest');
  assert.equal(await verifyDocumentReviewer(client, 'doc-b', token), null);
  assert.equal(await verifyDocumentReviewer(client, 'doc-a', token.slice(0, -2) + 'xx'), null);
  assert.deepEqual(await listDocumentReviewers(client, 'doc-a'), [reviewer]);
  await revokeDocumentReviewer(client, 'doc-a', reviewer.id);
  assert.equal(await verifyDocumentReviewer(client, 'doc-a', token), null);
  await client.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: { PK: 'DOCUMENT_REVIEW#doc-a', SK: `REVIEWER#${reviewer.id}`, ...reviewer, expiresAt: '2000-01-01', tokenHash: createHash('sha256').update(token).digest('hex') } }));
  assert.equal(await verifyDocumentReviewer(client, 'doc-a', token), null);
  await client.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: { PK: 'DOCUMENT_REVIEW#doc-a', SK: `REVIEWER#${reviewer.id}`, ...reviewer, expiresAt: 'invalid', tokenHash: createHash('sha256').update(token).digest('hex') } }));
  assert.equal(await verifyDocumentReviewer(client, 'doc-a', token), null);
});
test('threads preserve attribution, replies and resolution; stale writes cannot lose replies', async () => {
  const { client } = await useTestDatabase();
  const thread = await createDocumentThread(client, 'thread-doc', staff, 'Please check this', 'Quoted sentence');
  const reply = await changeDocumentThread(client, 'thread-doc', thread.id, { id: 'guest', name: 'Guest', kind: 'reviewer' }, { body: 'Checked', version: 1 });
  assert.equal(reply.posts.length, 2);
  assert.equal(reply.posts[1].author.name, 'Guest');
  await assert.rejects(changeDocumentThread(client, 'thread-doc', thread.id, staff, { body: 'Lost?', version: 1 }), /refresh/);
  const resolved = await changeDocumentThread(client, 'thread-doc', thread.id, staff, { resolved: true, version: 2 });
  assert.equal(resolved.resolved, true);
  await assert.rejects(changeDocumentThread(client, 'thread-doc', thread.id, staff, { body: 'Late', version: 3 }), /Reopen/);
  const reopened = await changeDocumentThread(client, 'thread-doc', thread.id, staff, { resolved: false, version: 3 });
  assert.equal(reopened.resolved, false);
  assert.deepEqual(await listDocumentThreads(client, 'other-doc'), []);
  await assert.rejects(createDocumentThread(client, 'thread-doc', staff, ' '.repeat(5)), /Comment/);
  await assert.rejects(changeDocumentThread(client, 'other-doc', thread.id, staff, { resolved: true, version: 1 }), /not found/);
});
test('review API allows document read/comments but never reviewer management; deleted docs inaccessible', async () => {
  const { client } = await useTestDatabase();
  const { token } = await createDocumentReviewer(client, 'api-doc', 'Reviewer');
  const load = async () => ({ id: 'api-doc', title: 'Title', content: 'Body', version: 1, updatedAt: 'today', taskId: 'private-task' });
  const request = (path: string, method = 'GET', body?: unknown) => handleDocumentReviewRoutes({ path: `/api/documents/api-doc/${path}`, httpMethod: method, headers: { 'x-document-review-token': token }, body: JSON.stringify(body) }, client, load);
  const read = await request('review');
  assert.equal(read?.statusCode, 200);
  assert.equal(JSON.parse(read!.body).document.taskId, undefined);
  assert.equal((await request('reviewers', 'POST', { name: 'Intruder' }))?.statusCode, 403);
  const comment = await request('comments', 'POST', { body: 'Review comment', author: staff });
  assert.equal(comment?.statusCode, 201);
  assert.equal(JSON.parse(comment!.body).thread.posts[0].author.kind, 'reviewer');
  assert.equal((await request('review', 'PUT', { content: 'overwrite' }))?.statusCode, 405);
  assert.equal((await handleDocumentReviewRoutes({ path: '/api/documents/api-doc/review', httpMethod: 'GET', headers: { 'x-document-review-token': token } }, client, async () => null))?.statusCode, 404);
  assert.equal(isAnonymousDocumentReviewRequest('PUT', '/api/documents/api-doc'), false);
  assert.equal(isAnonymousDocumentReviewRequest('POST', '/api/documents/api-doc/reviewers'), false);
});
test('Unicode thread growth fails before DynamoDB item size limit', async () => {
  const { client } = await useTestDatabase();
  const thread = await createDocumentThread(client, 'unicode-doc', staff, 'Start');
  thread.posts = Array.from({ length: 60 }, (_, n) => ({ id: String(n), author: staff, body: '界'.repeat(1600), createdAt: 'today' }));
  await client.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: { PK: 'DOCUMENT_REVIEW#unicode-doc', SK: `THREAD#${thread.id}`, ...thread } }));
  await assert.rejects(changeDocumentThread(client, 'unicode-doc', thread.id, staff, { version: 1, body: '界'.repeat(2000) }), /Thread is full/);
  assert.equal((await listDocumentThreads(client, 'unicode-doc'))[0].version, 1);
});
test('router validates reviewer bearer independently from staff sessions', async () => {
  const { client } = await useTestDatabase();
  const { createDocument } = await import('../src/db/documents');
  await client.send(new PutCommand({ TableName: TABLE_TASKS, Item: { PK: 'TASK#router-task', SK: 'TASK#router-task', id: 'router-task', version: 1, taskHistory: [] } }));
  const document = await createDocument(client, { taskId: 'router-task', title: 'Router doc', content: 'Review body', kind: 'note' });
  const { token } = await createDocumentReviewer(client, document.id, 'Router reviewer');
  const oldSkip = process.env.SKIP_AUTH;
  const oldLocal = process.env.IS_LOCAL;
  process.env.SKIP_AUTH = 'false'; process.env.IS_LOCAL = 'true';
  try {
    const { handler } = await import('../src/handler');
    const call = (suffix: string, method = 'GET', reviewToken = token, body?: unknown) => handler({ httpMethod: method, path: `/api/documents/${document.id}${suffix}`, headers: { 'x-document-review-token': reviewToken, 'x-user-id': 'forged-staff' }, body: body === undefined ? null : JSON.stringify(body) }, {});
    assert.equal((await call('/review')).statusCode, 200);
    assert.equal((await call('/review', 'GET', 'bad')).statusCode, 401);
    assert.equal((await call('')).statusCode, 401);
    assert.equal((await call('', 'PUT', token, { title: 'Overwrite', content: 'No', version: 1 })).statusCode, 401);
    assert.equal((await call('/reviewers', 'POST', token, { name: 'No' })).statusCode, 401);
    assert.equal((await call('/comments', 'POST', token, { body: 'Router comment' })).statusCode, 201);
  } finally {
    if (oldSkip === undefined) delete process.env.SKIP_AUTH; else process.env.SKIP_AUTH = oldSkip;
    if (oldLocal === undefined) delete process.env.IS_LOCAL; else process.env.IS_LOCAL = oldLocal;
  }
});

test('simultaneous replies accept one version and retain the winning post', async () => {
  const { client } = await useTestDatabase();
  const thread = await createDocumentThread(client, 'race-doc', staff, 'Start');
  const results = await Promise.allSettled(['First', 'Second'].map(body => changeDocumentThread(client, 'race-doc', thread.id, staff, { body, version: 1 })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const saved = (await listDocumentThreads(client, 'race-doc'))[0];
  assert.equal(saved.posts.length, 2);
  assert.equal(saved.version, 2);
});

test('staff thread deletion refuses stale versions and reviewer deletion', async () => {
  const { client } = await useTestDatabase();
  const thread = await createDocumentThread(client, 'delete-doc', staff, 'Temporary review');
  await assert.rejects(deleteDocumentThread(client, 'delete-doc', thread.id, 2), /refresh/);
  const { token } = await createDocumentReviewer(client, 'delete-doc', 'Guest');
  const response = await handleDocumentReviewRoutes({ path: `/api/documents/delete-doc/comments/${thread.id}`, httpMethod: 'DELETE', headers: { 'x-document-review-token': token }, queryStringParameters: { version: '1' } }, client, async () => ({}));
  assert.equal(response?.statusCode, 403);
  await deleteDocumentThread(client, 'delete-doc', thread.id, 1);
  assert.deepEqual(await listDocumentThreads(client, 'delete-doc'), []);
});
