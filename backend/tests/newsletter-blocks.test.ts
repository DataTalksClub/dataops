import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { buildNewsletterIssue, createNewsletterIssue } from '../src/db/newsletterIssues';
import { createUser } from '../src/db/users';
import { setRelayDepsForTests } from '../src/newsletter/blocksRelay';
import { blockHash, planSync, validateBlockData, type IssueBlock, type RelayIssue } from '../src/newsletter/blocks';
import { humanBearer } from './helpers/human-bearer';

type FakeBlock = { id: number; position: number; type: string; data: Record<string, string>; updated_by: string; updated_at: string };

/** An in-memory Relay newsletter API: GET issue, GET/PUT block. */
class FakeRelay {
  issues = new Map<string, { key: string; subject: string; campaign: { status: string } | null; blocks: FakeBlock[] }>();
  calls: string[] = [];
  tick = 0;
  /** Runs right before a block GET returns (to simulate a concurrent Relay edit). */
  beforeBlockGet: ((block: FakeBlock) => void) | null = null;
  apiKeySeen = '';

  stamp() {
    this.tick += 1;
    return `2026-11-23T10:00:${String(this.tick).padStart(2, '0')}+00:00`;
  }

  seed(key: string, blocks: Omit<FakeBlock, 'updated_at' | 'updated_by'>[]) {
    this.issues.set(key, {
      key,
      subject: `Subject ${key}`,
      campaign: null,
      blocks: blocks.map((block) => ({ ...block, updated_by: 'api:dtc-newsletter', updated_at: this.stamp() })),
    });
  }

  editInRelay(key: string, id: number, data: Record<string, string>) {
    const block = this.issues.get(key)!.blocks.find((item) => item.id === id)!;
    block.data = data;
    block.updated_by = 'alexey@datatalks.club';
    block.updated_at = this.stamp();
  }

  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const method = init?.method || 'GET';
    const u = new URL(String(url));
    this.calls.push(`${method} ${u.host}${u.pathname}`);
    this.apiKeySeen = String((init?.headers as Record<string, string>)?.authorization || '');
    const match = u.pathname.match(/^\/api\/newsletter-issues\/([^/]+)(?:\/blocks\/(\d+))?$/);
    const issue = match && this.issues.get(decodeURIComponent(match[1]));
    if (!issue) return new Response(JSON.stringify({ errors: { key: 'not_found' } }), { status: 404 });
    const payload = () => ({ ...issue, preview_text: '', updated_at: this.stamp() });
    if (!match![2]) return new Response(JSON.stringify({ issue: payload() }), { status: 200 });
    const block = issue.blocks.find((item) => item.id === Number(match![2]));
    if (!block) return new Response(JSON.stringify({ errors: { block_id: 'not_found' } }), { status: 404 });
    if (method === 'GET') {
      this.beforeBlockGet?.(block);
      return new Response(JSON.stringify({ block }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body || '{}'));
    block.type = body.type;
    block.data = body.data;
    block.updated_by = 'api:dtc-newsletter';
    block.updated_at = this.stamp();
    return new Response(JSON.stringify({ block }), { status: 200 });
  };
}

const SECRETS: Record<string, string> = {
  'relay-production.dtc-newsletter-api-key': 'prod-key-123',
  'relay-dev.api-keys': JSON.stringify({ RELAY_API_KEY: 'dev-key-456', RELAY_WEBHOOK: 'x' }),
};

describe('Newsletter issue blocks (/api/newsletter-issues/:id/blocks)', () => {
  let client: DynamoDBDocumentClient;
  let handler: typeof import('../src/handler').handler;
  let token: string;
  let userId: string;
  let relay: FakeRelay;
  let restore: () => void;
  let issueSeq = 0;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    process.env.IS_LOCAL = 'true';
    handler = (await import('../src/handler')).handler;
    const user = await createUser(client, { email: 'alexey@datatalks.club', name: 'Alexey', passwordHash: 'x', role: 'admin' });
    userId = user.id;
    token = await humanBearer(client, userId);
  });

  after(async () => {
    await stopLocal();
    delete process.env.IS_LOCAL;
  });

  beforeEach(() => {
    restore?.();
    relay = new FakeRelay();
    restore = setRelayDepsForTests({
      fetchImpl: relay.fetch as typeof fetch,
      readSecret: async (name) => {
        if (!(name in SECRETS)) throw new Error('missing');
        return SECRETS[name];
      },
    });
  });

  async function req(method: string, path: string, body?: unknown, query?: Record<string, string>) {
    const res = await handler(
      {
        httpMethod: method,
        path,
        headers: { authorization: `Bearer ${token}`, 'x-user-id': userId, host: 'ops.dtcdev.click', 'x-forwarded-proto': 'https' },
        queryStringParameters: query || null,
        body: body === undefined ? null : JSON.stringify(body),
      },
      {},
    );
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  }

  async function newIssue() {
    issueSeq += 1;
    const issue = buildNewsletterIssue(
      { kind: 'weekly', publicationDate: `2027-0${issueSeq}-01`, issueNumber: 900 + issueSeq, status: 'planned', slots: {} },
      `issue-blocks-${issueSeq}`,
    );
    await createNewsletterIssue(client, issue);
    return issue.id;
  }

  function seedWeekly(key: string) {
    relay.seed(key, [
      { id: 113, position: 0, type: 'intro', data: { issue_label: '#304', summary: 'Hello this week' } },
      { id: 114, position: 1, type: 'sponsor', data: { title: 'Sponsor', kicker: 'SPONSORED', cta_text: 'Go', cta_url: 'https://x.example/a' } },
      { id: 115, position: 2, type: 'events_list', data: { events: 'Mon · Webinar | Talk | https://x.example/e' } },
    ]);
  }

  async function imported(key = 'weekly-304', target = 'dev') {
    const id = await newIssue();
    seedWeekly(key);
    const res = await req('POST', `/api/newsletter-issues/${id}/blocks/import`, { target, issueKey: key });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return { id, set: res.body.blocks };
  }

  it('imports every Relay block with the right key per target, and lists them', async () => {
    const id = await newIssue();
    assert.strictEqual((await req('GET', `/api/newsletter-issues/${id}/blocks`)).body.code, 'blocks_not_imported');
    seedWeekly('weekly-304');
    const res = await req('POST', `/api/newsletter-issues/${id}/blocks/import`, { target: 'production', issueKey: 'weekly-304' });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(relay.apiKeySeen, 'Bearer prod-key-123');
    assert.deepStrictEqual(relay.calls, ['GET relay.datatalks.club/api/newsletter-issues/weekly-304']);
    const listed = (await req('GET', `/api/newsletter-issues/${id}/blocks`)).body.blocks;
    assert.deepStrictEqual(listed.blocks.map((b: IssueBlock) => [b.id, b.type, b.position]), [
      ['rb-113', 'intro', 0],
      ['rb-114', 'sponsor', 1],
      ['rb-115', 'events_list', 2],
    ]);
    assert.ok(listed.blocks[1].fields.some((f: { name: string }) => f.name === 'cta_url'));
    assert.strictEqual(listed.relayIssue.subject, 'Subject weekly-304');
    // Importing twice is refused rather than overwriting.
    assert.strictEqual((await req('POST', `/api/newsletter-issues/${id}/blocks/import`, { target: 'production', issueKey: 'weekly-304' })).status, 409);
    const revisions = (await req('GET', `/api/newsletter-issues/${id}/blocks/revisions`)).body.revisions;
    assert.deepStrictEqual(revisions.map((r: { origin: string }) => r.origin), ['import', 'import', 'import']);

    relay.calls = [];
    const dev = await newIssue();
    await req('POST', `/api/newsletter-issues/${dev}/blocks/import`, { target: 'dev', issueKey: 'weekly-304' });
    assert.strictEqual(relay.apiKeySeen, 'Bearer dev-key-456');
    assert.match(relay.calls[0], /^GET dev\.relay\.datatalks\.club\//);
  });

  it('records an edit as a revision with a field diff and rejects stale or invalid edits', async () => {
    const { id } = await imported();
    const path = `/api/newsletter-issues/${id}/blocks/rb-113`;
    const ok = await req('PUT', path, { version: 1, data: { issue_label: '#304', summary: 'Hello  edited week  ' } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    const block = ok.body.blocks.blocks.find((b: IssueBlock) => b.id === 'rb-113');
    assert.strictEqual(block.data.summary, 'Hello  edited week');
    assert.strictEqual(block.version, 2);
    assert.strictEqual(block.changedSinceSync, true);
    assert.strictEqual((await req('PUT', path, { version: 1, data: { summary: 'x' } })).body.code, 'block_version_conflict');
    const bad = await req('PUT', `/api/newsletter-issues/${id}/blocks/rb-114`, { version: 1, data: { title: 'T', cta_text: 'Go', cta_url: 'not a url', bogus: 'x' } });
    assert.strictEqual(bad.status, 400);
    assert.deepStrictEqual(bad.body.fields, { 'data.bogus': 'unknown_field', 'data.cta_url': 'invalid_url' });

    const revisions = (await req('GET', `/api/newsletter-issues/${id}/blocks/revisions`, undefined, { block: '113' })).body.revisions;
    assert.deepStrictEqual(revisions.map((r: { origin: string }) => r.origin), ['import', 'edit']);
    assert.strictEqual(revisions[1].actorName, 'Alexey');
    assert.deepStrictEqual(revisions[1].changes, [{ field: 'summary', before: 'Hello this week', after: 'Hello  edited week' }]);
  });

  it('pushes DataOps edits and pulls Relay edits in one sync, then round-trips', async () => {
    const { id } = await imported();
    await req('PUT', `/api/newsletter-issues/${id}/blocks/rb-113`, { version: 1, data: { issue_label: '#304', summary: 'From DataOps' } });
    relay.editInRelay('weekly-304', 115, { events: 'Tue · Workshop | New | https://x.example/n' });

    const dry = await req('POST', `/api/newsletter-issues/${id}/blocks/sync`, { dryRun: true });
    assert.strictEqual(dry.status, 200);
    assert.deepStrictEqual(dry.body.plan.map((s: { action: string }) => s.action), ['push', 'in_sync', 'pull']);
    assert.ok(!relay.calls.some((c) => c.startsWith('PUT')), 'dry run writes nothing');

    const res = await req('POST', `/api/newsletter-issues/${id}/blocks/sync`, {});
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.pushed, [113]);
    assert.deepStrictEqual(res.body.pulled, [115]);
    assert.strictEqual(relay.issues.get('weekly-304')!.blocks[0].data.summary, 'From DataOps');
    const blocks = res.body.blocks.blocks;
    assert.strictEqual(blocks[2].data.events, 'Tue · Workshop | New | https://x.example/n');
    assert.ok(blocks.every((b: { changedSinceSync: boolean }) => !b.changedSinceSync));

    const again = await req('POST', `/api/newsletter-issues/${id}/blocks/sync`, {});
    assert.deepStrictEqual(again.body.plan.map((s: { action: string }) => s.action), ['in_sync', 'in_sync', 'in_sync']);
    const origins = (await req('GET', `/api/newsletter-issues/${id}/blocks/revisions`)).body.revisions.map((r: { origin: string }) => r.origin);
    assert.deepStrictEqual(origins, ['import', 'import', 'import', 'edit', 'relay-pull']);
  });

  it('refuses the whole sync when a block changed on both sides, writing nothing', async () => {
    const { id } = await imported();
    await req('PUT', `/api/newsletter-issues/${id}/blocks/rb-113`, { version: 1, data: { summary: 'DataOps version' } });
    await req('PUT', `/api/newsletter-issues/${id}/blocks/rb-115`, { version: 1, data: { events: 'Wed · Talk | Pushable | https://x.example/p' } });
    relay.editInRelay('weekly-304', 113, { summary: 'Relay version' });
    const res = await req('POST', `/api/newsletter-issues/${id}/blocks/sync`, {});
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.code, 'blocks_sync_conflict');
    assert.deepStrictEqual(res.body.conflicts.map((c: { relayBlockId: number }) => c.relayBlockId), [113]);
    assert.ok(!relay.calls.some((c) => c.startsWith('PUT')), 'no block pushed');
    assert.strictEqual(relay.issues.get('weekly-304')!.blocks[0].data.summary, 'Relay version');
    const local = (await req('GET', `/api/newsletter-issues/${id}/blocks`)).body.blocks.blocks;
    assert.strictEqual(local[0].data.summary, 'DataOps version');

    // Resolving by making both sides equal lets the sync through.
    await req('PUT', `/api/newsletter-issues/${id}/blocks/rb-113`, { version: 2, data: { summary: 'Relay version' } });
    const ok = await req('POST', `/api/newsletter-issues/${id}/blocks/sync`, {});
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.deepStrictEqual(ok.body.pushed, [115]);
  });

  it('does not overwrite a Relay edit made between planning and pushing', async () => {
    const { id } = await imported();
    await req('PUT', `/api/newsletter-issues/${id}/blocks/rb-114`, { version: 1, data: { title: 'New', cta_text: 'Go', cta_url: 'https://x.example/a' } });
    relay.beforeBlockGet = (block) => {
      block.data = { ...block.data, title: 'Concurrent Relay edit' };
      block.updated_at = relay.stamp();
      relay.beforeBlockGet = null;
    };
    const res = await req('POST', `/api/newsletter-issues/${id}/blocks/sync`, {});
    assert.strictEqual(res.status, 409);
    assert.match(res.body.error, /changed during the sync/);
    assert.strictEqual(relay.issues.get('weekly-304')!.blocks[1].data.title, 'Concurrent Relay edit');
    const next = await req('POST', `/api/newsletter-issues/${id}/blocks/sync`, { dryRun: true });
    assert.strictEqual(next.status, 409);
    assert.strictEqual(next.body.conflicts[0].relayBlockId, 114);
  });

  it('refuses to push into a Relay issue whose campaign left draft, and surfaces Relay failures', async () => {
    const { id } = await imported();
    await req('PUT', `/api/newsletter-issues/${id}/blocks/rb-113`, { version: 1, data: { summary: 'late edit' } });
    relay.issues.get('weekly-304')!.campaign = { status: 'sent' };
    const locked = await req('POST', `/api/newsletter-issues/${id}/blocks/sync`, {});
    assert.strictEqual(locked.status, 409);
    assert.strictEqual(locked.body.code, 'blocks_campaign_locked');

    relay.issues.delete('weekly-304');
    const missing = await req('POST', `/api/newsletter-issues/${id}/blocks/sync`, {});
    assert.strictEqual(missing.status, 404);
    assert.match(missing.body.error, /Relay dev GET \/api\/newsletter-issues\/weekly-304 returned HTTP 404/);

    restore();
    restore = setRelayDepsForTests({
      fetchImpl: (async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); }) as typeof fetch,
      readSecret: async (name) => SECRETS[name],
    });
    const slow = await req('POST', `/api/newsletter-issues/${id}/blocks/sync`, {});
    assert.strictEqual(slow.status, 504);
    assert.match(slow.body.error, /timed out after 15s/);
    assert.doesNotMatch(JSON.stringify(slow.body), /dev-key-456/);
  });

  it('refuses a block body over the Relay request limit before writing', async () => {
    const { id } = await imported();
    const long = Array.from({ length: 80 }, (_, i) => `Day ${i} · Talk | Title ${i} ${'x'.repeat(60)} | https://x.example/${i}`).join('\n');
    await req('PUT', `/api/newsletter-issues/${id}/blocks/rb-115`, { version: 1, data: { events: long } });
    const res = await req('POST', `/api/newsletter-issues/${id}/blocks/sync`, {});
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.body.code, 'relay_body_too_large');
    assert.ok(!relay.calls.some((c) => c.startsWith('PUT')));
  });
});

describe('newsletter block planning', () => {
  const base = (type: string, data: Record<string, string>) => ({ hash: blockHash(type, data), relayUpdatedAt: 't0', syncedAt: 't0' });
  const local = (data: Record<string, string>, baseData: Record<string, string>): IssueBlock => ({
    id: 'rb-1', relayBlockId: 1, position: 0, type: 'intro', data, version: 1, updatedAt: '', updatedBy: '', updatedByName: null, base: base('intro', baseData),
  });
  const remote = (blocks: { id: number; data: Record<string, string> }[]): RelayIssue => ({
    key: 'k', subject: 's', updated_at: 't', blocks: blocks.map((b, i) => ({ ...b, position: i, type: 'intro', updated_at: 't1' })),
  });

  it('classifies deletions in Relay and new Relay blocks', () => {
    const removed = planSync([local({ summary: 'a' }, { summary: 'a' })], remote([]));
    assert.deepStrictEqual(removed.steps.map((s) => s.action), ['remove']);
    const edited = planSync([local({ summary: 'b' }, { summary: 'a' })], remote([]));
    assert.deepStrictEqual(edited.steps.map((s) => s.action), ['conflict']);
    const added = planSync([], remote([{ id: 9, data: { summary: 'n' } }]));
    assert.deepStrictEqual(added.steps.map((s) => s.action), ['add']);
    const same = planSync([local({ summary: 'b' }, { summary: 'a' })], remote([{ id: 1, data: { summary: 'b' } }]));
    assert.deepStrictEqual(same.steps.map((s) => s.action), ['in_sync']);
  });

  it('validates like Relay: trims, drops empty fields, keeps html whitespace, checks required fields', () => {
    assert.deepStrictEqual(validateBlockData('intro', { summary: ' s ', issue_label: '' }), { summary: 's' });
    assert.deepStrictEqual(validateBlockData('html', { html: ' <b>x</b> ' }), { html: ' <b>x</b> ' });
    assert.throws(() => validateBlockData('intro', { summary: '' }), /data.summary required/);
    assert.deepStrictEqual(validateBlockData('events_list', { events: 'a | b | https://x.example' }), { events: 'a | b | https://x.example' });
  });
});
