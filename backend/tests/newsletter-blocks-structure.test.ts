import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { buildNewsletterIssue, createNewsletterIssue, getNewsletterIssue } from '../src/db/newsletterIssues';
import { createSponsorDoc } from '../src/db/sponsorDocs';
import { TABLE_NOTIFICATIONS } from '../src/db/tableNames';
import { createUser } from '../src/db/users';
import { setRelayDepsForTests } from '../src/newsletter/blocksRelay';
import { releaseRemovedSponsorBlocks } from '../src/newsletter/sponsorBlocks';
import { humanBearer } from './helpers/human-bearer';
import { FakeRelay, SECRETS } from './helpers/fake-relay';

const DOC_BASE = 'https://ops.dtcdev.click/sponsor-docs/';

describe('Newsletter issue blocks: add, move, delete, sponsor rules, sponsor-doc sync', () => {
  let client: DynamoDBDocumentClient;
  let handler: typeof import('../src/handler').handler;
  let token: string;
  let userId: string;
  let relay: FakeRelay;
  let restore: () => void;
  let seq = 0;

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

  async function newDoc(template: 'newsletter-main' | 'newsletter-secondary', content: Record<string, string>) {
    seq += 1;
    const { doc } = await createSponsorDoc(client, {
      cardId: `card-sync-${seq}`,
      template,
      title: `Doc ${seq}`,
      sponsorName: 'Acme',
      createdBy: 'test',
      content,
    });
    return doc;
  }

  const { subjectLine: _s, previewText: _p, ...SECONDARY_BASE } = {
    title: 'Ship faster', intro: 'Intro copy', bullets: '- one\n- two', closing: 'Bye',
    ctaText: 'Try it', ctaUrl: 'https://acme.example/go', graphicsUrl: 'https://acme.example/g.png',
    subjectLine: '', previewText: '',
  };
  const MAIN = {
    title: 'Ship faster', intro: 'Intro copy', bullets: '- one\n- two', closing: 'Bye',
    ctaText: 'Try it', ctaUrl: 'https://acme.example/go', graphicsUrl: 'https://acme.example/g.png',
    subjectLine: 'Ship faster today', previewText: 'A short preview',
  };

  async function setup(withDocs = true) {
    seq += 1;
    const main = withDocs ? await newDoc('newsletter-main', MAIN) : null;
    const second = withDocs ? await newDoc('newsletter-secondary', { ...SECONDARY_BASE, title: 'Second one' }) : null;
    const issue = buildNewsletterIssue(
      {
        kind: 'weekly', publicationDate: `2027-02-${String(seq % 27 + 1).padStart(2, '0')}`, issueNumber: 700 + seq, status: 'planned',
        slots: {
          ...(main ? { primary: { sponsor: 'Acme', documentUrl: `${DOC_BASE}${main.id}` } } : {}),
          ...(second ? { secondary: { sponsor: 'Beta', documentUrl: `${DOC_BASE}${second.id}` } } : {}),
        },
      },
      `issue-struct-${seq}`,
    );
    await createNewsletterIssue(client, issue);
    const key = `weekly-${900 + seq}`;
    relay.seed(key, [
      { id: 1, position: 0, type: 'intro', data: { summary: 'Hello' } },
      { id: 2, position: 1, type: 'sponsor', data: { title: 'Old title', kicker: 'SPONSORED', cta_text: 'Go', cta_url: 'https://old.example/' } },
      { id: 3, position: 2, type: 'sponsor_secondary', data: { title: 'Old second', kicker: 'SPONSORED', cta_url: 'https://old.example/2' } },
      { id: 4, position: 3, type: 'events_list', data: { events: 'Mon · Webinar | Talk | https://x.example/e' } },
      { id: 5, position: 4, type: 'recording', data: { title: 'Recording', cta_url: 'https://x.example/r' } },
    ]);
    const imp = await req('POST', `/api/newsletter-issues/${issue.id}/blocks/import`, { target: 'dev', issueKey: key });
    assert.strictEqual(imp.status, 201, JSON.stringify(imp.body));
    return { id: issue.id, key, main, second, base: `/api/newsletter-issues/${issue.id}/blocks` };
  }

  const order = (relayKey: string) => relay.issues.get(relayKey)!.blocks.map((b) => b.id);
  const writes = () => relay.calls.filter((c) => !c.startsWith('GET'));

  it('adds a block of a Relay type, edits, reorders and deletes it, and the Relay copy matches after sync', async () => {
    const { id, key, base } = await setup(false);
    const types = await req('GET', `${base}/types`);
    assert.strictEqual(types.status, 200);
    assert.ok(types.body.types.find((t: { type: string; addable: boolean }) => t.type === 'alexey_article')?.addable);
    assert.strictEqual(types.body.types.find((t: { type: string }) => t.type === 'sponsor').addable, false);

    const check = await req('GET', `${base}/types`, undefined, { check: 'relay' });
    assert.deepStrictEqual(check.body.relayCheck.missingInRelay.includes('sponsor'), false);
    assert.ok(check.body.relayCheck.missingInDataOps.length === 0);

    const added = await req('POST', base, { type: 'alexey_article', position: 4, data: { title: 'My article', cta_url: 'https://alexey.example/a' } });
    assert.strictEqual(added.status, 201, JSON.stringify(added.body));
    assert.strictEqual(added.body.block.pushState, 'new');
    assert.strictEqual(added.body.block.relayBlockId, null);
    assert.strictEqual(added.body.block.data.kicker, 'READ');
    const newId = added.body.block.id as string;
    assert.match(newId, /^nb-/);

    const edit = await req('PUT', `${base}/${newId}`, { version: 1, data: { title: 'My article v2', cta_url: 'https://alexey.example/a', kicker: 'READ' } });
    assert.strictEqual(edit.status, 200, JSON.stringify(edit.body));
    const up = await req('POST', `${base}/${newId}/move`, { direction: 'up' });
    assert.strictEqual(up.status, 200, JSON.stringify(up.body));
    assert.deepStrictEqual(up.body.blocks.blocks.map((b: { id: string }) => b.id), ['rb-1', 'rb-2', 'rb-3', newId, 'rb-4', 'rb-5']);
    assert.strictEqual(up.body.blocks.orderChanged, true);

    const del = await req('DELETE', `${base}/rb-5`);
    assert.strictEqual(del.status, 200, JSON.stringify(del.body));
    assert.deepStrictEqual(del.body.blocks.deletedPending.map((b: { id: string }) => b.id), ['rb-5']);
    assert.ok(relay.issues.get(key)!.blocks.some((b) => b.id === 5), 'Relay unchanged until sync');

    const dry = await req('POST', `${base}/sync`, { dryRun: true });
    assert.deepStrictEqual(dry.body.plan.map((s: { action: string }) => s.action).sort(), ['create', 'delete', 'in_sync', 'in_sync', 'in_sync', 'in_sync'].sort());
    assert.deepStrictEqual(writes(), [], 'dry run writes nothing');

    const sync = await req('POST', `${base}/sync`, {});
    assert.strictEqual(sync.status, 200, JSON.stringify(sync.body));
    assert.strictEqual(sync.body.created.length, 1);
    assert.deepStrictEqual(sync.body.deleted, [5]);
    const mine = relay.issues.get(key)!.blocks.find((b) => b.type === 'alexey_article')!;
    assert.strictEqual(mine.data.title, 'My article v2');
    assert.deepStrictEqual(order(key), [1, 2, 3, mine.id, 4]);
    const local = sync.body.blocks.blocks;
    assert.deepStrictEqual(local.map((b: { relayBlockId: number }) => b.relayBlockId), order(key));
    assert.ok(local.every((b: { changedSinceSync: boolean }) => !b.changedSinceSync));
    assert.strictEqual(sync.body.blocks.deletedPending.length, 0);
    assert.strictEqual(sync.body.blocks.orderChanged, false);

    const origins = (await req('GET', `${base}/revisions`)).body.revisions.map((r: { origin: string }) => r.origin);
    assert.deepStrictEqual(origins.slice(5), ['add', 'edit', 'move', 'delete']);
    const moveRev = (await req('GET', `${base}/revisions`, undefined, { block: newId })).body.revisions.find((r: { origin: string }) => r.origin === 'move');
    assert.match(moveRev.detail, /moved from position 4 to 3/);
    assert.strictEqual((await req('POST', `${base}/sync`, {})).body.plan.every((s: { action: string }) => s.action === 'in_sync'), true);
    void id;
  });

  it('moves a block in DataOps and pushes the new order to Relay without touching content', async () => {
    const { key, base } = await setup(false);
    const moved = await req('POST', `${base}/rb-5/move`, { to: 3 });
    assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));
    const sync = await req('POST', `${base}/sync`, {});
    assert.strictEqual(sync.status, 200, JSON.stringify(sync.body));
    assert.deepStrictEqual(order(key), [1, 2, 3, 5, 4]);
    assert.deepStrictEqual(sync.body.pushed, []);
  });

  it('refuses every sponsor-block violation server-side, explicitly, writing nothing', async () => {
    const { base, main } = await setup();
    relay.calls = [];
    const expectRefusal = async (res: { status: number; body: { code: string; error: string; sponsorDocUrl?: string } }, code: string) => {
      assert.strictEqual(res.status, 409, JSON.stringify(res.body));
      assert.strictEqual(res.body.code, code);
      assert.ok(res.body.error.length > 30, 'explicit message');
    };
    // Content read-only: main and secondary.
    const editMain = await req('PUT', `${base}/rb-2`, { version: 1, data: { title: 'Hand edit', cta_text: 'x', cta_url: 'https://x.example/' } });
    await expectRefusal(editMain, 'sponsor_block_readonly');
    assert.strictEqual(editMain.body.sponsorDocUrl, `${DOC_BASE}${main!.id}`);
    assert.match(editMain.body.error, /sponsor doc/i);
    await expectRefusal(await req('PUT', `${base}/rb-3`, { version: 1, data: { title: 'Hand edit', cta_url: 'https://x.example/' } }), 'sponsor_block_readonly');
    // Main is pinned: no move, no delete.
    await expectRefusal(await req('POST', `${base}/rb-2/move`, { direction: 'down' }), 'sponsor_block_pinned');
    await expectRefusal(await req('POST', `${base}/rb-2/move`, { to: 4 }), 'sponsor_block_pinned');
    await expectRefusal(await req('DELETE', `${base}/rb-2`), 'sponsor_block_pinned');
    // Nothing above the main sponsor: not by move, not by add; blocks above it stay put.
    await expectRefusal(await req('POST', `${base}/rb-4/move`, { to: 1 }), 'above_pinned_sponsor');
    await expectRefusal(await req('POST', `${base}/rb-4/move`, { to: 0 }), 'above_pinned_sponsor');
    await expectRefusal(await req('POST', `${base}/rb-1/move`, { direction: 'down' }), 'above_pinned_sponsor');
    await expectRefusal(await req('POST', base, { type: 'alexey_article', position: 1, data: { title: 'T', cta_url: 'https://x.example/' } }), 'above_pinned_sponsor');
    await expectRefusal(await req('POST', base, { type: 'alexey_article', position: 0, data: { title: 'T', cta_url: 'https://x.example/' } }), 'above_pinned_sponsor');
    // Secondary: no direct delete; sponsor blocks cannot be added by hand.
    await expectRefusal(await req('DELETE', `${base}/rb-3`), 'sponsor_block_delete_refused');
    await expectRefusal(await req('POST', base, { type: 'sponsor', data: { title: 'T', cta_text: 'x', cta_url: 'https://x.example/' } }), 'sponsor_block_doc_only');
    await expectRefusal(await req('POST', base, { type: 'sponsor_secondary', data: { title: 'T', cta_url: 'https://x.example/' } }), 'sponsor_block_doc_only');
    assert.deepStrictEqual(writes(), [], 'nothing reached Relay');
    const set = (await req('GET', base)).body.blocks;
    assert.deepStrictEqual(set.blocks.map((b: { id: string }) => b.id), ['rb-1', 'rb-2', 'rb-3', 'rb-4', 'rb-5']);
    assert.ok(set.blocks.every((b: { changedSinceSync: boolean }) => !b.changedSinceSync));
    const flags = Object.fromEntries(set.blocks.map((b: Record<string, unknown>) => [b.id, [b.readOnly, b.pinned, b.canMove, b.canDelete]]));
    assert.deepStrictEqual(flags, {
      'rb-1': [false, false, false, true], 'rb-2': [true, true, false, false], 'rb-3': [true, false, true, false],
      'rb-4': [false, false, true, true], 'rb-5': [false, false, true, true],
    });
    // Secondary may be reordered (below the main sponsor).
    const down = await req('POST', `${base}/rb-3/move`, { direction: 'down' });
    assert.strictEqual(down.status, 200, JSON.stringify(down.body));
    assert.deepStrictEqual(down.body.blocks.blocks.map((b: { id: string }) => b.id), ['rb-1', 'rb-2', 'rb-4', 'rb-3', 'rb-5']);
  });

  it('fails a sync loudly when a block was deleted here but edited in Relay, or the order changed on both sides', async () => {
    const { key, base } = await setup(false);
    await req('DELETE', `${base}/rb-4`);
    relay.editInRelay(key, 4, { events: 'Tue · Workshop | Edited in Relay | https://x.example/n' });
    const conflict = await req('POST', `${base}/sync`, {});
    assert.strictEqual(conflict.status, 409);
    assert.strictEqual(conflict.body.code, 'blocks_sync_conflict');
    assert.match(conflict.body.error, /deleted in DataOps but edited in Relay/);
    assert.ok(relay.issues.get(key)!.blocks.some((b) => b.id === 4), 'not deleted in Relay');
    assert.deepStrictEqual(writes(), []);

    const other = await setup(false);
    await req('POST', `${other.base}/rb-5/move`, { to: 3 });
    const live = relay.issues.get(other.key)!;
    live.blocks.find((b) => b.id === 1)!.position = 9;
    live.blocks.sort((a, b) => a.position - b.position);
    live.blocks.forEach((b, i) => { b.position = i; });
    const both = await req('POST', `${other.base}/sync`, {});
    assert.strictEqual(both.status, 409);
    assert.match(both.body.error, /reordered in DataOps and in Relay/);
  });

  it('syncs the sponsor doc into the issue block and the Relay block, subject and preview on every doc save', async () => {
    const { id, key, main, second, base } = await setup();
    relay.calls = [];
    const save = await req('PUT', `/api/sponsor-docs/${main!.id}`, { content: { ...MAIN, title: 'Ship even faster' } });
    assert.strictEqual(save.status, 200, JSON.stringify(save.body));
    assert.strictEqual(save.body.doc.newsletterSync.status, 'ok', JSON.stringify(save.body.doc.newsletterSync));
    const relayBlock = relay.issues.get(key)!.blocks.find((b) => b.id === 2)!;
    assert.deepStrictEqual(relayBlock.data, {
      kicker: 'SPONSORED', title: 'Ship even faster', image_url: 'https://acme.example/g.png', image_link: 'https://acme.example/go',
      body: 'Intro copy', bullets: 'one\ntwo', closing: 'Bye', cta_text: 'Try it', cta_url: 'https://acme.example/go',
    });
    assert.strictEqual(relay.issues.get(key)!.subject, 'Ship faster today | DataTalks.Club Weekly');
    assert.strictEqual(relay.previews.get(key), 'A short preview');
    const set = (await req('GET', base)).body.blocks;
    assert.strictEqual(set.blocks[1].data.title, 'Ship even faster');
    assert.strictEqual(set.blocks[1].changedSinceSync, false);
    assert.strictEqual(set.sponsorSync.primary.ok, true);
    const revs = (await req('GET', `${base}/revisions`, undefined, { block: 'rb-2' })).body.revisions;
    assert.strictEqual(revs[revs.length - 1].origin, 'sponsor-doc');
    assert.deepStrictEqual(revs[revs.length - 1].changes.map((c: { field: string }) => c.field).includes('title'), true);
    // Other blocks and the secondary were not touched by the primary doc's save.
    assert.strictEqual(relay.issues.get(key)!.blocks.find((b) => b.id === 3)!.data.title, 'Old second');

    const again = await req('PUT', `/api/sponsor-docs/${main!.id}`, { content: { ...MAIN, title: 'Ship even faster' } });
    assert.strictEqual(again.body.doc.newsletterSync.status, 'ok');
    assert.strictEqual(relay.issueEdits.length, 1, 'unchanged subject is not rewritten');

    const sec = await req('PUT', `/api/sponsor-docs/${second!.id}`, { content: { ...SECONDARY_BASE, title: 'Second one' } });
    assert.strictEqual(sec.body.doc.newsletterSync.status, 'ok', JSON.stringify(sec.body.doc.newsletterSync));
    assert.strictEqual(relay.issues.get(key)!.blocks.find((b) => b.id === 3)!.data.title, 'Second one');
    assert.strictEqual(relay.issues.get(key)!.subject, 'Ship faster today | DataTalks.Club Weekly', 'only the primary doc owns the subject');
    void id;
  });

  it('fails the doc sync loudly (never overwrites Relay), alerts, and can be forced explicitly', async () => {
    const { id, key, main, base } = await setup();
    relay.editInRelay(key, 2, { kicker: 'SPONSORED', title: 'Orin hand edit', cta_text: 'Go', cta_url: 'https://old.example/' });
    const save = await req('PUT', `/api/sponsor-docs/${main!.id}`, { content: MAIN });
    assert.strictEqual(save.status, 200, 'the doc save itself succeeds');
    assert.strictEqual(save.body.doc.newsletterSync.status, 'failed');
    assert.match(save.body.doc.newsletterSync.message, /Sync refused|conflict|differs/i);
    assert.strictEqual(relay.issues.get(key)!.blocks.find((b) => b.id === 2)!.data.title, 'Orin hand edit');
    const sets = (await req('GET', base)).body.blocks;
    assert.strictEqual(sets.sponsorSync.primary.ok, false);
    const reload = await req('GET', `/api/sponsor-docs/${main!.id}`);
    assert.strictEqual(reload.body.doc.newsletterSync.status, 'failed', 'the failure stays visible after reload');
    const alerts = (await client.send(new ScanCommand({ TableName: TABLE_NOTIFICATIONS }))).Items!
      .filter((item) => item.type === 'newsletter-sponsor-sync-failed');
    assert.ok(alerts.length >= 1);
    assert.match(String(alerts[0].message), /did not sync/);

    const forced = await req('POST', `${base}/sponsor-sync`, { slot: 'primary', force: true });
    assert.strictEqual(forced.status, 200, JSON.stringify(forced.body));
    assert.strictEqual(relay.issues.get(key)!.blocks.find((b) => b.id === 2)!.data.title, 'Ship faster');
    void id;
  });

  it('skips with a visible reason when the issue has no blocks or the doc is incomplete, and a Relay outage is a loud failure', async () => {
    const bare = await setup(true);
    // Unimported issue: a new issue linked to a new doc.
    seq += 1;
    const doc = await newDoc('newsletter-main', MAIN);
    const issue = buildNewsletterIssue(
      { kind: 'weekly', publicationDate: '2027-03-01', issueNumber: 800 + seq, status: 'planned', slots: { primary: { sponsor: 'Acme', documentUrl: `${DOC_BASE}${doc.id}` } } },
      `issue-bare-${seq}`,
    );
    await createNewsletterIssue(client, issue);
    const saved = await req('PUT', `/api/sponsor-docs/${doc.id}`, { content: MAIN });
    assert.strictEqual(saved.body.doc.newsletterSync.status, 'skipped');
    assert.match(saved.body.doc.newsletterSync.message, /no content blocks in DataOps yet/);

    const incomplete = await req('PUT', `/api/sponsor-docs/${bare.main!.id}`, { content: { ...MAIN, title: '', ctaText: '' } });
    assert.strictEqual(incomplete.body.doc.newsletterSync.status, 'skipped');
    assert.match(incomplete.body.doc.newsletterSync.message, /missing: title, cta_text/);
    assert.strictEqual(relay.issues.get(bare.key)!.blocks.find((b) => b.id === 2)!.data.title, 'Old title');

    restore();
    restore = setRelayDepsForTests({
      fetchImpl: (async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); }) as typeof fetch,
      readSecret: async (name) => SECRETS[name],
    });
    const down = await req('PUT', `/api/sponsor-docs/${bare.main!.id}`, { content: { ...MAIN, title: 'Outage test' } });
    assert.strictEqual(down.status, 200);
    assert.strictEqual(down.body.doc.newsletterSync.status, 'failed');
    assert.match(down.body.doc.newsletterSync.message, /timed out after 15s/);
  });

  it('removes the secondary sponsor block (here and in Relay) when its slot leaves the issue; the main block stays', async () => {
    const { id, key, base } = await setup();
    const before = (await getNewsletterIssue(client, id))!;
    const after = { ...before, slots: { primary: before.slots.primary, secondary: { ...before.slots.secondary, documentUrl: undefined } } };
    const released = await releaseRemovedSponsorBlocks(client, before, after, { id: userId, name: 'Alexey' });
    assert.strictEqual(released?.status, 'ok', JSON.stringify(released));
    assert.ok(!relay.issues.get(key)!.blocks.some((b) => b.id === 3), 'removed from Relay');
    const set = (await req('GET', base)).body.blocks;
    assert.deepStrictEqual(set.blocks.map((b: { id: string }) => b.id), ['rb-1', 'rb-2', 'rb-4', 'rb-5']);
    const none = await releaseRemovedSponsorBlocks(client, before, { ...before, slots: { ...before.slots, primary: undefined } }, { id: userId, name: 'Alexey' });
    assert.strictEqual(none, null, 'the pinned main block is not removed with its slot');
  });
});
