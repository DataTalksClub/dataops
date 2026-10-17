import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { route } from '../src/router';
import { TABLE_SPONSOR_CRM } from '../src/db/tableNames';
const now = '2026-10-17T00:00:00Z';
const record = (kind: string, id: string, fields: Record<string, unknown>) => ({ PK: `${kind}#${id}`, SK: `${kind}#${id}`, id, version: 1, createdAt: now, updatedAt: now, ...fields });
const items = [
  record('ORGANIZATION', 'org', { displayName: 'Synthetic company', lastInboundAt: '2026-10-16' }),
  record('CONTACT', 'person', { organizationId: 'org', name: 'Synthetic Person', primary: true, emails: ['person@example.test'] }),
  ...Array.from({ length: 75 }, (_, i) => record('DEAL', `deal-${String(i).padStart(3, '0')}`, { organizationId: 'org', status: i === 74 ? 'lost' : i < 4 ? 'agreed' : 'open', notes: 'Private long details' })),
];
function fake(taskRows: Record<string, unknown>[] = [], records = items) {
  let scans = 0;
  const client = { send: async (command: any) => {
    if (command.constructor.name === 'ScanCommand') {
      assert.equal(command.input.TableName, TABLE_SPONSOR_CRM); scans++;
      return { Items: records };
    }
    if (command.constructor.name === 'GetCommand') return {};
    if (command.constructor.name === 'QueryCommand') return { Items: taskRows.filter((row) => row.status === command.input.ExpressionAttributeValues[':status']) };
    throw new Error(`Unexpected ${command.constructor.name}`);
  } } as unknown as DynamoDBDocumentClient;
  return { client, scans: () => scans };
}
async function get(query: Record<string, string> = {}, taskRows: Record<string, unknown>[] = [], records = items) {
  const f = fake(taskRows, records);
  const response = await route({ httpMethod: 'GET', path: '/api/sponsor-crm/pipeline', headers: {}, body: null, queryStringParameters: { today: '2026-10-17', ...query } }, f.client);
  return { ...f, status: response.statusCode, body: JSON.parse(response.body) };
}
describe('bounded sponsor funnel', () => {
  it('defaults to actionable active rows, scans once, projects primary contact and omits heavy details', async () => {
    const { status, body, scans } = await get();
    assert.equal(status, 200); assert.equal(scans(), 1);
    assert.equal(body.items.length, 30); assert.equal(body.total, 74); assert.equal(body.nextCursor, '30');
    assert.equal(body.counts.lost, 1); assert.equal(body.counts.agreed, 4);
    assert.equal(body.items[0].primaryContact.name, 'Synthetic Person');
    assert.equal(body.items[0].notes, undefined); assert.equal(body.items[0].deliverables, undefined);
  });
  it('filters closed/stage/search and paginates without loss or repetition', async () => {
    const first = (await get({ view: 'all', limit: '50' })).body;
    const second = (await get({ view: 'all', limit: '50', cursor: first.nextCursor })).body;
    assert.equal(new Set([...first.items, ...second.items].map((item: any) => item.id)).size, 75);
    assert.equal(second.nextCursor, null);
    assert.equal((await get({ view: 'closed' })).body.total, 1);
    assert.equal((await get({ view: 'all', stage: 'agreed' })).body.total, 4);
    assert.equal((await get({ search: 'not-a-match' })).body.total, 0);
    assert.equal((await get({ search: 'person@example.test' })).body.total, 74);
  });
  for (const query of [{ limit: '101' }, { cursor: '-1' }, { view: 'wrong' }, { stage: 'wrong' }, { sort: 'wrong' }]) {
    it(`rejects invalid filter ${JSON.stringify(query)}`, async () => assert.equal((await get(query)).status, 400));
  }
});

import { pipelineTaskDate, pipelineTaskDeferred } from '../src/sponsorCrm/pipeline';
import type { Task } from '../src/types';
it('uses queue eligibility and waiting follow-up dates rather than the original date', () => {
  const task = { id: 'task', date: '2026-10-10', status: 'todo' } as Task;
  assert.equal(pipelineTaskDeferred(task, '2026-10-17'), false);
  assert.equal(pipelineTaskDeferred({ ...task, snoozedUntil: '2026-10-20' }, '2026-10-17'), true);
  assert.equal(pipelineTaskDeferred({ ...task, notBeforeAt: '2099-01-01T10:00:00Z' }, '2026-10-17'), true);
  assert.equal(pipelineTaskDeferred({ ...task, status: 'waiting', followUpAt: '2026-10-20' }, '2026-10-17'), true);
  assert.equal(pipelineTaskDeferred({ ...task, status: 'waiting', followUpAt: '2026-10-17' }, '2026-10-17'), false);
  assert.equal(pipelineTaskDate({ ...task, status: 'waiting', followUpAt: '2026-10-20' }), '2026-10-20');
  assert.equal(pipelineTaskDate({ ...task, date: '' }), '');
});

it('filters owner by next Task and keeps undated/deferred work out of the due view', async () => {
  const rows = items.map((item) => item.PK.startsWith('ORGANIZATION#') ? { ...item, lastInboundAt: null } : item);
  const task = (id: string, dealId: string, extra: Record<string, unknown>) => record('TASK', id, {
    taskHistory: [], subject: { type: 'sponsor-deal', id: dealId }, description: 'Synthetic next action',
    status: 'todo', date: '2026-10-18', assigneeId: 'owner-a', ...extra,
  });
  const tasks = [task('due', 'deal-000', {}), task('snoozed', 'deal-001', { snoozedUntil: '2026-10-20' }),
    task('blocked', 'deal-002', { notBeforeAt: '2099-01-01T00:00:00Z' }), task('undated', 'deal-003', { date: '' }),
    task('waiting', 'deal-004', { status: 'waiting', followUpAt: '2026-10-20' })];
  assert.deepEqual((await get({}, tasks, rows)).body.items.map((item: any) => item.id), ['deal-000']);
  assert.equal((await get({ view: 'all', owner: 'owner-a' }, tasks, rows)).body.total, 5);
  assert.equal((await get({ view: 'all', owner: 'owner-b' }, tasks, rows)).body.total, 0);
  assert.equal((await get({ view: 'unscheduled' }, tasks, rows)).body.total, 70);
});
