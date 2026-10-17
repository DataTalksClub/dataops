import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { startLocal, stopLocal, createTables } from '../scripts/local-dynamodb';
import { getClient } from '../src/db/client';
import { handleTuitionRoutes } from '../src/routes/tuition';
import { parseTaskSubject, attachSubjects } from '../src/db/taskSubjects';
import { isIndividualTuition } from '../src/tuition/classification';
import type { Task } from '../src/types';
let client: DynamoDBDocumentClient;
before(async () => { const port = await startLocal(); client = await getClient(port); await createTables(client); });
after(stopLocal);
const call = async (method: string, path: string, body?: unknown) => {
  const response = await handleTuitionRoutes(path, method, { httpMethod: method, path, headers: {}, body: body === undefined ? null : JSON.stringify(body), queryStringParameters: {} }, client);
  return { status: response.statusCode, body: JSON.parse(response.body) };
};
describe('individual tuition billing', () => {
  it('keeps an actual payment condition without inventing a due date or ledger income and preserves task subjects', async () => {
    const created = await call('POST', '/api/tuition', { studentName: 'Synthetic Student', title: 'Deferred tuition installment', trigger: 'First paid employment', status: 'conditional', amount: '900', currency: 'EUR' });
    assert.equal(created.status, 201); assert.equal(created.body.dueOn, undefined);
    const id = created.body.id;
    const subject = { type: 'tuition-agreement', id };
    assert.deepEqual(await parseTaskSubject(client, subject), { subject });
    const [task] = await attachSubjects(client, [{ id: 'existing-task', subject } as Task]);
    assert.equal(task.id, 'existing-task'); assert.equal((task.subject as any).href, `/bookkeeping?view=tuition&agreement=${id}`);
    assert.match((task.subject as any).label, /Synthetic Student/);
    assert.equal((await call('GET', '/api/tuition')).body.total, 1);
    const updated = await call('PUT', `/api/tuition/${id}`, { version: 1, notes: 'Preserve agreed condition' });
    assert.equal(updated.status, 200); assert.equal(updated.body.trigger, 'First paid employment');
    assert.equal((await call('PUT', `/api/tuition/${id}`, { version: 1, status: 'due' })).status, 409);
    assert.deepEqual((await call('GET', `/api/tuition/${id}`)).body.evidence, []);
  });
  it('requires genuine agreement fields and rejects bad amounts/dates', async () => {
    for (const fields of [{}, { studentName: 'Student', title: 'Tuition', trigger: 'Condition', status: 'conditional', amount: '-2' }, { studentName: 'Student', title: 'Tuition', trigger: 'Condition', status: 'conditional', dueOn: 'wrong' }]) assert.equal((await call('POST', '/api/tuition', fields)).status, 400);
    assert.equal(isIndividualTuition({ title: 'Deferred course tuition installment' }), true);
    assert.equal(isIndividualTuition({ title: 'Sponsor a course', productKind: 'course' }), false);
    assert.equal(isIndividualTuition({ title: 'Course sponsorship supporting tuition scholarships', productKind: 'course' }), false);
    assert.equal(isIndividualTuition({ recordType: 'tuition-agreement', title: 'Installment 2' }), true);
  });
});

import { handleSponsorCrmRoutes } from '../src/routes/sponsorCrm';
import { importCrmSnapshot } from '../src/sponsorCrm/importSnapshot';
it('rejects individual tuition in CRM before references or imports create any sponsor records', async () => {
  const event = { httpMethod: 'POST', path: '/api/sponsor-crm/deals', headers: {}, queryStringParameters: {},
    body: JSON.stringify({ organizationId: 'synthetic-org', status: 'open', title: 'Deferred course tuition installment' }) };
  const response = await handleSponsorCrmRoutes(event.path, 'POST', event, client);
  assert.equal(response.statusCode, 400); assert.match(response.body, /api\/tuition/);
  let touchedStorage = false;
  const forbidden = { send: async () => { touchedStorage = true; throw new Error('Storage must not be touched'); } } as unknown as DynamoDBDocumentClient;
  await assert.rejects(importCrmSnapshot(forbidden, { companies: [{ displayName: 'Synthetic Student' }],
    deals: [{ organizationDomain: 'synthetic-org', status: 'open', title: 'Deferred course tuition installment' }] }, 'actor'), /api\/tuition/);
  assert.equal(touchedStorage, false);
});
