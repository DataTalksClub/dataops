import { createUserWithId } from '../src/db/users';
import { setDefaultAssignee } from '../src/db/workspaceSettings';
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { handler } from '../src/handler';
import { createTables } from '../scripts/local-dynamodb';
import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';

const GRACE_USER_ID = '00000000-0000-0000-0000-000000000001';
const ALICE = 'workspace-alice';
const BOB = 'workspace-bob';

const invoke = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const url = new URL(path, 'http://crm-workspace.test');
  return handler({
    httpMethod: method,
    path: url.pathname,
    headers,
    queryStringParameters: Object.fromEntries(url.searchParams),
    body: body === undefined ? null : JSON.stringify(body),
  }, {});
};
const data = (response: any) => JSON.parse(response.body);
const as = (user: string) => ({ 'x-user-id': user });

describe('crm workspace views and notes', () => {
  let client: DynamoDBDocumentClient;
  let seedCount = 0;
  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    await createUserWithId(client, GRACE_USER_ID, { name: 'Workspace Fixture', email: 'workspace@example.test', role: 'admin' });
    await setDefaultAssignee(client, { defaultAssigneeId: GRACE_USER_ID, expectedVersion: 0 });
    void client;
  });
  after(stopLocal);

  async function seedOrg(suffix: string) {
    return data(await invoke('POST', '/api/sponsor-crm/organizations', {
      displayName: `Note Org ${suffix}`, domain: `note-${suffix}.example`, notes: 'Summary paragraph stays.',
      sourceKey: `ws-note-org-${suffix}`,
    }));
  }

  it('serves immutable builtins per entity', async () => {
    const body = data(await invoke('GET', '/api/sponsor-crm/views?entity=companies', undefined, as(ALICE)));
    const ids = body.items.map((item: any) => item.id);
    for (const id of ['builtin:companies:active', 'builtin:companies:all', 'builtin:companies:recent', 'builtin:companies:stale', 'builtin:companies:archived']) {
      assert.ok(ids.includes(id), `missing ${id}`);
    }
    assert.ok(body.items.every((item: any) => item.builtin === true));
    assert.equal(body.total, body.items.length);
    const pipeline = data(await invoke('GET', '/api/sponsor-crm/views?entity=pipeline', undefined, as(ALICE)));
    const attention = pipeline.items.find((item: any) => item.id === 'builtin:pipeline:attention');
    assert.deepEqual(attention.filters, { view: 'actionable' });
    // Exact A route values, no translator alias.
    assert.deepEqual(attention.sort, { field: 'next-action' });
    assert.deepEqual(pipeline.items.find((item: any) => item.id === 'builtin:pipeline:closed').sort, { field: 'recent' });
    assert.equal((await invoke('PUT', '/api/sponsor-crm/views/builtin:companies:active', { version: 1 }, as(ALICE))).statusCode, 404);
    assert.equal((await invoke('DELETE', '/api/sponsor-crm/views/builtin:companies:active', undefined, as(ALICE))).statusCode, 404);
    assert.equal((await invoke('GET', '/api/sponsor-crm/views?entity=bogus', undefined, as(ALICE))).statusCode, 400);
  });

  it('every company/person builtin filter executes against its directory', async () => {
    const suffix = String(seedCount++);
    const org = await seedOrg(suffix);
    await invoke('POST', '/api/sponsor-crm/touches', { targetType: 'organization', targetId: org.id, channel: 'call', touchedAt: '2026-10-10T08:00:00Z' });
    const oldOrg = data(await invoke('POST', '/api/sponsor-crm/organizations', {
      displayName: `Stale Org ${suffix}`, domain: `stale-${suffix}.example`, sourceKey: `ws-stale-org-${suffix}`,
    }));
    await invoke('POST', '/api/sponsor-crm/touches', { targetType: 'organization', targetId: oldOrg.id, channel: 'call', touchedAt: '2026-01-05T08:00:00Z' });
    const contact = data(await invoke('POST', '/api/sponsor-crm/contacts', {
      organizationId: org.id, name: 'Nina Notes', emails: [`nina-${suffix}@example.invalid`], sourceKey: `ws-note-contact-${suffix}`,
    }));
    const check = async (builtinId: string, entity: string, params: string, expect: string[]) => {
      const views = data(await invoke('GET', `/api/sponsor-crm/views?entity=${entity}`, undefined, as(ALICE)));
      const builtin = views.items.find((item: any) => item.id === builtinId);
      assert.ok(builtin, `missing ${builtinId}`);
      // Builtin filters use directory query keys; {daysAgo} is resolved in-test against Berlin today.
      const resolved: Record<string, string> = {};
      for (const [key, value] of Object.entries(builtin.filters as Record<string, unknown>)) {
        if (value && typeof value === 'object' && 'daysAgo' in (value as Record<string, unknown>)) {
          const days = (value as { daysAgo: number }).daysAgo;
          const ms = Date.parse('2026-10-17T12:00:00Z') - days * 86_400_000;
          resolved[key] = new Date(ms).toISOString().slice(0, 10);
        } else {
          resolved[key] = String(value);
        }
      }
      const qs = new URLSearchParams({ ...resolved, today: '2026-10-17' }).toString();
      const listing = data(await invoke('GET', `${params}?${qs}`));
      for (const id of expect) assert.ok(listing.items.some((item: any) => item.id === id), `${builtinId} must match ${id}`);
    };
    await check('builtin:companies:active', 'companies', '/api/sponsor-crm/directory/companies', [org.id]);
    await check('builtin:companies:all', 'companies', '/api/sponsor-crm/directory/companies', [org.id]);
    await check('builtin:companies:recent', 'companies', '/api/sponsor-crm/directory/companies', [org.id]);
    const stale = data(await invoke('GET', '/api/sponsor-crm/directory/companies?active=true&lastTouchBefore=2026-09-17&today=2026-10-17'));
    assert.ok(stale.items.some((item: any) => item.id === oldOrg.id), 'january touch is stale');
    assert.ok(!stale.items.some((item: any) => item.id === org.id), 'october touch is not stale');
    await check('builtin:people:active', 'people', '/api/sponsor-crm/directory/people', [contact.id]);
    await check('builtin:people:all', 'people', '/api/sponsor-crm/directory/people', [contact.id]);
  });

  it('validates view input, including A-owned pipeline enums', async () => {
    const badEntity = await invoke('POST', '/api/sponsor-crm/views', { entity: 'deals', name: 'X', filters: {} }, as(ALICE));
    assert.equal(badEntity.statusCode, 400);
    const unknownKey = await invoke('POST', '/api/sponsor-crm/views', { entity: 'companies', name: 'X', filters: { scope: 'all' } }, as(ALICE));
    assert.equal(unknownKey.statusCode, 400);
    const legacyScope = await invoke('POST', '/api/sponsor-crm/views', { entity: 'pipeline', name: 'X', filters: { scope: 'all' } }, as(ALICE));
    assert.equal(legacyScope.statusCode, 400);
    const badSort = await invoke('POST', '/api/sponsor-crm/views', { entity: 'pipeline', name: 'X', filters: { view: 'actionable' }, sort: { field: 'dueDate', direction: 'asc' } }, as(ALICE));
    assert.equal(badSort.statusCode, 400);
    // A's live route takes next-action|recent verbatim: no translator alias.
    const legacyNext = await invoke('POST', '/api/sponsor-crm/views', { entity: 'pipeline', name: 'X', filters: { view: 'actionable' }, sort: { field: 'next' } }, as(ALICE));
    assert.equal(legacyNext.statusCode, 400);
    const good = data(await invoke('POST', '/api/sponsor-crm/views', {
      entity: 'pipeline', name: 'My attention', filters: { view: 'actionable', stage: 'open' }, sort: { field: 'next-action' },
    }, as(ALICE)));
    assert.equal(good.entity, 'pipeline');
    assert.deepEqual(good.sort, { field: 'next-action' });
    const badStage = await invoke('POST', '/api/sponsor-crm/views', { entity: 'pipeline', name: 'X', filters: { view: 'nope' } }, as(ALICE));
    assert.equal(badStage.statusCode, 400);
    const longName = await invoke('POST', '/api/sponsor-crm/views', { entity: 'people', name: 'x'.repeat(121), filters: {} }, as(ALICE));
    assert.equal(longName.statusCode, 400);
  });

  it('isolates views per owner and versions concurrent updates', async () => {
    const created = data(await invoke('POST', '/api/sponsor-crm/views', {
      entity: 'companies', name: 'Alice view', filters: { active: 'true' }, sort: { field: 'name', direction: 'asc' },
    }, as(ALICE)));
    assert.equal(created.version, 1);
    // Bob cannot see, update or archive Alice's view: all read as missing.
    const bobList = data(await invoke('GET', '/api/sponsor-crm/views?entity=companies', undefined, as(BOB)));
    assert.ok(!bobList.items.some((item: any) => item.id === created.id));
    assert.equal((await invoke('PUT', `/api/sponsor-crm/views/${created.id}`, { name: 'Hijack', filters: {}, version: 1 }, as(BOB))).statusCode, 404);
    assert.equal((await invoke('DELETE', `/api/sponsor-crm/views/${created.id}`, undefined, as(BOB))).statusCode, 404);
    // Stale version is rejected; entity cannot change.
    assert.equal((await invoke('PUT', `/api/sponsor-crm/views/${created.id}`, { name: 'Stale', filters: {}, version: 0 }, as(ALICE))).statusCode, 409);
    assert.equal((await invoke('PUT', `/api/sponsor-crm/views/${created.id}`, { entity: 'people', name: 'Hop', filters: {}, version: 1 }, as(ALICE))).statusCode, 400);
    const updated = data(await invoke('PUT', `/api/sponsor-crm/views/${created.id}`, {
      name: 'Alice view 2', filters: { active: 'all' }, sort: { field: 'name', direction: 'asc' }, version: 1,
    }, as(ALICE)));
    assert.equal(updated.version, 2);
    assert.equal(updated.name, 'Alice view 2');
    // Archive keeps the record: default list hides it, includeArchived shows metadata.
    const archived = data(await invoke('DELETE', `/api/sponsor-crm/views/${created.id}`, undefined, as(ALICE)));
    assert.ok(archived.archivedAt);
    const hidden = data(await invoke('GET', '/api/sponsor-crm/views?entity=companies', undefined, as(ALICE)));
    assert.ok(!hidden.items.some((item: any) => item.id === created.id));
    const shown = data(await invoke('GET', '/api/sponsor-crm/views?entity=companies&includeArchived=true', undefined, as(ALICE)));
    assert.ok(shown.items.some((item: any) => item.id === created.id && item.archivedAt));
    assert.equal((await invoke('PUT', `/api/sponsor-crm/views/${created.id}`, { name: 'Edit archived', filters: {}, version: 3 }, as(ALICE))).statusCode, 422);
  });

  it('scopes note idempotency keys by author and target', async () => {
    const suffix = String(seedCount++);
    const orgA = await seedOrg(`ca-${suffix}`);
    const orgB = await seedOrg(`cb-${suffix}`);
    const aliceNote = data(await invoke('POST', `/api/sponsor-crm/notes/organization/${orgA.id}`, { body: 'Same key text.', sourceKey: 'shared-key' }, as(ALICE)));
    // Same key, different author: a different note, not a collision.
    const bobNote = data(await invoke('POST', `/api/sponsor-crm/notes/organization/${orgA.id}`, { body: 'Same key text.', sourceKey: 'shared-key' }, as(BOB)));
    assert.ok(bobNote.id !== aliceNote.id);
    // Same author and key, different target: a different note.
    const otherTarget = data(await invoke('POST', `/api/sponsor-crm/notes/organization/${orgB.id}`, { body: 'Same key text.', sourceKey: 'shared-key' }, as(ALICE)));
    assert.ok(otherTarget.id !== aliceNote.id);
    // Same author, target, key and body: the same note.
    const replay = data(await invoke('POST', `/api/sponsor-crm/notes/organization/${orgA.id}`, { body: 'Same key text.', sourceKey: 'shared-key' }, as(ALICE)));
    assert.equal(replay.id, aliceNote.id);
    // Same scope, different body: conflict.
    assert.equal((await invoke('POST', `/api/sponsor-crm/notes/organization/${orgA.id}`, { body: 'Changed text.', sourceKey: 'shared-key' }, as(ALICE))).statusCode, 409);
  });

  it('rejects notes for deals under an archived organization', async () => {
    const suffix = String(seedCount++);
    const org = await seedOrg(`po-${suffix}`);
    const contact = data(await invoke('POST', '/api/sponsor-crm/contacts', {
      organizationId: org.id, name: 'Pat Parent', emails: [`pat-${suffix}@example.invalid`], sourceKey: `ws-po-contact-${suffix}`,
    }));
    const deal = data(await invoke('POST', '/api/sponsor-crm/deals', {
      organizationId: org.id, primaryContactId: contact.id, status: 'open', sourceKey: `ws-po-deal-${suffix}`,
    }));
    await invoke('DELETE', `/api/sponsor-crm/organizations/${org.id}`);
    assert.equal((await invoke('POST', `/api/sponsor-crm/notes/deal/${deal.id}`, { body: 'late note' }, as(ALICE))).statusCode, 422);
    assert.equal((await invoke('POST', `/api/sponsor-crm/notes/contact/${contact.id}`, { body: 'late note' }, as(ALICE))).statusCode, 422);
  });

  it('appends notes idempotently without touching record summaries', async () => {
    const suffix = String(seedCount++);
    const org = await seedOrg(suffix);
    const first = await invoke('POST', `/api/sponsor-crm/notes/organization/${org.id}`, { body: 'Called; send deck.', sourceKey: `ws-note-${suffix}` }, as(ALICE));
    assert.equal(first.statusCode, 201);
    const note = data(first);
    assert.equal(note.targetType, 'organization');
    assert.equal(note.authorId, ALICE);
    assert.equal(note.version, 1);
    // Same sourceKey + same body replays the same note; different body conflicts.
    const replay = await invoke('POST', `/api/sponsor-crm/notes/organization/${org.id}`, { body: 'Called; send deck.', sourceKey: `ws-note-${suffix}` }, as(ALICE));
    assert.equal(replay.statusCode, 200);
    assert.equal(data(replay).id, note.id);
    assert.equal((await invoke('POST', `/api/sponsor-crm/notes/organization/${org.id}`, { body: 'Different text.', sourceKey: `ws-note-${suffix}` }, as(ALICE))).statusCode, 409);
    assert.equal((await invoke('POST', `/api/sponsor-crm/notes/organization/${org.id}`, { body: '' }, as(ALICE))).statusCode, 400);
    assert.equal((await invoke('POST', `/api/sponsor-crm/notes/organization/${org.id}`, { body: 'x'.repeat(2001) }, as(ALICE))).statusCode, 400);
    assert.equal((await invoke('PUT', `/api/sponsor-crm/notes/organization/${org.id}`, { body: 'edit' }, as(ALICE))).statusCode, 405);
    assert.equal((await invoke('DELETE', `/api/sponsor-crm/notes/organization/${org.id}`, undefined, as(ALICE))).statusCode, 405);

    const listing = data(await invoke('GET', `/api/sponsor-crm/notes/organization/${org.id}`));
    assert.equal(listing.total, 1);
    assert.equal(listing.items[0].id, note.id);

    // The record summary field is preserved verbatim.
    const stored = data(await invoke('GET', `/api/sponsor-crm/organizations/${org.id}`));
    assert.equal(stored.notes, 'Summary paragraph stays.');
    // Missing and archived targets.
    assert.equal((await invoke('GET', '/api/sponsor-crm/notes/organization/does-not-exist-1')).statusCode, 404);
    assert.equal((await invoke('POST', '/api/sponsor-crm/notes/contact/does-not-exist-1', { body: 'hi' }, as(ALICE))).statusCode, 404);
    await invoke('DELETE', `/api/sponsor-crm/organizations/${org.id}`);
    assert.equal((await invoke('POST', `/api/sponsor-crm/notes/organization/${org.id}`, { body: 'late' }, as(ALICE))).statusCode, 422);
  });
});
