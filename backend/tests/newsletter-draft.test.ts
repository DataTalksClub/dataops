import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { buildNewsletterIssue, createNewsletterIssue, updateNewsletterIssue, getNewsletterIssue } from '../src/db/newsletterIssues';
import { createSponsorDoc, getSponsorDoc } from '../src/db/sponsorDocs';
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
  ctaUrl: 'https://github.com/DataTalksClub/data-engineering-zoomcamp?utm_source=datatalksclub-newsletter',
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
      { kind: 'weekly', publicationDate: `2027-03-${String(seq + 1).padStart(2, '0')}`, issueNumber: 800 + seq, status: 'drafting', slots: { primary: {}, secondary: {}, ...slots } },
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

  /** A complete draft: subject, a filled intro, an own sponsor block staged from its linked sponsor doc, and two content blocks. */
  async function completeDraft() {
    const doc = await ownDoc();
    const issue = { ...(await newIssue({ primary: { sponsor: 'DataTalks.Club', documentUrl: `${DOC_BASE}${doc.id}` } })), docId: doc.id };
    const created = await req('POST', issue.base);
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    let draft = created.body.draft;
    const intro = draft.blocks[0];
    draft = (await req('PUT', `${issue.base}/blocks/${intro.id}`, { version: intro.version, data: { issue_label: intro.data.issue_label, summary: 'This week: **Zoomcamp** news.' } })).body.draft;
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

  /** Send the owner a test of the current approval and confirm its receipt. Returns the current draft. */
  async function confirmTest(issue: { base: string }, approved: any, requestId: string) {
    const sent = await req('POST', `${issue.base}/test-send`, { requestId });
    assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
    assert.deepStrictEqual(
      { requestId: sent.body.draft.lastTest.requestId, status: sent.body.draft.lastTest.status, payloadHash: sent.body.draft.lastTest.payloadHash },
      { requestId, status: 'provider_accepted', payloadHash: approved.approval.payloadHash },
      'the draft remembers the test the owner is asked to confirm',
    );
    const receipt = await req('POST', `${issue.base}/test-receipt`, { version: approved.approval.draftVersion, payloadHash: approved.approval.payloadHash, testRequestId: requestId });
    assert.strictEqual(receipt.status, 200, JSON.stringify(receipt.body));
    assert.strictEqual(receipt.body.draft.testReceipt.state, 'current');
    return receipt.body.draft;
  }

  /** Approve, test and confirm: everything scheduling needs. */
  async function approveAndConfirm(issue: { base: string }, tag: string) {
    return confirmTest(issue, await approve(issue), `test-${tag}-0001`);
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
    assert.strictEqual(types.find((t: any) => t.type === 'sponsor').addable, false, 'a sponsor block comes only from a linked sponsor doc');
    const handMade = await req('POST', `${issue.base}/blocks`, { type: 'sponsor', data: { title: 'Hand-made promo' } });
    assert.strictEqual(handMade.status, 409);
    assert.strictEqual(handMade.body.code, 'sponsor_block_doc_only');
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
    assert.match(render.text, /Register for free \(https:\/\/github\.com\/DataTalksClub\/data-engineering-zoomcamp\?utm_source=datatalksclub-newsletter\)/);

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
    // An own DataTalks.Club promo has its own linked sponsor doc; the block is staged from it and read-only.
    const { issue, draft } = await completeDraft();
    const sponsor = draft.blocks.find((b: any) => b.type === 'sponsor');
    assert.strictEqual(sponsor.readOnly, true);
    assert.strictEqual(draft.blocks.indexOf(sponsor), 1, 'the main sponsor block goes right under the intro');
    assert.strictEqual((await req('POST', `${issue.base}/blocks`, { type: 'sponsor', data: { title: 'Twice' } })).body.code, 'sponsor_block_doc_only');

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

  it('refuses approval until sponsor content comes from a linked doc and the envelope and own promo are review-ready', async () => {
    // A slot booked for DataTalks.Club without a sponsor doc blocks approval.
    const booked = await newIssue({ primary: { sponsor: 'DataTalks.Club' } });
    let draft = (await req('POST', booked.base)).body.draft;
    draft = (await req('POST', `${booked.base}/blocks`, { type: 'recording', data: { title: 'Last week', cta_text: 'Watch', cta_url: 'https://www.youtube.com/watch?v=abc' } })).body.draft;
    draft = (await req('PUT', booked.base, { version: draft.version, subject: 'Short subject', previewText: 'Short preview' })).body.draft;
    const intro = draft.blocks[0];
    draft = (await req('PUT', `${booked.base}/blocks/${intro.id}`, { version: intro.version, data: { summary: 'Hello' } })).body.draft;
    assert.ok(draft.problems.some((p: any) => p.field === 'sponsor_primary' && /no sponsor document/.test(p.message)), JSON.stringify(draft.problems));
    const refused = await req('POST', `${booked.base}/approve`, { version: draft.version, payloadHash: draft.payloadHash });
    assert.strictEqual(refused.status, 422);
    assert.strictEqual(refused.body.code, 'draft_incomplete');

    // Over-long subject/preview and a title over 12 words are diagnostics on save, refusals at approval.
    const { issue } = await completeDraft();
    let current = (await req('GET', issue.base)).body.draft;
    current = (await req('PUT', issue.base, { version: current.version, subject: `${'x'.repeat(66)} | DataTalks.Club Weekly`, previewText: 'y'.repeat(141) })).body.draft;
    assert.deepStrictEqual(current.problems.map((p: any) => p.field).sort(), ['previewText', 'subject']);
    const tooLong = await req('POST', `${issue.base}/approve`, { version: current.version, payloadHash: current.payloadHash });
    assert.strictEqual(tooLong.status, 422);
    current = (await req('PUT', issue.base, { version: current.version, subject: `${'x'.repeat(65)} | DataTalks.Club Weekly`, previewText: 'y'.repeat(140) })).body.draft;
    assert.deepStrictEqual(current.problems, []);

    // An own promo needs its bullets, closing and utm tracking reviewed in its doc.
    const save = await req('PUT', `/api/sponsor-docs/${issue.docId}`, {
      content: { ...OWN_PROMO, title: 'one two three four five six seven eight nine ten eleven twelve thirteen', bullets: '', closing: '', ctaUrl: 'https://datatalks.club/courses' },
    });
    assert.strictEqual(save.status, 200, JSON.stringify(save.body));
    current = (await req('GET', issue.base)).body.draft;
    const sponsorBlock = current.blocks.find((b: any) => b.type === 'sponsor');
    assert.deepStrictEqual(current.problems.filter((p: any) => p.blockId === sponsorBlock.id).map((p: any) => p.field).sort(), ['bullets', 'closing', 'cta_url', 'title']);
    assert.strictEqual((await req('POST', `${issue.base}/approve`, { version: current.version, payloadHash: current.payloadHash })).status, 422);
    assert.deepStrictEqual(relay.calls, []);
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

    const blocked = await req('POST', `${issue.base}/test-send`, { requestId: 'test-after-edit-1' });
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
    const sent = await req('POST', `${issue.base}/test-send`, { requestId: 'test-send-0001' });
    assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
    assert.strictEqual(sent.body.testSend.status, 'provider_accepted');
    assert.deepStrictEqual(sent.body.testSend.emails, ['alexey@datatalks.club'], 'the server picks the owner mailbox');
    assert.deepStrictEqual(relay.testSends.map((t) => t.emails), [['alexey@datatalks.club']]);
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

    const replay = await req('POST', `${issue.base}/test-send`, { requestId: 'test-send-0001' });
    assert.strictEqual(replay.body.testSend.replayed, true);
    assert.strictEqual(relay.testSends.length, 1, 'a replayed request id never sends again');
    // (d) a test to any destination other than the owner is refused before Relay.
    for (const emails of [['someone@x.example'], ['alexey@datatalks.club', 'b@x.example'], 'alexey@datatalks.club']) {
      const refused = await req('POST', `${issue.base}/test-send`, { emails, requestId: 'test-send-0002' });
      assert.strictEqual(refused.status, 400, JSON.stringify(emails));
      assert.strictEqual(refused.body.code, 'test_recipient_not_owner');
    }
    assert.strictEqual(relay.testSends.length, 1, 'a non-owner destination never reaches Relay');
    assert.strictEqual((await req('POST', `${issue.base}/test-send`, { requestId: 'test-send-0003' }, { as: 'agent' })).status, 403);
    assert.ok(relay.calls.every((c) => c.path.startsWith('/api/campaigns/')), 'no block-level or issue-level Relay writes');
  });

  it('schedules once under races and lost responses, locks the draft, serves the web view, and cancels', async () => {
    const { issue } = await completeDraft();
    const approved = await approveAndConfirm(issue, 'sched');
    relay.calls = [];
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

    // After a cancel the next delivery is a new Relay campaign. A lost queue response is reconciled
    // with Relay at once: Relay holds the payload, so the draft is scheduled and stays locked.
    const again = (await req('GET', issue.base)).body.draft;
    relay.calls = [];
    relay.failNextQueueResponse = 504;
    const lost = await req('POST', `${issue.base}/schedule`, { scheduledAt: at, payloadHash: again.payloadHash, version: again.version, requestId: 'sched-lost-1' });
    assert.strictEqual(lost.status, 200, JSON.stringify(lost.body));
    assert.strictEqual(lost.body.delivery.state, 'scheduled');
    assert.strictEqual(lost.body.delivery.campaignKey, `${key}-r2`);
    assert.strictEqual(relay.campaigns.get(`${key}-r2`)!.status, 'scheduled');
    assert.strictEqual(relay.calls.filter((c) => c.path.endsWith('/queue')).length, 1);
    assert.strictEqual((await req('GET', issue.base)).body.draft.locked, true);
    assert.ok(relay.calls.every((c) => c.path.startsWith('/api/campaigns/')));

    // While Relay holds the email, the issue can be neither deleted nor cancelled in DataOps.
    const stored = await getNewsletterIssue(client, issue.id);
    const del = await req('DELETE', `/api/newsletter-issues/${issue.id}`, { version: stored!.version });
    assert.strictEqual(del.status, 409);
    assert.strictEqual(del.body.code, 'newsletter_scheduled_in_relay');
    const cancelIssue = await req('PUT', `/api/newsletter-issues/${issue.id}`, { version: stored!.version, status: 'cancelled' });
    assert.strictEqual(cancelIssue.body.code, 'newsletter_scheduled_in_relay', JSON.stringify(cancelIssue.body));
  });

  it('keeps the draft locked when the outcome is unknown, and adopts what Relay really holds', async () => {
    const { issue } = await completeDraft();
    const approved = await approveAndConfirm(issue, 'unknown');
    const key = `dataops-newsletter-${issue.number}-${issue.id.slice(0, 12)}`;
    const at = new Date(NOW + 2 * 86_400_000).toISOString();
    relay.failNextQueueResponse = 504;
    relay.failGetsAfterQueue = true;
    const unknown = await req('POST', `${issue.base}/schedule`, { scheduledAt: at, payloadHash: approved.payloadHash, version: approved.version, requestId: 'sched-unknown-1' });
    assert.strictEqual(unknown.status, 502);
    const draft = (await req('GET', issue.base)).body.draft;
    assert.strictEqual(draft.delivery.state, 'scheduling', 'an unknown outcome never unlocks the draft');
    assert.strictEqual(draft.locked, true);
    const recording = draft.blocks.find((b: any) => b.type === 'recording');
    const midSchedule = await req('PUT', `${issue.base}/blocks/${recording.id}`, { version: recording.version, data: { title: 'x' } });
    assert.strictEqual(midSchedule.body.code, 'schedule_in_progress', 'an edit never races a schedule whose outcome is unknown');

    // Relay is reachable again: refreshing reads what it holds and records the real state and time.
    relay.getsFailing = false;
    const refreshed = await req('GET', `${issue.base}/delivery`, undefined, { query: { refresh: '1' } });
    assert.strictEqual(refreshed.body.delivery.state, 'scheduled');
    assert.strictEqual(refreshed.body.delivery.scheduledAt, at);
    assert.strictEqual(relay.campaigns.get(key)!.status, 'scheduled');
    const token = draft.webViewUrl.split('/').pop();
    assert.strictEqual((await req('GET', `/api/newsletter-view/${token}`)).status, 200);
  });

  it('adopts a campaign Relay already holds at its real time instead of the retried one', async () => {
    const { issue } = await completeDraft();
    const approved = await approveAndConfirm(issue, 'adopt');
    const key = `dataops-newsletter-${issue.number}-${issue.id.slice(0, 12)}`;
    const relayAt = new Date(NOW + 86_400_000).toISOString();
    const render = (await req('GET', `${issue.base}/render`)).body.render;
    relay.campaigns.set(key, {
      external_key: key, client: 'dtc-newsletter', audience: 'dtc', status: 'scheduled', subject: render.subject, preview_text: render.previewText,
      html_body: render.html, text_body: render.text, scheduled_at: relayAt, metadata: { dataops_payload_sha256: approved.payloadHash },
    });
    const later = new Date(NOW + 5 * 86_400_000).toISOString();
    relay.calls = [];
    const result = await req('POST', `${issue.base}/schedule`, { scheduledAt: later, payloadHash: approved.payloadHash, version: approved.version, requestId: 'sched-adopt-1' });
    assert.strictEqual(result.status, 200, JSON.stringify(result.body));
    assert.strictEqual(result.body.adopted, true);
    assert.strictEqual(result.body.delivery.scheduledAt, relayAt, 'DataOps records the time Relay will actually send');
    assert.ok(!relay.calls.some((c) => c.method === 'PUT' || c.path.endsWith('/queue')));
  });

  it('never lets a test send and a schedule interleave into an unscheduled queue', async () => {
    const { issue } = await completeDraft();
    const approved = await approveAndConfirm(issue, 'race');
    const key = `dataops-newsletter-${issue.number}-${issue.id.slice(0, 12)}`;
    const at = new Date(NOW + 3 * 86_400_000).toISOString();
    relay.testSendDelayMs = 40;
    const [test, schedule] = await Promise.all([
      req('POST', `${issue.base}/test-send`, { requestId: 'race-test-0002' }),
      req('POST', `${issue.base}/schedule`, { scheduledAt: at, payloadHash: approved.payloadHash, version: approved.version, requestId: 'race-sched-001' }),
    ]);
    relay.testSendDelayMs = 0;
    assert.ok([test.status, schedule.status].includes(409), JSON.stringify([test.body, schedule.body]));
    const campaign = relay.campaigns.get(key);
    assert.notStrictEqual(campaign?.status, 'queued', 'Relay never got a queue without a schedule time');
    if (campaign?.status === 'scheduled') assert.strictEqual(campaign.scheduled_at, at);
    // Once the test send is done, the owner can schedule.
    const fresh = (await req('GET', issue.base)).body.draft;
    if (!fresh.locked) {
      const later = await req('POST', `${issue.base}/schedule`, { scheduledAt: at, payloadHash: fresh.payloadHash, version: fresh.version, requestId: 'race-sched-002' });
      assert.strictEqual(later.status, 200, JSON.stringify(later.body));
      assert.strictEqual(relay.campaigns.get(key)!.scheduled_at, at);
    }
  });

  it('queues only after the owner confirmed receiving the test of the exact approved revision', async () => {
    const { issue } = await completeDraft();
    const approved = await approve(issue);
    const at = new Date(NOW + 3 * 86_400_000).toISOString();
    const schedule = (draft: any, requestId: string) => req('POST', `${issue.base}/schedule`, {
      scheduledAt: at, payloadHash: draft.approval.payloadHash, version: draft.version, requestId,
    });
    const queued = () => relay.calls.filter((c) => c.path.endsWith('/queue')).length;

    // (a) approved, but no test yet.
    const beforeTest = await schedule(approved, 'gate-before-test');
    assert.strictEqual(beforeTest.status, 409);
    assert.strictEqual(beforeTest.body.code, 'test_receipt_required');
    assert.strictEqual(approved.testReceipt.state, 'none');

    // A receipt needs an accepted test of this approval to the owner.
    const noTest = await req('POST', `${issue.base}/test-receipt`, { version: approved.approval.draftVersion, payloadHash: approved.approval.payloadHash, testRequestId: 'gate-missing-01' });
    assert.strictEqual(noTest.body.code, 'test_send_required');

    // (b) the provider accepted the test send, but the owner has not confirmed it arrived.
    const sent = await req('POST', `${issue.base}/test-send`, { requestId: 'gate-test-0001' });
    assert.strictEqual(sent.body.testSend.status, 'provider_accepted');
    const afterSend = await schedule(sent.body.draft, 'gate-after-send');
    assert.strictEqual(afterSend.body.code, 'test_receipt_required');
    assert.strictEqual(queued(), 0);

    // Only the owner confirms, and only for the approval on screen.
    const byAgent = await req('POST', `${issue.base}/test-receipt`, { version: approved.approval.draftVersion, payloadHash: approved.approval.payloadHash, testRequestId: 'gate-test-0001' }, { as: 'agent' });
    assert.strictEqual(byAgent.status, 403);
    const wrongHash = await req('POST', `${issue.base}/test-receipt`, { version: approved.approval.draftVersion, payloadHash: 'b'.repeat(64), testRequestId: 'gate-test-0001' });
    assert.strictEqual(wrongHash.body.code, 'draft_changed');
    const confirmed = await req('POST', `${issue.base}/test-receipt`, { version: approved.approval.draftVersion, payloadHash: approved.approval.payloadHash, testRequestId: 'gate-test-0001' });
    assert.strictEqual(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.strictEqual(confirmed.body.draft.testReceipt.state, 'current');
    assert.strictEqual(confirmed.body.draft.testReceipt.recipient, 'alexey@datatalks.club');

    // (c) a new revision after the receipt: approval and receipt are gone; a fresh approval needs a fresh test.
    const recording = confirmed.body.draft.blocks.find((b: any) => b.type === 'recording');
    const edited = await req('PUT', `${issue.base}/blocks/${recording.id}`, { version: recording.version, data: { ...recording.data, title: 'Edited after the test' } });
    assert.strictEqual(edited.body.draft.approval.state, 'none');
    assert.strictEqual(edited.body.draft.testReceipt.state, 'none');
    const reapproved = await approve(issue);
    const afterEdit = await schedule(reapproved, 'gate-after-edit');
    assert.strictEqual(afterEdit.body.code, 'test_receipt_required');
    // The old test (previous payload) cannot be confirmed for the new approval.
    const oldTest = await req('POST', `${issue.base}/test-receipt`, { version: reapproved.approval.draftVersion, payloadHash: reapproved.approval.payloadHash, testRequestId: 'gate-test-0001' });
    assert.strictEqual(oldTest.body.code, 'test_send_required');
    assert.strictEqual(queued(), 0, 'nothing was queued without a receipt for the exact revision');

    const revisions = (await req('GET', `${issue.base}/revisions`)).body.revisions;
    assert.ok(revisions.some((r: any) => r.origin === 'test-receipt' && /accepted it/.test(r.detail)));
    assert.ok(revisions.some((r: any) => r.origin === 'approval-withdrawn' && /test receipt/.test(r.detail)));

    // With a new test and its receipt the owner can schedule.
    const ready = await confirmTest(issue, reapproved, 'gate-test-0002');
    const scheduled = await schedule(ready, 'gate-scheduled');
    assert.strictEqual(scheduled.status, 200, JSON.stringify(scheduled.body));
    assert.strictEqual(queued(), 1);
  });

  async function scheduledDraft(tag: string) {
    const { issue } = await completeDraft();
    const ready = await approveAndConfirm(issue, tag);
    const at = new Date(NOW + 3 * 86_400_000).toISOString();
    const res = await req('POST', `${issue.base}/schedule`, { scheduledAt: at, payloadHash: ready.approval.payloadHash, version: ready.version, requestId: `sched-${tag}-01` });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const key = res.body.delivery.campaignKey;
    assert.strictEqual(relay.campaigns.get(key)!.status, 'scheduled');
    return { issue, draft: res.body.draft, key };
  }

  it('an edit of a scheduled draft cancels the Relay schedule first, verifies it, then saves and needs a new review', async () => {
    const { issue, draft, key } = await scheduledDraft('edit-ok');
    const token = draft.webViewUrl.split('/').pop();
    const recording = draft.blocks.find((b: any) => b.type === 'recording');
    assert.strictEqual(recording.readOnly, false, 'a scheduled draft stays editable');
    relay.calls = [];
    const edited = await req('PUT', `${issue.base}/blocks/${recording.id}`, { version: recording.version, data: { ...recording.data, title: 'Changed after scheduling' } }, { as: 'operator' });
    assert.strictEqual(edited.status, 200, JSON.stringify(edited.body));
    assert.deepStrictEqual(relay.calls.map((c) => `${c.method} ${c.path}`), [
      `GET /api/campaigns/${key}`, `POST /api/campaigns/${key}/cancel`, `GET /api/campaigns/${key}`,
    ], 'cancel, then read back; no content goes to Relay');
    assert.strictEqual(relay.campaigns.get(key)!.status, 'cancelled');
    const after = edited.body.draft;
    assert.strictEqual(after.delivery.state, 'cancelled');
    assert.strictEqual(after.locked, false);
    assert.strictEqual(after.approval.state, 'none');
    assert.strictEqual(after.testReceipt.state, 'none');
    assert.strictEqual(after.blocks.find((b: any) => b.id === recording.id).data.title, 'Changed after scheduling');
    assert.strictEqual((await req('GET', `/api/newsletter-view/${token}`)).status, 404, 'the web view goes with the schedule');
    const origins = (await req('GET', `${issue.base}/revisions`)).body.revisions.map((r: any) => r.origin);
    assert.deepStrictEqual(origins.slice(-3), ['cancel', 'edit', 'approval-withdrawn']);

    // A subject edit of a scheduled draft takes the same path; a new schedule is a new campaign.
    const ready = await approveAndConfirm(issue, 'edit-ok-2');
    const at = new Date(NOW + 4 * 86_400_000).toISOString();
    const again = await req('POST', `${issue.base}/schedule`, { scheduledAt: at, payloadHash: ready.approval.payloadHash, version: ready.version, requestId: 'sched-edit-ok-02' });
    assert.strictEqual(again.status, 200, JSON.stringify(again.body));
    assert.strictEqual(again.body.delivery.campaignKey, `${key}-r2`);
    const subject = await req('PUT', issue.base, { version: again.body.draft.version, subject: 'A new subject | DataTalks.Club Weekly' });
    assert.strictEqual(subject.status, 200, JSON.stringify(subject.body));
    assert.strictEqual(relay.campaigns.get(`${key}-r2`)!.status, 'cancelled');
    assert.strictEqual(subject.body.draft.delivery.state, 'cancelled');
  });

  it('a failed or unconfirmed unschedule leaves the scheduled draft and its content untouched', async () => {
    const { issue, draft, key } = await scheduledDraft('edit-fail');
    relay.calls = [];
    const recording = draft.blocks.find((b: any) => b.type === 'recording');
    const tryEdit = () => req('PUT', `${issue.base}/blocks/${recording.id}`, { version: recording.version, data: { ...recording.data, title: 'Should not land' } });
    const unchanged = async () => {
      const now = (await req('GET', issue.base)).body.draft;
      assert.strictEqual(now.delivery.state, 'scheduled');
      assert.strictEqual(now.approval.state, 'current');
      assert.strictEqual(now.testReceipt.state, 'current');
      assert.strictEqual(now.blocks.find((b: any) => b.id === recording.id).data.title, recording.data.title);
      assert.strictEqual(now.version, draft.version);
    };

    // Relay unreachable: nothing is confirmed, so nothing changes.
    relay.getsFailing = true;
    const unreachable = await tryEdit();
    relay.getsFailing = false;
    assert.strictEqual(unreachable.status, 502, JSON.stringify(unreachable.body));
    assert.strictEqual(unreachable.body.code, 'unschedule_failed');
    await unchanged();

    // Relay answers the cancel, but the campaign is still scheduled when read back.
    const fakeFetch = relay.fetch;
    restore();
    restore = setRelayDepsForTests({
      fetchImpl: (async (input: string | URL, init: RequestInit = {}) => {
        if (String(input).endsWith('/cancel')) return new Response(JSON.stringify({ campaign: relay.campaigns.get(key), cancelled: false }), { status: 200 });
        return fakeFetch(input, init);
      }) as typeof fetch,
      readSecret: async (name) => SECRETS[name],
      now: () => NOW,
    });
    const refused = await tryEdit();
    assert.strictEqual(refused.body.code, 'unschedule_failed');
    assert.match(refused.body.error, /did not cancel/);
    assert.strictEqual(relay.campaigns.get(key)!.status, 'scheduled');
    await unchanged();

    // Sending already started: too late, and said so.
    relay.campaigns.get(key)!.status = 'sending';
    const sending = await tryEdit();
    assert.strictEqual(sending.status, 409);
    assert.strictEqual(sending.body.code, 'unschedule_failed');
    assert.match(sending.body.error, /sending/);
    relay.campaigns.get(key)!.status = 'scheduled';
    await unchanged();

    // A 404, 403 or timeout is not proof that nothing will be sent: each leaves
    // the scheduled draft as it is, whether it comes before or after the cancel.
    const withRelay = (wrap: (input: string | URL, init: RequestInit) => Promise<Response> | undefined) => {
      restore();
      restore = setRelayDepsForTests({
        fetchImpl: (async (input: string | URL, init: RequestInit = {}) => (await wrap(input, init)) || fakeFetch(input, init)) as typeof fetch,
        readSecret: async (name) => SECRETS[name],
        now: () => NOW,
      });
    };
    const isRead = (input: string | URL, init: RequestInit) => (init.method || 'GET') === 'GET' && String(input).includes(`/api/campaigns/${key}?`);
    const notFound = () => new Response(JSON.stringify({ external_key: 'not_found' }), { status: 404 });
    const cases: Array<[string, (input: string | URL, init: RequestInit) => Promise<Response> | undefined, RegExp]> = [
      ['404 before the cancel', (input, init) => (isRead(input, init) ? Promise.resolve(notFound()) : undefined), /HTTP 404/],
      ['403 on the read', (input, init) => (isRead(input, init) ? Promise.resolve(new Response('forbidden', { status: 403 })) : undefined), /could not be read/],
      ['timeout on the read', (input, init) => (isRead(input, init) ? Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })) : undefined), /could not be read/],
    ];
    for (const [label, wrap, message] of cases) {
      relay.calls = [];
      withRelay(wrap);
      const res = await tryEdit();
      assert.strictEqual(res.body.code, 'unschedule_failed', `${label}: ${JSON.stringify(res.body)}`);
      assert.match(res.body.error, message, label);
      assert.ok(!relay.calls.some((c) => c.path.endsWith('/cancel')), `${label}: nothing confirmed, so no cancel is sent`);
      assert.strictEqual(relay.campaigns.get(key)!.status, 'scheduled', label);
      await unchanged();
    }

    // The cancel goes through, but the readback is a 404: still unconfirmed.
    let cancelSeen = false;
    withRelay((input, init) => {
      if (String(input).endsWith('/cancel')) { cancelSeen = true; return undefined; }
      return cancelSeen && isRead(input, init) ? Promise.resolve(notFound()) : undefined;
    });
    const gone = await tryEdit();
    assert.ok(cancelSeen);
    assert.strictEqual(gone.body.code, 'unschedule_failed', JSON.stringify(gone.body));
    assert.match(gone.body.error, /HTTP 404/);
    await unchanged();
    assert.ok(!relay.calls.some((c) => c.method === 'PUT'), 'no content ever went to Relay');
  });

  it('two concurrent edits of a scheduled draft save once and never leave a stale schedule; a retry needs no Relay call', async () => {
    const { issue, draft, key } = await scheduledDraft('edit-race');
    const recording = draft.blocks.find((b: any) => b.type === 'recording');
    const intro = draft.blocks.find((b: any) => b.type === 'intro');
    relay.calls = [];
    const [a, b] = await Promise.all([
      req('PUT', `${issue.base}/blocks/${recording.id}`, { version: recording.version, data: { ...recording.data, title: 'Edit A' } }),
      req('PUT', `${issue.base}/blocks/${intro.id}`, { version: intro.version, data: { ...intro.data, summary: 'Edit B' } }),
    ]);
    assert.ok([a.status, b.status].includes(200), JSON.stringify([a.body, b.body]));
    const after = (await req('GET', issue.base)).body.draft;
    assert.strictEqual(after.delivery.state, 'cancelled', 'DataOps never keeps showing a schedule Relay cancelled');
    assert.strictEqual(relay.campaigns.get(key)!.status, 'cancelled');
    assert.strictEqual(relay.calls.filter((c) => c.path.endsWith('/queue') || c.method === 'PUT').length, 0);
    const loser = [a, b].find((r) => r.status !== 200);
    if (loser) {
      assert.strictEqual(loser.body.code, 'draft_version_conflict');
      relay.calls = [];
      const fresh = after.blocks.find((x: any) => x.id === recording.id);
      const retry = await req('PUT', `${issue.base}/blocks/${recording.id}`, { version: fresh.version, data: { ...fresh.data, title: 'Edit A again' } });
      assert.strictEqual(retry.status, 200);
      assert.deepStrictEqual(relay.calls, [], 'the draft is no longer scheduled: the retry is a plain local edit');
    }
  });

  it('a sponsor-doc save of a scheduled issue unschedules it in Relay first, or is not saved at all', async () => {
    const doc = await ownDoc();
    const issue = await newIssue({ primary: { sponsor: 'DataTalks.Club', documentUrl: `${DOC_BASE}${doc.id}` } });
    let draft = (await req('POST', issue.base)).body.draft;
    const intro = draft.blocks[0];
    draft = (await req('PUT', `${issue.base}/blocks/${intro.id}`, { version: intro.version, data: { issue_label: intro.data.issue_label, summary: 'This week: our own course.' } })).body.draft;
    draft = (await req('POST', `${issue.base}/blocks`, { type: 'recording', data: { title: 'Last week: dbt in production', cta_text: 'Watch', cta_url: 'https://www.youtube.com/watch?v=abc' } })).body.draft;
    const ready = await approveAndConfirm(issue, 'doc-save');
    const at = new Date(NOW + 3 * 86_400_000).toISOString();
    const scheduled = await req('POST', `${issue.base}/schedule`, { scheduledAt: at, payloadHash: ready.approval.payloadHash, version: ready.version, requestId: 'sched-doc-save-1' });
    assert.strictEqual(scheduled.status, 200, JSON.stringify(scheduled.body));
    const key = scheduled.body.delivery.campaignKey;

    // Relay unreachable: the doc is not saved and the issue stays scheduled with its approval.
    relay.getsFailing = true;
    const refused = await req('PUT', `/api/sponsor-docs/${doc.id}`, { content: { ...OWN_PROMO, title: 'Changed while Relay is down' } });
    relay.getsFailing = false;
    assert.strictEqual(refused.status, 502, JSON.stringify(refused.body));
    assert.strictEqual(refused.body.code, 'unschedule_failed');
    assert.match(refused.body.error, /not saved/);
    assert.strictEqual((await getSponsorDoc(client, doc.id))!.content.title, OWN_PROMO.title);
    let now = (await req('GET', issue.base)).body.draft;
    assert.strictEqual(now.delivery.state, 'scheduled');
    assert.strictEqual(now.approval.state, 'current');
    assert.strictEqual(relay.campaigns.get(key)!.status, 'scheduled');

    // A save that changes nothing never touches the schedule.
    relay.calls = [];
    const same = await req('PUT', `/api/sponsor-docs/${doc.id}`, { content: { title: OWN_PROMO.title } });
    assert.strictEqual(same.status, 200, JSON.stringify(same.body));
    assert.deepStrictEqual(relay.calls, []);
    assert.strictEqual((await req('GET', issue.base)).body.draft.delivery.state, 'scheduled');

    // Relay reachable: cancel verified, then the doc is saved and staged; review and test start over.
    const saved = await req('PUT', `/api/sponsor-docs/${doc.id}`, { content: { ...OWN_PROMO, title: 'Data Engineering Zoomcamp 2027' } });
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
    assert.strictEqual(relay.campaigns.get(key)!.status, 'cancelled');
    now = (await req('GET', issue.base)).body.draft;
    assert.strictEqual(now.delivery.state, 'cancelled');
    assert.strictEqual(now.approval.state, 'none');
    assert.strictEqual(now.testReceipt.state, 'none');
    assert.strictEqual(now.blocks.find((b: any) => b.type === 'sponsor').data.title, 'Data Engineering Zoomcamp 2027');
    assert.ok(relay.calls.every((c) => c.method === 'GET' || c.path.endsWith('/cancel')), 'the doc save sends no content to Relay');
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
