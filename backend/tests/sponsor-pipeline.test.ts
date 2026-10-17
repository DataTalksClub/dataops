import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { route } from '../src/router';
import { TABLE_SPONSOR_CRM } from '../src/db/tableNames';
const now = '2026-10-17T00:00:00Z';
const record = (kind: string, id: string, fields: Record<string, unknown>) => ({ PK: `${kind}#${id}`, SK: `${kind}#${id}`, id, version: 1, createdAt: now, updatedAt: now, ...fields });
const items = [
  record('ORGANIZATION', 'org', { displayName: 'Synthetic company', lastInboundAt: '2026-10-16', lastOutboundAt: '2026-10-10' }),
  record('CONTACT', 'person', { organizationId: 'org', name: 'Synthetic Person', primary: true, emails: ['person@example.test'] }),
  ...Array.from({ length: 75 }, (_, i) => record('DEAL', `deal-${String(i).padStart(3, '0')}`, { organizationId: 'org', status: i === 74 ? 'lost' : i < 4 ? 'agreed' : 'open', notes: 'Private long details' })),
];
function fake(taskRows: Record<string, unknown>[] = [], records = items) {
  let scans = 0;
  const views = new Map<string, Record<string, unknown>>();
  const client = { send: async (command: any) => {
    if (command.constructor.name === 'ScanCommand') {
      assert.equal(command.input.TableName, TABLE_SPONSOR_CRM); scans++;
      return { Items: records };
    }
    if (command.constructor.name === 'GetCommand') return { Item: views.get(command.input.Key?.SK) };
    if (command.constructor.name === 'PutCommand' && command.input.Item?.PK.startsWith('SAVEDVIEW#')) {
      views.set(command.input.Item.SK, structuredClone(command.input.Item)); return {};
    }
    if (command.constructor.name === 'QueryCommand') {
      if (String(command.input.ExpressionAttributeValues[':pk'] || '').startsWith('SAVEDVIEW#')) return { Items: [...views.values()] };
      return { Items: taskRows.filter((row) => row.status === command.input.ExpressionAttributeValues[':status']) };
    }
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

import { pipelineTaskDate, pipelineTaskDeferred, needsInboundReview } from '../src/sponsorCrm/pipeline';
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

it('only infers a recent inbound review from an established exchange, never old or one-way mail', () => {
  assert.equal(needsInboundReview('2026-10-16', '2026-10-10', '2026-10-17'), true);
  assert.equal(needsInboundReview('2022-10-16', '2022-10-10', '2026-10-17'), false);
  assert.equal(needsInboundReview('2026-10-16', null, '2026-10-17'), false);
  assert.equal(needsInboundReview('2026-10-16', '2026-10-17', '2026-10-17'), false);
  assert.equal(needsInboundReview('2026-10-18', '2026-10-10', '2026-10-17'), false);
});

it('excludes inactive people from primary summaries', async () => {
  const records = items.map((item) => item.PK.startsWith('CONTACT#') ? { ...item, active: false } : item);
  assert.equal((await get({}, [], records)).body.items[0].primaryContact, null);
});
it('uses the Berlin civil day across the UTC date boundary', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-17T22:30:00Z') });
  const f = fake();
  const response = await route({ httpMethod: 'GET', path: '/api/sponsor-crm/pipeline', headers: {}, body: null, queryStringParameters: {} }, f.client);
  assert.equal(JSON.parse(response.body).today, '2026-10-18');
});

const filterTask = (id: string, dealId: string, extra: Record<string, unknown> = {}) => record('TASK', id, {
  taskHistory: [], subject: { type: 'sponsor-deal', id: dealId }, description: 'Synthetic next action',
  status: 'todo', date: '2026-10-16', assigneeId: 'owner-a', ...extra,
});
const filterTasks = [
  filterTask('past', 'deal-000'),
  filterTask('today', 'deal-001', { date: '2026-10-17' }),
  filterTask('future', 'deal-002', { date: '2026-10-18' }),
  filterTask('undated', 'deal-003', { date: '' }),
  filterTask('snoozed', 'deal-004', { date: '2026-10-10', snoozedUntil: '2026-10-20' }),
  filterTask('not-before', 'deal-005', { date: '2026-10-11', notBeforeAt: '2099-01-01T00:00:00Z' }),
  filterTask('waiting-future', 'deal-006', { date: '2026-10-12', status: 'waiting', followUpAt: '2026-10-20' }),
  filterTask('waiting-past', 'deal-007', { date: '2026-10-30', status: 'waiting', followUpAt: '2026-10-15' }),
  filterTask('lost', 'deal-074'),
];
const ids = (body: any) => body.items.map((row: any) => row.id).sort();

it('canonical early and reply views use open stage and recent active inbound review', async () => {
  const early = await get({ view: 'early', limit: '100' });
  assert.equal(early.body.total, 70);
  assert.ok(early.body.items.every((row: any) => row.stage === 'open'));
  assert.equal((await get({ view: 'early', stage: 'agreed' })).body.total, 0);
  assert.equal((await get({ view: 'reply', limit: '100' })).body.total, 74);
  const stale = items.map((item) => item.PK.startsWith('ORGANIZATION#') ? { ...item, lastInboundAt: '2020-10-16', lastOutboundAt: '2020-10-10' } : item);
  assert.equal((await get({ view: 'reply' }, [], stale)).body.total, 0);
  for (const alias of ['early-prospects', 'needs-reply']) assert.equal((await get({ view: alias })).status, 400);
});

it('overdue is strictly before today, excludes deferred/lost/undated and uses waiting follow-up', async () => {
  const result = await get({ view: 'overdue' }, filterTasks);
  assert.equal(result.status, 200);
  assert.equal(result.scans(), 1);
  assert.deepEqual(ids(result.body), ['deal-000', 'deal-007']);
  assert.equal((await get({ view: 'overdue', owner: 'owner-b' }, filterTasks)).body.total, 0);
  // An eligible next Task wins over an older snoozed Task on the same deal.
  const multi = [...filterTasks, filterTask('old-deferred', 'deal-001', { date: '2020-01-01', snoozedUntil: '2099-01-01' })];
  assert.deepEqual(ids((await get({ view: 'overdue' }, multi)).body), ['deal-000', 'deal-007']);
});

it('inclusive next-action ranges exclude undated rows and intersect view/stage/owner filters', async () => {
  const query = { view: 'all', nextActionFrom: '2026-10-16', nextActionBefore: '2026-10-17' };
  assert.deepEqual(ids((await get(query, filterTasks)).body), ['deal-000', 'deal-001', 'deal-074']);
  assert.deepEqual(ids((await get({ ...query, view: 'overdue' }, filterTasks)).body), ['deal-000']);
  assert.deepEqual(ids((await get({ view: 'all', nextActionFrom: '2026-10-20' }, filterTasks)).body), ['deal-006']);
  assert.deepEqual(ids((await get({ view: 'active', nextActionBefore: '2026-10-15' }, filterTasks)).body), ['deal-004', 'deal-005', 'deal-007']);
  assert.equal((await get({ ...query, stage: 'open' }, filterTasks)).body.total, 0);
  assert.equal((await get({ ...query, owner: 'owner-b' }, filterTasks)).body.total, 0);
});

for (const query of [
  { nextActionFrom: '2026-02-30' }, { nextActionBefore: '2026-13-01' },
  { nextActionFrom: '2026-01-99' }, { nextActionFrom: '2026-1-01' },
  { nextActionBefore: '' }, { nextActionBefore: 'yesterday' },
  { nextActionFrom: '2026-10-18', nextActionBefore: '2026-10-17' },
]) it(`rejects invalid next-action range ${JSON.stringify(query)}`, async () => {
  assert.equal((await get(query)).status, 400);
});

it('saved pipeline views validate, preserve and execute the same canonical filters as direct API', async () => {
  const f = fake(filterTasks);
  const invoke = async (method: string, path: string, body?: unknown, query = {}) => {
    const response = await route({ httpMethod: method, path, headers: { 'x-user-id': 'owner-a' },
      body: body === undefined ? null : JSON.stringify(body), queryStringParameters: { today: '2026-10-17', ...query } }, f.client);
    return { status: response.statusCode, body: JSON.parse(response.body) };
  };
  const builtin = await invoke('GET', '/api/sponsor-crm/views', undefined, { entity: 'pipeline' });
  for (const view of ['early', 'overdue', 'reply']) {
    assert.deepEqual(builtin.body.items.find((item: any) => item.id === `builtin:pipeline:${view}`).resolvedFilters, { view });
    const filters = { view, nextActionFrom: '2026-10-15', nextActionBefore: '2026-10-17' };
    const created = await invoke('POST', '/api/sponsor-crm/views', { entity: 'pipeline', name: `Synthetic ${view}`, filters });
    assert.equal(created.status, 201);
    const saved = await invoke('GET', `/api/sponsor-crm/views/${created.body.id}`);
    assert.deepEqual(saved.body.resolvedFilters, filters);
    const executed = await invoke('GET', '/api/sponsor-crm/pipeline', undefined, saved.body.resolvedFilters);
    const direct = await get(filters, filterTasks);
    assert.equal(executed.status, 200);
    assert.deepEqual(ids(executed.body), ids(direct.body));
    const changed = await invoke('PUT', `/api/sponsor-crm/views/${created.body.id}`, {
      version: saved.body.version, name: `Changed ${view}`, filters: { ...filters, nextActionFrom: '2026-10-17' },
    });
    assert.equal(changed.status, 200);
  }
  for (const filters of [
    { view: 'reply', nextActionFrom: '2026-02-30' }, { nextActionBefore: '2026-13-01' },
    { nextActionFrom: { daysAgo: 7 } }, { nextActionFrom: '2026-10-18', nextActionBefore: '2026-10-17' },
    { view: ['reply'] }, { stage: ['open'] }, { view: { value: 'reply' } }, { stage: { value: 'open' } },
  ]) assert.equal((await invoke('POST', '/api/sponsor-crm/views', { entity: 'pipeline', name: 'Invalid', filters })).status, 400);
});

it('overdue uses Berlin today across the UTC day boundary', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-17T22:30:00Z') });
  const f = fake(filterTasks);
  const response = await route({ httpMethod: 'GET', path: '/api/sponsor-crm/pipeline', headers: {}, body: null,
    queryStringParameters: { view: 'overdue' } }, f.client);
  const body = JSON.parse(response.body);
  assert.equal(body.today, '2026-10-18');
  assert.deepEqual(ids(body), ['deal-000', 'deal-001', 'deal-007']);
});
