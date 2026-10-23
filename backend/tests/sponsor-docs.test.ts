import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createCard } from '../src/db/cards';
import { createPodcastEpisode } from '../src/db/podcastEpisodes';
import { createUser } from '../src/db/users';
import { createSession } from '../src/db/sessions';
import { getSponsorDoc } from '../src/db/sponsorDocs';
import { templateLink } from './helpers/cardTemplate';

describe('Sponsor Content Docs API (/api/sponsor-docs)', () => {
  let port: number;
  let client: DynamoDBDocumentClient;
  let handler: typeof import('../src/handler').handler;
  let staffUserId: string;
  let staffToken: string;

  before(async () => {
    port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    process.env.IS_LOCAL = 'true';
    handler = (await import('../src/handler')).handler;

    const user = await createUser(client, {
      email: 'staff@datatalks.club',
      name: 'Valeriia Staff',
      passwordHash: 'unused',
      role: 'admin',
    });
    staffUserId = user.id;
    const session = await createSession(client, staffUserId);
    staffToken = session.token;
  });

  after(async () => {
    await stopLocal();
    delete process.env.IS_LOCAL;
  });

  function staffReq(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ) {
    return handler(
      {
        httpMethod: method,
        path,
        headers: {
          authorization: `Bearer ${staffToken}`,
          'x-user-id': staffUserId,
          host: 'ops.dtcdev.click',
          'x-forwarded-proto': 'https',
        },
        queryStringParameters: query || null,
        body: body === undefined ? null : JSON.stringify(body),
      },
      {},
    );
  }

  function anonReq(
    method: string,
    path: string,
    options?: {
      codeHeader?: string;
      query?: Record<string, string>;
      body?: unknown;
      ip?: string;
    },
  ) {
    const headers: Record<string, string> = {
      host: 'ops.dtcdev.click',
      'x-forwarded-proto': 'https',
      'x-forwarded-for': options?.ip || '203.0.113.10',
      'x-sponsor-doc-anonymous': 'true',
    };
    if (options?.codeHeader) {
      headers['x-sponsor-doc-code'] = options.codeHeader;
    }
    return handler(
      {
        httpMethod: method,
        path,
        headers,
        queryStringParameters: options?.query || null,
        body: options?.body === undefined ? null : JSON.stringify(options.body),
      },
      {},
    );
  }

  it('creates a sponsor doc from the right template, links it on the Card, and supports all templates', async () => {
    const card = await createCard(client, {
      ...templateLink(),
      title: '[Newsletter] (02 NOV 2026) #310 - Astronomer',
      anchorDate: '2026-11-02',
      sponsor: 'Astronomer',
      cardLinks: [{ name: 'Sponsorship document', url: '' }],
    });

    const createRes = await staffReq('POST', '/api/sponsor-docs', {
      cardId: card.id,
    });
    assert.strictEqual(createRes.statusCode, 201, createRes.body);
    const created = JSON.parse(createRes.body);
    assert.strictEqual(created.doc.cardId, card.id);
    assert.strictEqual(created.doc.template, 'newsletter-main');
    assert.strictEqual(created.doc.title, '2026-11-02 - Astronomer');
    assert.strictEqual(created.doc.status, 'draft');
    assert.strictEqual(created.doc.lastEditedBy, 'staff');
    assert.ok(created.doc.accessCode, 'returns generated access code to staff');
    assert.match(created.doc.accessCode, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}(?:-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}){3}$/);
    assert.strictEqual(
      created.doc.docUrl,
      `https://ops.dtcdev.click/sponsor-docs/${created.doc.id}`,
    );
    assert.strictEqual(
      created.doc.shareUrl,
      `https://ops.dtcdev.click/sponsor-docs/${created.doc.id}?code=${created.doc.accessCode}`,
    );
    assert.ok(created.doc.emailDraft?.subject.includes('Astronomer'));
    assert.ok(created.doc.emailDraft?.body.includes(created.doc.shareUrl));

    // Card's "Sponsorship document" link was updated with the clean canonical URL (no code in Card link)
    const sponsorLink = created.card.cardLinks.find(
      (l: { name: string; url: string }) => l.name === 'Sponsorship document',
    );
    assert.ok(sponsorLink);
    assert.strictEqual(sponsorLink.url, created.doc.docUrl);
    assert.ok(!sponsorLink.url.includes('code='));

    // Card projection includes sponsorDocs summary
    assert.ok(Array.isArray(created.card.sponsorDocs));
    assert.strictEqual(created.card.sponsorDocs.length, 1);
    assert.strictEqual(created.card.sponsorDocs[0].id, created.doc.id);
    assert.strictEqual(created.card.sponsorDocs[0].status, 'draft');

    // Verify all templates are available
    const templatesRes = await staffReq('GET', '/api/sponsor-docs/templates');
    assert.strictEqual(templatesRes.statusCode, 200, templatesRes.body);
    const { templates } = JSON.parse(templatesRes.body);
    assert.deepStrictEqual(
      templates.map((t: { key: string }) => t.key),
      ['newsletter-main', 'newsletter-secondary', 'newsletter-standalone', 'webinar', 'podcast', 'podcast-guest-research', 'podcast-run-sheet', 'podcast-episode-brief'],
    );
  });

  it('creates podcast prep docs (guest research, run sheet, episode brief) with internal export and email drafts', async () => {
    const card = await createCard(client, {
      ...templateLink(),
      title: '[Podcast] 2026-12-01 - Jane Doe',
      anchorDate: '2026-12-01',
      people: ['Jane Doe'],
    });
    // Post-confirm state: the episode carries the agreed recording date and
    // links the Card. Research and run sheets are only available from here.
    const datedEpisode = await createPodcastEpisode(client, {
      title: 'Shipping ML features',
      guests: [{ name: 'Jane Doe' }],
      status: 'booked',
      recordingDate: '2026-12-01',
      cardId: card.id,
    });

    for (const template of ['podcast-guest-research', 'podcast-run-sheet', 'podcast-episode-brief'] as const) {
      const createRes = await staffReq('POST', '/api/sponsor-docs', {
        cardId: card.id,
        template,
      });
      assert.strictEqual(createRes.statusCode, 201, `${template}: ${createRes.body}`);
      const created = JSON.parse(createRes.body);
      assert.strictEqual(created.doc.template, template);
      assert.strictEqual(created.doc.cardId, card.id);
      assert.ok(created.doc.docUrl.includes('/sponsor-docs/'));
      assert.ok(created.doc.emailDraft?.subject.includes('Podcast'));
      const exportRes = await staffReq('GET', `/api/sponsor-docs/${created.doc.id}/export`, undefined, {
        format: 'markdown',
      });
      assert.strictEqual(exportRes.statusCode, 200);
      assert.ok(exportRes.body.includes(created.doc.title));
    }

    // Episode-owned research doc works too once the date is confirmed.
    const episodeOwned = await staffReq('POST', '/api/sponsor-docs', {
      cardId: datedEpisode.id,
      template: 'podcast-guest-research',
    });
    assert.strictEqual(episodeOwned.statusCode, 201, episodeOwned.body);

    // Guest materials share email: form path only (no reply-instead wording).
    const guestDoc = await staffReq('POST', '/api/sponsor-docs', {
      cardId: datedEpisode.id,
      template: 'podcast',
    });
    assert.strictEqual(guestDoc.statusCode, 201, guestDoc.body);
    const guestCreated = JSON.parse(guestDoc.body);
    assert.ok(
      guestCreated.doc.docUrl.includes('/podcast-docs/'),
      `podcast guest form lives under /podcast-docs/: ${guestCreated.doc.docUrl}`,
    );
    assert.strictEqual(guestCreated.doc.linkType, 'Guest materials');
    const guestBody = guestCreated.doc.emailDraft?.body || '';
    assert.match(guestBody, /use the form/i);
    assert.match(guestBody, /do not invent alternate times/i);
    assert.ok(!/couple of sentences/i.test(guestBody));
    assert.ok(!/either way works/i.test(guestBody));

    const badRes = await staffReq('POST', '/api/sponsor-docs', {
      cardId: card.id,
      template: 'google-doc',
    });
    assert.strictEqual(badRes.statusCode, 400, badRes.body);
    assert.strictEqual(JSON.parse(badRes.body).code, 'invalid_template');
  });

  it('holds guest research and run sheets until the recording date is confirmed', async () => {
    const card = await createCard(client, {
      ...templateLink(),
      title: '[Podcast] 2026-12-02 - John Roe',
      anchorDate: '2026-12-02',
      people: ['John Roe'],
    });
    // A bare Card (invite sent, date not confirmed yet): research blocked,
    // brief and guest materials stay available.
    for (const template of ['podcast-guest-research', 'podcast-run-sheet'] as const) {
      const blocked = await staffReq('POST', '/api/sponsor-docs', {
        cardId: card.id,
        template,
      });
      assert.strictEqual(blocked.statusCode, 422, `${template}: ${blocked.body}`);
      assert.strictEqual(JSON.parse(blocked.body).code, 'date_not_confirmed');
    }
    const briefOk = await staffReq('POST', '/api/sponsor-docs', {
      cardId: card.id,
      template: 'podcast-episode-brief',
    });
    assert.strictEqual(briefOk.statusCode, 201, briefOk.body);

    // A dateless episode (no confirmed recording date yet) is blocked too.
    const dateless = await createPodcastEpisode(client, {
      title: 'TBA topic',
      guests: [{ name: 'John Roe' }],
      status: 'booked',
    });
    const blockedEpisode = await staffReq('POST', '/api/sponsor-docs', {
      cardId: dateless.id,
      template: 'podcast-run-sheet',
    });
    assert.strictEqual(blockedEpisode.statusCode, 422, blockedEpisode.body);
    assert.strictEqual(JSON.parse(blockedEpisode.body).code, 'date_not_confirmed');
  });

  it('gates anonymous sponsor access by access code (query or header), allows sponsor edits & submission, and lets staff edit without a code', async () => {
    const card = await createCard(client, {
      ...templateLink(),
      title: 'Stand-Alone Blast - Estuary',
      anchorDate: '2026-11-10',
      sponsor: 'Estuary',
    });

    const createRes = await staffReq('POST', '/api/sponsor-docs', {
      cardId: card.id,
      template: 'newsletter-standalone',
    });
    assert.strictEqual(createRes.statusCode, 201, createRes.body);
    const { doc } = JSON.parse(createRes.body);
    const docId = doc.id as string;
    const code = doc.accessCode as string;

    // 1. Anonymous GET without code -> 401
    const noCodeRes = await anonReq('GET', `/api/sponsor-docs/${docId}`);
    assert.strictEqual(noCodeRes.statusCode, 401, noCodeRes.body);
    assert.strictEqual(JSON.parse(noCodeRes.body).code, 'access_code_required');

    // 2. Anonymous GET with wrong code -> 403
    const wrongCodeRes = await anonReq('GET', `/api/sponsor-docs/${docId}`, {
      query: { code: 'WWWW-WWWW-WWWW-WWWW' },
      ip: '198.51.100.25',
    });
    assert.strictEqual(wrongCodeRes.statusCode, 403, wrongCodeRes.body);
    assert.strictEqual(JSON.parse(wrongCodeRes.body).code, 'invalid_access_code');

    // 3. Anonymous GET with valid ?code= query parameter -> 200
    const withQueryCodeRes = await anonReq('GET', `/api/sponsor-docs/${docId}`, {
      query: { code },
      ip: '198.51.100.25',
    });
    assert.strictEqual(withQueryCodeRes.statusCode, 200, withQueryCodeRes.body);
    const sponsorView = JSON.parse(withQueryCodeRes.body).doc;
    assert.strictEqual(sponsorView.viewerRole, 'sponsor');
    assert.strictEqual(sponsorView.accessCode, undefined, 'never echoes accessCode in sponsor payload');
    assert.strictEqual(sponsorView.shareUrl, undefined);

    // 4. Anonymous PUT by sponsor with X-Sponsor-Doc-Code header (lowercase & without dashes also works)
    const compactLowerCode = code.replace(/-/g, '').toLowerCase();
    const editRes = await anonReq('PUT', `/api/sponsor-docs/${docId}`, {
      codeHeader: compactLowerCode,
      ip: '198.51.100.25',
      body: {
        content: {
          subjectLine: 'Build real-time data pipelines in minutes',
          previewText: 'Estuary Flow unifies streaming + batch.',
          title: 'Real-time ETL and ELT pipelines for modern data teams',
          intro: 'Data teams face a choice between slow batch or complex streaming.',
          earlyCtaText: 'Start Building For Free',
          earlyCtaUrl: 'https://estuary.dev/start',
           bullets: '- Connect 100s of sources\n- <100ms latency',
          closing: 'Join us to build pipelines in minutes.',
          closingCtaText: 'SIGN ME UP',
          closingCtaUrl: 'https://estuary.dev/webinar',
        },
        status: 'submitted',
      },
    });
    assert.strictEqual(editRes.statusCode, 200, editRes.body);
    const editedDoc = JSON.parse(editRes.body).doc;
    assert.strictEqual(editedDoc.status, 'submitted');
    assert.strictEqual(editedDoc.lastEditedBy, 'sponsor');
    assert.ok(editedDoc.submittedAt);
    assert.strictEqual(editedDoc.content.subjectLine, 'Build real-time data pipelines in minutes');

    // 5. Staff can view the Card and see the "submitted" state and lastEditedBy="sponsor"
    const cardRes = await staffReq('GET', `/api/cards/${card.id}`);
    assert.strictEqual(cardRes.statusCode, 200, cardRes.body);
    const projectedCard = JSON.parse(cardRes.body).card;
    assert.strictEqual(projectedCard.sponsorDocs[0].status, 'submitted');
    assert.strictEqual(projectedCard.sponsorDocs[0].lastEditedBy, 'sponsor');

    // 6. Staff can view and edit the doc without any access code
    const staffEditRes = await staffReq('PUT', `/api/sponsor-docs/${docId}`, {
      content: {
        subjectLine: 'Build real-time data pipelines in minutes (Reviewed)',
      },
    });
    assert.strictEqual(staffEditRes.statusCode, 200, staffEditRes.body);
    const staffEdited = JSON.parse(staffEditRes.body).doc;
    assert.strictEqual(staffEdited.viewerRole, 'staff');
    assert.strictEqual(staffEdited.lastEditedBy, 'staff');
    assert.strictEqual(
      staffEdited.content.subjectLine,
      'Build real-time data pipelines in minutes (Reviewed)',
    );
    assert.strictEqual(
      staffEdited.content.earlyCtaText,
      'Start Building For Free',
      'preserves untouched fields on partial content update',
    );

    // 7. Read-only Markdown export works for both staff and code-holding sponsor
    const exportRes = await staffReq('GET', `/api/sponsor-docs/${docId}/export`, undefined, {
      format: 'markdown',
    });
    assert.strictEqual(exportRes.statusCode, 200);
    assert.ok(exportRes.body.includes('Build real-time data pipelines in minutes (Reviewed)'));
    assert.ok(exportRes.body.includes('[Start Building For Free](https://estuary.dev/start)'));
  });

  it('rate-limits repeated wrong access code attempts and supports rotating the code', async () => {
    const card = await createCard(client, {
      ...templateLink(),
      title: '[Podcast] 2026-11-20 - Jane Doe',
      anchorDate: '2026-11-20',
      people: ['Jane Doe'],
    });

    const createRes = await staffReq('POST', '/api/sponsor-docs', {
      cardId: card.id,
    });
    assert.strictEqual(createRes.statusCode, 201, createRes.body);
    const { doc } = JSON.parse(createRes.body);
    assert.strictEqual(doc.template, 'podcast');

    const attackerIp = '192.0.2.99';
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const res = await anonReq('GET', `/api/sponsor-docs/${doc.id}`, {
        codeHeader: '2222-3333-4444-5555',
        ip: attackerIp,
      });
      assert.strictEqual(res.statusCode, 403, `attempt ${attempt} should be 403`);
    }

    // 5th failed attempt triggers 429 rate limit
    const fifthRes = await anonReq('GET', `/api/sponsor-docs/${doc.id}`, {
      codeHeader: '2222-3333-4444-5555',
      ip: attackerIp,
    });
    assert.strictEqual(fifthRes.statusCode, 429, fifthRes.body);
    assert.strictEqual(JSON.parse(fifthRes.body).code, 'rate_limited');
    assert.ok(fifthRes.headers?.['Retry-After']);

    // Even the real code from the rate-limited IP is blocked while the window is active
    const blockedRealRes = await anonReq('GET', `/api/sponsor-docs/${doc.id}`, {
      codeHeader: doc.accessCode,
      ip: attackerIp,
    });
    assert.strictEqual(blockedRealRes.statusCode, 429);

    // A different IP with the valid code still succeeds
    const validOtherIpRes = await anonReq('GET', `/api/sponsor-docs/${doc.id}`, {
      codeHeader: doc.accessCode,
      ip: '192.0.2.100',
    });
    assert.strictEqual(validOtherIpRes.statusCode, 200);

    // Staff can rotate the access code, invalidating the old one
    const rotateRes = await staffReq('POST', `/api/sponsor-docs/${doc.id}/rotate-code`);
    assert.strictEqual(rotateRes.statusCode, 200, rotateRes.body);
    const rotatedDoc = JSON.parse(rotateRes.body).doc;
    assert.notStrictEqual(rotatedDoc.accessCode, doc.accessCode);

    const oldCodeRes = await anonReq('GET', `/api/sponsor-docs/${doc.id}`, {
      codeHeader: doc.accessCode,
      ip: '192.0.2.101',
    });
    assert.strictEqual(oldCodeRes.statusCode, 403);

    const newCodeRes = await anonReq('GET', `/api/sponsor-docs/${doc.id}`, {
      codeHeader: rotatedDoc.accessCode,
      ip: '192.0.2.101',
    });
    assert.strictEqual(newCodeRes.statusCode, 200);

    // Deleting the Card cascades and removes its sponsor docs
    const cardGetRes = await staffReq('GET', `/api/cards/${card.id}`);
    const latestCard = JSON.parse(cardGetRes.body).card;
    const delCardRes = await staffReq('DELETE', `/api/cards/${card.id}`, {
      expectedVersion: latestCard.version,
    });
    assert.strictEqual(delCardRes.statusCode, 200, delCardRes.body);
    assert.strictEqual(await getSponsorDoc(client, doc.id), null);
  });

  it('creates a sponsor doc directly from a newsletter issue ID and supports --slot secondary and --standalone', async () => {
    const issueRes = await staffReq('POST', '/api/newsletter-issues', {
      kind: 'weekly',
      publicationDate: '2026-12-07',
      issueNumber: 310,
      status: 'planned',
      slots: {
        primary: { sponsor: 'PrimarySponsor' },
        secondary: { sponsor: 'SecondarySponsor' },
      },
    });
    assert.strictEqual(issueRes.statusCode, 201, issueRes.body);
    const issue = JSON.parse(issueRes.body);

    const createSecondaryRes = await staffReq('POST', '/api/sponsor-docs', {
      cardId: issue.id,
      slot: 'secondary',
    });
    assert.strictEqual(createSecondaryRes.statusCode, 201, createSecondaryRes.body);
    const secondaryPayload = JSON.parse(createSecondaryRes.body);
    assert.strictEqual(secondaryPayload.doc.template, 'newsletter-secondary');
    assert.strictEqual(secondaryPayload.doc.sponsorName, 'SecondarySponsor');
    assert.strictEqual(secondaryPayload.doc.publicationDate, '2026-12-07');
    assert.strictEqual(
      secondaryPayload.issue?.slots?.secondary?.documentUrl,
      secondaryPayload.doc.docUrl,
    );

    const createStandaloneRes = await staffReq('POST', '/api/sponsor-docs', {
      cardId: issue.id,
      standalone: true,
    });
    assert.strictEqual(createStandaloneRes.statusCode, 201, createStandaloneRes.body);
    const standalonePayload = JSON.parse(createStandaloneRes.body);
    assert.strictEqual(standalonePayload.doc.template, 'newsletter-standalone');
    assert.strictEqual(standalonePayload.doc.sponsorName, 'PrimarySponsor');
    const placementFields = standalonePayload.doc.templateDefinition.sections[0].fields;
    const fieldKeys = placementFields.map((f: { key: string }) => f.key);
    assert.ok(fieldKeys.includes('mainBodyOpening'));
    assert.ok(fieldKeys.includes('bullets'));
    assert.ok(fieldKeys.includes('closing'));
    const bulletsDef = placementFields.find((f: { key: string }) => f.key === 'bullets');
    assert.strictEqual(bulletsDef.type, 'bullets');
  });
  it('links webinar materials, saves speaker drafts, validates submission and exposes the saved export on the card', async () => {
    const card = await createCard(client, { ...templateLink(), title: '[Webinar] Synthetic talk', people: ['Test Speaker'] });
    const created = await staffReq('POST', '/api/sponsor-docs', { cardId: card.id });
    assert.equal(created.statusCode, 201, created.body);
    const { doc, card: linkedCard } = JSON.parse(created.body);
    assert.equal(doc.template, 'webinar');
    assert.equal(doc.linkType, 'Speaker materials');
    assert.ok(doc.docUrl.includes('/webinar-docs/'));
    assert.ok(doc.emailDraft.body.includes(doc.shareUrl));
    assert.ok(linkedCard.cardLinks.some((link: { name: string; url: string }) => link.name === 'Speaker materials' && link.url === doc.docUrl));
    assert.equal((await anonReq('GET', `/webinar-docs/${doc.id}`)).statusCode, 200);
    assert.equal((await anonReq('PUT', `/api/sponsor-docs/${doc.id}`, { body: { status: 'submitted' } })).statusCode, 401);
    const save = (body: unknown) => anonReq('PUT', `/api/sponsor-docs/${doc.id}`, { codeHeader: doc.accessCode, body });
    const draft = await save({ content: { talkTitle: 'Data pipelines' } });
    assert.equal(draft.statusCode, 200, draft.body);
    const invalid = await save({ status: 'submitted' });
    assert.equal(invalid.statusCode, 422, invalid.body);
    assert.deepEqual(Object.keys(JSON.parse(invalid.body).fields), ['outline', 'bio']);
    assert.equal((await getSponsorDoc(client, doc.id))?.status, 'draft');
    const content = { outline: '- Design\n- Build\n- Monitor', bio: 'A data engineer.', summary: 'Practical lessons', linkedinUrl: 'https://example.test/linkedin', githubUrl: 'https://example.test/github', websiteUrl: 'https://example.test/site' };
    const submitted = await save({ content, status: 'submitted' });
    assert.equal(submitted.statusCode, 200, submitted.body);
    const saved = JSON.parse(submitted.body).doc;
    assert.equal(saved.content.talkTitle, 'Data pipelines');
    assert.equal(saved.content.bio, content.bio);
    assert.equal(saved.status, 'submitted');
    assert.equal(saved.accessCode, undefined);
    assert.ok(saved.markdownExport.includes(content.summary));
    const invalidEdit = await staffReq('PUT', `/api/sponsor-docs/${doc.id}`, { content: { talkTitle: '' } });
    assert.equal(invalidEdit.statusCode, 422, invalidEdit.body);
    assert.equal((await getSponsorDoc(client, doc.id))?.content.talkTitle, 'Data pipelines');
    const listed = await staffReq('GET', '/api/sponsor-docs', undefined, { cardId: card.id });
    assert.ok(JSON.parse(listed.body).docs.some((item: { id: string; status: string }) => item.id === doc.id && item.status === 'submitted'));
    const exported = await staffReq('GET', `/api/sponsor-docs/${doc.id}/export`);
    assert.equal(exported.statusCode, 200, exported.body);
    assert.ok(exported.body.includes('Data pipelines'));
    assert.ok(exported.body.includes(content.githubUrl));
    const deleted = await staffReq('DELETE', `/api/sponsor-docs/${doc.id}`);
    assert.equal(deleted.statusCode, 200, deleted.body);
    const reloaded = await staffReq('GET', `/api/cards/${card.id}`);
    assert.ok(!JSON.parse(reloaded.body).card.cardLinks.some((link: { url: string }) => link.url === doc.docUrl));
  });

});
