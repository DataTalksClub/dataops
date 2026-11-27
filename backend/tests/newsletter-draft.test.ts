import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { buildNewsletterIssue, createNewsletterIssue, updateNewsletterIssue, getNewsletterIssue } from '../src/db/newsletterIssues';
import { createSponsorDoc } from '../src/db/sponsorDocs';
import { TABLE_ARTIFACTS } from '../src/db/tableNames';
import { createUser } from '../src/db/users';
import { setRelayDepsForTests } from '../src/newsletter/relayTransport';
import { humanBearer } from './helpers/human-bearer';
import { FakeRelay, SECRETS } from './helpers/fake-relay';

const DOC_BASE = 'https://ops.dtcdev.click/sponsor-docs/';
const NOW = Date.parse('2027-03-01T09:00:00Z');

/** DataTalks.Club's own course promo, used as the sponsor content of a slot without an external sponsor. */
const OWN_PROMO = {
  title: 'Join the free Data Engineering Zoomcamp',
  intro: 'A free nine-week course on data engineering by DataTalks.Club.',
  bullets: '- Docker and Terraform\n- Workflow orchestration\n- Batch and streaming',
  closing: 'Learn in public with thousands of students.',
  ctaText: 'Register for free',
  ctaUrl: 'https://github.com/DataTalksClub/data-engineering-zoomcamp',
  graphicsUrl: 'https://datatalks.club/images/zoomcamp.png',
  subjectLine: 'Data Engineering Zoomcamp starts soon',
  previewText: 'A free course by DataTalks.Club',
};

describe('Newsletter drafts: built in DataOps, approved by the owner, sent through Relay', () => {
  let client: DynamoDBDocumentClient;
  let handler: typeof import('../src/handler').handler;
  const users: Record<string, { id: string; token: string }> = {};
  let relay: FakeRelay;
  let restore: () => void;
  let seq = 0;
  /** Every fetch any code made to a Relay host, outside the transport's injected client too. */
  let strayRelayFetches: string[] = [];
  const realFetch = globalThis.fetch;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    process.env.IS_LOCAL = 'true';
    handler = (await import('../src/handler')).handler;
    for (const [name, email, role] of [
      ['owner', 'alexey@datatalks.club', 'admin'],
      ['agent', 'orin@datatalks.club', 'admin'],
      ['operator', 'valeriia@datatalks.club', 'operator'],
    ] as const) {
      const user = await createUser(client, { email, name, passwordHash: 'x', role });
      users[name] = { id: user.id, token: await humanBearer(client, user.id) };
    }
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (/relay\.datatalks\.club/.test(url)) strayRelayFetches.push(url);
      return realFetch(input as string, init);
    }) as typeof fetch;
  });

  after(async () => {
    globalThis.fetch = realFetch;
    await stopLocal();
    delete process.env.IS_LOCAL;
  });

  beforeEach(() => {
    restore?.();
    relay = new FakeRelay();
    strayRelayFetches = [];
    restore = setRelayDepsForTests({
      fetchImpl: relay.fetch as typeof fetch,
      readSecret: async (name) => {
        if (!(name in SECRETS)) throw new Error('missing');
        return SECRETS[name];
      },
      now: () => NOW,
    });
  });

  async function req(method: string, path: string, body?: unknown, options: { as?: string; query?: Record<string, string> } = {}) {
    const user = users[options.as || 'owner'];
    const res = await handler(
      {
        httpMethod: method,
        path,
        headers: { authorization: `Bearer ${user.token}`, 'x-user-id': user.id, host: 'ops.dtcdev.click', 'x-forwarded-proto': 'https' },
        queryStringParameters: options.query || null,
        body: body === undefined ? null : JSON.stringify(body),
      },
      {},
    );
    const text = res.body || '';
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.statusCode, body: parsed, headers: res.headers || {} };
  }

  async function newIssue(slots: Record<string, unknown> = {}) {
    seq += 1;
    const issue = buildNewsletterIssue(
      { kind: 'weekly', publicationDate: `2027-03-${String(seq + 1).padStart(2, '0')}`, issueNumber: 800 + seq, status: 'drafting', slots },
      `draft-test-${seq}`,
    );
    await createNewsletterIssue(client, issue);
    return { id: issue.id, number: issue.issueNumber as number, base: `/api/newsletter-issues/${issue.id}/draft` };
  }

  async function ownDoc(content: Record<string, string> = OWN_PROMO) {
    seq += 1;
    const { doc } = await createSponsorDoc(client, {
      cardId: `card-own-${seq}`,
      template: 'newsletter-main',
      title: 'DataTalks.Club own promo',
      sponsorName: 'DataTalks.Club',
      createdBy: 'test',
      content,
    });
    return doc;
  }

  /** A complete draft: subject, a filled intro, an own sponsor block and two content blocks. */
  async function completeDraft() {
    const issue = await newIssue();
    const created = await req('POST', issue.base);
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    let draft = created.body.draft;
    const intro = draft.blocks[0];
    draft = (await req('PUT', `${issue.base}/blocks/${intro.id}`, { version: intro.version, data: { issue_label: intro.data.issue_label, summary: 'This week: **Zoomcamp** news.' } })).body.draft;
    draft = (await req('POST', `${issue.base}/blocks`, {
      type: 'sponsor',
      data: { title: OWN_PROMO.title, body: OWN_PROMO.intro, cta_text: OWN_PROMO.ctaText, cta_url: OWN_PROMO.ctaUrl, image_url: OWN_PROMO.graphicsUrl, image_link: OWN_PROMO.ctaUrl },
    })).body.draft;
    draft = (await req('POST', `${issue.base}/blocks`, { type: 'events_list', data: { events: 'Mon, Mar 8 · Webinar | Building data products | https://datatalks.club/events/x.html | with Alexey' } })).body.draft;
    draft = (await req('POST', `${issue.base}/blocks`, { type: 'recording', data: { title: 'Last week: dbt in production', cta_text: 'Watch', cta_url: 'https://www.youtube.com/watch?v=abc' } })).body.draft;
    draft = (await req('PUT', issue.base, { version: draft.version, subject: 'Zoomcamp is back | DataTalks.Club Weekly', previewText: 'Free course, events and recordings' })).body.draft;
    return { issue, draft };
  }

  async function approve(issue: { base: string }) {
    const draft = (await req('GET', issue.base)).body.draft;
    const approved = await req('POST', `${issue.base}/approve`, { version: draft.version, payloadHash: draft.payloadHash, note: 'reviewed' });
    assert.strictEqual(approved.status, 200, JSON.stringify(approved.body));
    return approved.body.draft;
  }

  it('starts an empty draft without any Relay call, then builds it block by block', async () => {
    const issue = await newIssue();
    const missing = await req('GET', issue.base);
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.body.code, 'draft_missing');

    const created = await req('POST', issue.base);
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const draft = created.body.draft;
    assert.deepStrictEqual(draft.blocks.map((b: any) => b.type), ['intro']);
    assert.match(draft.blocks[0].data.issue_label, new RegExp(`^#${issue.number} · March \\d+, 2027$`));
    assert.strictEqual(draft.subject, '');
    assert.strictEqual(draft.approval.state, 'none');
    assert.strictEqual((await req('POST', issue.base)).body.code, 'draft_exists');

    const types = (await req('GET', `${issue.base}/types`)).body.types;
    assert.ok(types.find((t: any) => t.type === 'sponsor').addable, 'a slot without a sponsor doc takes a hand-made sponsor block');
    assert.ok(types.find((t: any) => t.type === 'link_list').fields.some((f: any) => f.name === 'links'));

    // Incomplete blocks save (the draft is built step by step) but bad URLs never do.
    const partial = await req('POST', `${issue.base}/blocks`, { type: 'recording', data: { title: '' } });
    assert.strictEqual(partial.status, 201, JSON.stringify(partial.body));
    assert.ok(partial.body.block.problems.some((p: string) => /title is required/.test(p)));
    const bad = await req('PUT', `${issue.base}/blocks/${partial.body.block.id}`, { version: 1, data: { title: 'x', cta_url: 'javascript:alert(1)' } });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.body.fields['data.cta_url'], 'invalid_url');

    const events = await req('POST', `${issue.base}/blocks`, { type: 'events_list', data: { events: 'Tue · Talk | Title | https://x.example/e' }, position: 1 });
    assert.deepStrictEqual(events.body.draft.blocks.map((b: any) => b.type), ['intro', 'events_list', 'recording']);
    const moved = await req('POST', `${issue.base}/blocks/${events.body.block.id}/move`, { direction: 'down' });
    assert.deepStrictEqual(moved.body.draft.blocks.map((b: any) => b.type), ['intro', 'recording', 'events_list']);
    const removed = await req('DELETE', `${issue.base}/blocks/${partial.body.block.id}`);
    assert.deepStrictEqual(removed.body.draft.blocks.map((b: any) => b.type), ['intro', 'events_list']);

    const stale = await req('PUT', issue.base, { version: 1, subject: 'Late' });
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(stale.body.code, 'draft_version_conflict');

    const revisions = (await req('GET', `${issue.base}/revisions`)).body.revisions.map((r: any) => r.origin);
    assert.deepStrictEqual(revisions, ['create', 'add', 'add', 'move', 'delete']);
    assert.deepStrictEqual(relay.calls, [], 'building a draft never calls Relay');
    assert.deepStrictEqual(strayRelayFetches, []);
  });

  it('renders the whole email itself: shell, subject, preheader, images, buttons, sections and a text part', async () => {
    const { issue, draft } = await completeDraft();
    const render = (await req('GET', `${issue.base}/render`)).body.render;
    assert.strictEqual(render.subject, 'Zoomcamp is back | DataTalks.Club Weekly');
    assert.strictEqual(render.payloadHash, draft.payloadHash);
    assert.deepStrictEqual(render.problems, []);
    assert.match(render.html, /^<!DOCTYPE html>/);
    assert.match(render.html, /<title>Zoomcamp is back \| DataTalks\.Club Weekly<\/title>/);
    assert.ok(render.html.includes('Free course, events and recordings'), 'preheader');
    assert.ok(render.html.includes(`src="${OWN_PROMO.graphicsUrl}"`), 'sponsor image');
    assert.ok(render.html.includes('class="mceSection46"'), 'the sponsor card is the lavender promo section');
    assert.ok(render.html.includes(`href="${OWN_PROMO.ctaUrl}" target="_blank" class="mceButtonLink"`), 'CTA button');
    assert.ok(render.html.includes('<strong>Zoomcamp</strong>'), 'intro Markdown');
    assert.ok(render.html.includes('Building data products</a> with Alexey'), 'events list');
    assert.ok(render.html.includes('list-manage.com/unsubscribe'), 'footer unsubscribe link for Relay to rewrite');
    assert.match(render.html, /\/api\/newsletter-view\/[A-Za-z0-9_-]+/, 'web view link');
    assert.ok(!render.html.includes('<!--RELAY:'), 'every marker filled');
    assert.match(render.text, /SPONSORED\n\n\n\*\* Join the free Data Engineering Zoomcamp/);
    assert.match(render.text, /Register for free \(https:\/\/github\.com\/DataTalksClub\/data-engineering-zoomcamp\)/);

    // Markdown escapes raw HTML and drops unsafe links.
    const intro = draft.blocks[0];
    const nasty = await req('PUT', `${issue.base}/blocks/${intro.id}`, { version: intro.version, data: { summary: '<script>x()</script> [click](javascript:alert(1))' } });
    const html = (await req('GET', `${issue.base}/render`)).body.render.html as string;
    assert.ok(!html.includes('<script>x()'), JSON.stringify(nasty.body).slice(0, 200));
    assert.ok(html.includes('&lt;script&gt;x()&lt;/script&gt; <a href="#" target="_blank">click</a>'));

    // The live preview renders unsaved editor state and writes nothing.
    const before = (await req('GET', issue.base)).body.draft;
    const preview = await req('POST', `${issue.base}/preview`, { subject: 'Unsaved subject', blocks: [{ type: 'feature', data: { title: 'Unsaved feature' } }] });
    assert.strictEqual(preview.status, 200);
    assert.ok(preview.body.preview.html.includes('Unsaved feature'));
    assert.strictEqual((await req('GET', issue.base)).body.draft.version, before.version);

    // The editor view marks incomplete blocks; the payload never carries that note.
    await req('POST', `${issue.base}/blocks`, { type: 'feature', data: {} });
    const editorView = (await req('GET', `${issue.base}/render`, undefined, { query: { mode: 'editor' } })).body.render;
    assert.ok(editorView.html.includes('Needs content:</strong> Feature'));
    assert.ok(!(await req('GET', `${issue.base}/render`)).body.render.html.includes('Needs content'));
    assert.deepStrictEqual(relay.calls, []);
  });

  it('takes sponsor content without an external sponsor and stages sponsor-doc saves locally only', async () => {
    // A hand-made own DataTalks.Club promo in a slot without a doc is a normal, editable block.
    const { issue, draft } = await completeDraft();
    const sponsor = draft.blocks.find((b: any) => b.type === 'sponsor');
    assert.strictEqual(sponsor.readOnly, false);
    assert.strictEqual(draft.blocks.indexOf(sponsor), 1, 'the main sponsor block goes right under the intro');
    assert.strictEqual((await req('POST', `${issue.base}/blocks`, { type: 'sponsor', data: { title: 'Twice' } })).body.code, 'sponsor_block_exists');

    // A slot with a sponsor doc (here DataTalks.Club itself, no invoice or outreach): saving the doc stages it.
    const doc = await ownDoc();
    const docIssue = await newIssue({ primary: { sponsor: 'DataTalks.Club', documentUrl: `${DOC_BASE}${doc.id}` } });
    const started = await req('POST', docIssue.base);
    assert.strictEqual(started.status, 201, JSON.stringify(started.body));
    assert.strictEqual(started.body.sponsorStaging[0].status, 'ok', JSON.stringify(started.body.sponsorStaging));
    let staged = started.body.draft;
    const block = staged.blocks.find((b: any) => b.type === 'sponsor');
    assert.deepStrictEqual(block.data, {
      kicker: 'SPONSORED', title: OWN_PROMO.title, image_url: OWN_PROMO.graphicsUrl, image_link: OWN_PROMO.ctaUrl,
      body: OWN_PROMO.intro, bullets: 'Docker and Terraform\nWorkflow orchestration\nBatch and streaming', closing: OWN_PROMO.closing,
      cta_text: OWN_PROMO.ctaText, cta_url: OWN_PROMO.ctaUrl,
    });
    assert.strictEqual(block.readOnly, true);
    assert.strictEqual(block.sponsorDocUrl, `${DOC_BASE}${doc.id}`);
    assert.strictEqual(staged.subject, 'Data Engineering Zoomcamp starts soon | DataTalks.Club Weekly');
    assert.strictEqual((await req('PUT', `${docIssue.base}/blocks/${block.id}`, { version: block.version, data: { title: 'x' } })).body.code, 'sponsor_block_readonly');

    const save = await req('PUT', `/api/sponsor-docs/${doc.id}`, { content: { ...OWN_PROMO, title: 'Data Engineering Zoomcamp 2027' } });
    assert.strictEqual(save.status, 200, JSON.stringify(save.body));
    assert.strictEqual(save.body.doc.newsletterSync.status, 'ok', JSON.stringify(save.body.doc.newsletterSync));
    assert.match(save.body.doc.newsletterSync.message, /staged in the DataOps draft/);
    staged = (await req('GET', docIssue.base)).body.draft;
    assert.strictEqual(staged.blocks.find((b: any) => b.type === 'sponsor').data.title, 'Data Engineering Zoomcamp 2027');
    const revs = (await req('GET', `${docIssue.base}/revisions`)).body.revisions;
    assert.strictEqual(revs[revs.length - 1].origin, 'sponsor-doc');
    assert.deepStrictEqual(relay.calls, [], 'sponsor-doc saves never reach Relay');
    assert.deepStrictEqual(strayRelayFetches, []);
  });

  it('lets only the owner approve the exact reviewed revision; any later edit withdraws the approval', async () => {
    const { issue, draft } = await completeDraft();
    for (const as of ['agent', 'operator']) {
      const denied = await req('POST', `${issue.base}/approve`, { version: draft.version, payloadHash: draft.payloadHash }, { as });
      assert.strictEqual(denied.status, 403, as);
      assert.strictEqual(denied.body.code, 'newsletter_owner_required');
    }
    const wrongHash = await req('POST', `${issue.base}/approve`, { version: draft.version, payloadHash: 'f'.repeat(64) });
    assert.strictEqual(wrongHash.status, 409);
    assert.strictEqual(wrongHash.body.code, 'draft_changed');

    const approved = await approve(issue);
    assert.strictEqual(approved.approval.state, 'current');
    assert.strictEqual(approved.approval.approvedByName, 'owner');
    assert.strictEqual(approved.approval.payloadHash, draft.payloadHash);

    const recording = approved.blocks.find((b: any) => b.type === 'recording');
    const edited = await req('PUT', `${issue.base}/blocks/${recording.id}`, { version: recording.version, data: { ...recording.data, title: 'Changed after approval' } }, { as: 'operator' });
    assert.strictEqual(edited.status, 200);
    assert.strictEqual(edited.body.draft.approval.state, 'none');
    const origins = (await req('GET', `${issue.base}/revisions`)).body.revisions.map((r: any) => r.origin);
    assert.deepStrictEqual(origins.slice(-3), ['approve', 'edit', 'approval-withdrawn']);

    const blocked = await req('POST', `${issue.base}/test-send`, { emails: ['alexey@datatalks.club'], requestId: 'test-after-edit-1' });
    assert.strictEqual(blocked.status, 409);
    assert.strictEqual(blocked.body.code, 'approval_required');

    const incomplete = await newIssue();
    const fresh = (await req('POST', incomplete.base)).body.draft;
    const refused = await req('POST', `${incomplete.base}/approve`, { version: fresh.version, payloadHash: fresh.payloadHash });
    assert.strictEqual(refused.status, 422);
    assert.strictEqual(refused.body.code, 'draft_incomplete');
    assert.deepStrictEqual(relay.calls, [], 'review and approval never call Relay');
  });

  it('test-sends only the frozen approved payload, once per request id, through the campaign API', async () => {
    const { issue } = await completeDraft();
    const approved = await approve(issue);
    const sent = await req('POST', `${issue.base}/test-send`, { emails: ['alexey@datatalks.club'], requestId: 'test-send-0001' });
    assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
    assert.strictEqual(sent.body.testSend.status, 'provider_accepted');
    const key = `dataops-newsletter-${issue.number}-${issue.id.slice(0, 12)}`;
    assert.strictEqual(sent.body.testSend.campaignKey, key);
    assert.deepStrictEqual(relay.calls.map((c) => `${c.method} ${c.path}`), [
      `GET /api/campaigns/${key}`, `PUT /api/campaigns/${key}`, `POST /api/campaigns/${key}/test-send`,
    ]);
    const campaign = relay.campaigns.get(key)!;
    const render = (await req('GET', `${issue.base}/render`)).body.render;
    assert.strictEqual(campaign.html_body, render.html, 'Relay got exactly the approved HTML');
    assert.strictEqual(campaign.text_body, render.text);
    assert.strictEqual(campaign.subject, render.subject);
    assert.strictEqual(campaign.preview_text, render.previewText);
    assert.strictEqual(campaign.status, 'draft', 'a test send never queues');
    assert.strictEqual(campaign.audience, 'dtc');
    assert.strictEqual(campaign.metadata.dataops_payload_sha256, approved.approval.payloadHash);
    assert.strictEqual(relay.apiKeySeen, 'Bearer prod-key-1');

    const replay = await req('POST', `${issue.base}/test-send`, { emails: ['alexey@datatalks.club'], requestId: 'test-send-0001' });
    assert.strictEqual(replay.body.testSend.replayed, true);
    assert.strictEqual(relay.testSends.length, 1, 'a replayed request id never sends again');
    assert.strictEqual((await req('POST', `${issue.base}/test-send`, { emails: ['a@x.example', 'b@x.example', 'c@x.example'], requestId: 'test-send-0002' })).body.code, 'test_recipients_too_many');
    assert.strictEqual((await req('POST', `${issue.base}/test-send`, { emails: ['alexey@datatalks.club'], requestId: 'test-send-0003' }, { as: 'agent' })).status, 403);
    assert.ok(relay.calls.every((c) => c.path.startsWith('/api/campaigns/')), 'no block-level or issue-level Relay writes');
  });

  it('schedules once under races and lost responses, locks the draft, serves the web view, and cancels', async () => {
    const { issue } = await completeDraft();
    const approved = await approve(issue);
    const key = `dataops-newsletter-${issue.number}-${issue.id.slice(0, 12)}`;
    const at = new Date(NOW + 3 * 86_400_000).toISOString();
    const schedule = (requestId: string, overrides: Record<string, unknown> = {}) => req('POST', `${issue.base}/schedule`, {
      scheduledAt: at, payloadHash: approved.payloadHash, version: approved.version, requestId, ...overrides,
    });
    assert.strictEqual((await schedule('sched-too-soon', { scheduledAt: new Date(NOW + 5 * 60_000).toISOString() })).body.code, 'schedule_too_soon');
    assert.strictEqual((await schedule('sched-bad-hash', { payloadHash: 'a'.repeat(64) })).body.code, 'payload_not_confirmed');
    const asAgent = await req('POST', `${issue.base}/schedule`, { scheduledAt: at, payloadHash: approved.payloadHash, version: approved.version, requestId: 'sched-agent-1' }, { as: 'agent' });
    assert.strictEqual(asAgent.status, 403);
    assert.deepStrictEqual(relay.calls, [], 'refused schedules never reach Relay');

    // Two concurrent schedule requests: exactly one reaches Relay.
    relay.calls = [];
    relay.queueDelayMs = 30;
    const [first, second] = await Promise.all([schedule('sched-race-a'), schedule('sched-race-b')]);
    relay.queueDelayMs = 0;
    const winners = [first, second].filter((r) => r.status === 200);
    assert.ok(winners.length >= 1);
    assert.strictEqual(relay.calls.filter((c) => c.path.endsWith('/queue')).length, 1, JSON.stringify([first.body, second.body]));
    const delivery = (await req('GET', `${issue.base}/delivery`)).body.delivery;
    assert.strictEqual(delivery.state, 'scheduled');
    assert.strictEqual(relay.campaigns.get(key)!.status, 'scheduled');
    assert.strictEqual(relay.campaigns.get(key)!.scheduled_at, at);

    const draft = (await req('GET', issue.base)).body.draft;
    assert.strictEqual(draft.locked, true);
    const recording = draft.blocks.find((b: any) => b.type === 'recording');
    assert.strictEqual((await req('PUT', `${issue.base}/blocks/${recording.id}`, { version: recording.version, data: { title: 'late' } })).body.code, 'draft_locked');
    assert.strictEqual((await schedule('sched-other')).body.code, 'already_scheduled');
    assert.strictEqual((await schedule(delivery.requestId)).body.replayed, true);

    const token = draft.webViewUrl.split('/').pop();
    const view = await req('GET', `/api/newsletter-view/${token}`);
    assert.strictEqual(view.status, 200);
    assert.ok(String(view.body).includes('Join the free Data Engineering Zoomcamp'));
    assert.ok(!String(view.body).includes('list-manage.com/unsubscribe'), 'the public view disables per-recipient links');
    assert.match(String(view.headers['content-security-policy']), /default-src 'none'/);

    const cancelled = await req('POST', `${issue.base}/cancel`);
    assert.strictEqual(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.strictEqual(cancelled.body.delivery.state, 'cancelled');
    assert.strictEqual(relay.campaigns.get(key)!.status, 'cancelled');
    assert.strictEqual((await req('GET', `/api/newsletter-view/${token}`)).status, 404);
    assert.strictEqual(cancelled.body.draft.locked, false);

    // After a cancel the next delivery is a new Relay campaign; a lost queue response is adopted on retry.
    const again = (await req('GET', issue.base)).body.draft;
    relay.calls = [];
    relay.failNextQueueResponse = 504;
    const lost = await req('POST', `${issue.base}/schedule`, { scheduledAt: at, payloadHash: again.payloadHash, version: again.version, requestId: 'sched-lost-1' });
    assert.strictEqual(lost.status, 502);
    assert.strictEqual((await req('GET', `${issue.base}/delivery`)).body.delivery.state, 'failed');
    assert.strictEqual(relay.campaigns.get(`${key}-r2`)!.status, 'scheduled', 'Relay did schedule it');
    const retryDraft = (await req('GET', issue.base)).body.draft;
    const retry = await req('POST', `${issue.base}/schedule`, { scheduledAt: at, payloadHash: retryDraft.payloadHash, version: retryDraft.version, requestId: 'sched-lost-2' });
    assert.strictEqual(retry.status, 200, JSON.stringify(retry.body));
    assert.strictEqual(retry.body.adopted, true);
    assert.strictEqual(relay.calls.filter((c) => c.path.endsWith('/queue')).length, 1, 'the retry adopted the campaign instead of queueing again');
    assert.strictEqual(relay.calls.filter((c) => c.method === 'PUT').length, 1);
    assert.ok(relay.calls.every((c) => c.path.startsWith('/api/campaigns/')));
  });

  it('keeps an archived draft first built by the retired Relay import readable and editable', async () => {
    const issue = await newIssue();
    await client.send(new PutCommand({
      TableName: TABLE_ARTIFACTS,
      Item: {
        PK: `NL_BLOCKS#${issue.id}`, SK: 'SET', issueId: issue.id,
        relay: { target: 'production', issueKey: 'weekly-305' },
        relayIssue: { subject: 'Archived subject', previewText: 'Archived preview', campaignStatus: 'draft', updatedAt: '2026-11-20T10:00:00Z' },
        blocks: [{ id: 'rb-1', relayBlockId: 1, position: 0, type: 'intro', data: { summary: 'Hello' }, version: 3, updatedAt: '2026-11-20T10:00:00Z', updatedBy: 'u', updatedByName: 'Alexey', base: { hash: 'h', relayUpdatedAt: 'x', syncedAt: 'y' } }],
        deleted: [], orderBase: [1], orderDirty: false, lastSync: null, version: 7, createdAt: '2026-11-20T10:00:00Z', updatedAt: '2026-11-20T10:00:00Z',
      },
    }));
    const draft = (await req('GET', issue.base)).body.draft;
    assert.strictEqual(draft.subject, 'Archived subject');
    assert.strictEqual(draft.blocks[0].id, 'rb-1');
    const edited = await req('PUT', `${issue.base}/blocks/rb-1`, { version: 3, data: { summary: 'Hello again' } });
    assert.strictEqual(edited.status, 200, JSON.stringify(edited.body));
    const stored = await client.send(new (await import('@aws-sdk/lib-dynamodb')).GetCommand({ TableName: TABLE_ARTIFACTS, Key: { PK: `NL_BLOCKS#${issue.id}`, SK: 'SET' } }));
    assert.deepStrictEqual(stored.Item!.relay, { target: 'production', issueKey: 'weekly-305' }, 'archived Relay attributes are preserved');
    assert.strictEqual(stored.Item!.blocks[0].relayBlockId, 1);
    assert.ok(stored.Item!.webViewToken, 'the first save gives it a web-view link');
    assert.deepStrictEqual(relay.calls, []);
  });

  it('removes a doc-owned secondary block locally when its slot loses the doc', async () => {
    const doc = await ownDoc();
    const secondDoc = await ownDoc({ ...OWN_PROMO, subjectLine: '', previewText: '', title: 'Second slot promo' });
    const issue = await newIssue({
      primary: { sponsor: 'DataTalks.Club', documentUrl: `${DOC_BASE}${doc.id}` },
      secondary: { sponsor: 'DataTalks.Club', documentUrl: `${DOC_BASE}${secondDoc.id}` },
    });
    const draft = (await req('POST', issue.base)).body.draft;
    assert.deepStrictEqual(draft.blocks.map((b: any) => b.type), ['intro', 'sponsor', 'sponsor_secondary']);
    const stored = await getNewsletterIssue(client, issue.id);
    const res = await req('DELETE', `/api/newsletter-issues/${issue.id}/slots/secondary`, { version: stored!.version, confirmSlotRemoval: true });
    void updateNewsletterIssue;
    assert.ok(res.status < 300, JSON.stringify(res.body));
    const after = (await req('GET', issue.base)).body.draft;
    assert.deepStrictEqual(after.blocks.map((b: any) => b.type), ['intro', 'sponsor']);
    assert.deepStrictEqual(relay.calls, []);
  });
});
