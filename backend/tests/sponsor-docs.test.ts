import { buildHold } from '../src/calendar/holds';
import { putCalendarHold } from '../src/db/calendarHolds';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_ARTIFACTS } from '../src/db/tableNames';
import { sponsorDocKey } from '../src/db/sponsorDocs';

import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createCard } from '../src/db/cards';
import { createPodcastEpisode } from '../src/db/podcastEpisodes';
import { createUser } from '../src/db/users';
import { createSession } from '../src/db/sessions';
import { getSponsorDoc, updateSponsorDoc } from '../src/db/sponsorDocs';
import { setSponsorDocEmailDepsForTests } from '../src/sponsorDocs/emailDelivery';
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
      ['newsletter-main', 'newsletter-secondary', 'newsletter-standalone', 'webinar', 'workshop', 'podcast', 'podcast-guest-research', 'podcast-run-sheet', 'podcast-episode-brief'],
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
    const closingCtaTextDef = placementFields.find((f: { key: string }) => f.key === 'closingCtaText');
    const closingCtaUrlDef = placementFields.find((f: { key: string }) => f.key === 'closingCtaUrl');
    assert.strictEqual(closingCtaTextDef.required, true);
    assert.strictEqual(closingCtaUrlDef.required, true);
    assert.strictEqual(closingCtaUrlDef.format, 'url');
    assert.strictEqual(closingCtaUrlDef.suggestNewsletterUtm, true);
  });

  it('requires CTA button label and URL on newsletter templates when submitting and never rewrites non-UTM URLs silently', async () => {
    const card = await createCard(client, {
      ...templateLink(),
      title: '[Newsletter] (09 NOV 2026) #311 - Modal',
      anchorDate: '2026-11-09',
      sponsor: 'Modal',
    });

    const createRes = await staffReq('POST', '/api/sponsor-docs', {
      cardId: card.id,
      template: 'newsletter-main',
    });
    assert.strictEqual(createRes.statusCode, 201, createRes.body);
    const { doc } = JSON.parse(createRes.body);
    const placementFields = doc.templateDefinition.sections[0].fields;
    const ctaTextDef = placementFields.find((f: { key: string }) => f.key === 'ctaText');
    const ctaUrlDef = placementFields.find((f: { key: string }) => f.key === 'ctaUrl');
    assert.strictEqual(ctaTextDef.required, true);
    assert.strictEqual(ctaUrlDef.required, true);
    assert.strictEqual(ctaUrlDef.format, 'url');
    assert.strictEqual(ctaUrlDef.suggestNewsletterUtm, true);

    // Anonymous asset route serves sponsor-doc-email-card.js
    const assetRes = await anonReq('GET', '/src/surfaces/operations/sponsor-doc-email-card.js');
    assert.strictEqual(assetRes.statusCode, 200);

    // Saving draft without CTA fields succeeds
    const draftRes = await anonReq('PUT', `/api/sponsor-docs/${doc.id}`, {
      codeHeader: doc.accessCode,
      body: {
        content: {
          title: 'Serverless GPU inference',
          intro: 'Run AI workloads in seconds.',
          bullets: '- Fast cold starts\n- Per-second billing\n- Python SDK',
          closing: 'Start building today.',
          ctaText: '',
          ctaUrl: '',
        },
      },
    });
    assert.strictEqual(draftRes.statusCode, 200, draftRes.body);

    // Submitting without CTA label and URL fails with 422
    const missingCtaSubmit = await anonReq('PUT', `/api/sponsor-docs/${doc.id}`, {
      codeHeader: doc.accessCode,
      body: { status: 'submitted' },
    });
    assert.strictEqual(missingCtaSubmit.statusCode, 422, missingCtaSubmit.body);
    const missingFields = JSON.parse(missingCtaSubmit.body).fields;
    assert.ok(missingFields.ctaText);
    assert.ok(missingFields.ctaUrl);

    // Submitting with non-http(s) CTA URL fails with 422
    const invalidUrlSubmit = await anonReq('PUT', `/api/sponsor-docs/${doc.id}`, {
      codeHeader: doc.accessCode,
      body: {
        content: {
          ctaText: 'Try Modal Free',
          ctaUrl: 'modal.com/signup',
        },
        status: 'submitted',
      },
    });
    assert.strictEqual(invalidUrlSubmit.statusCode, 422, invalidUrlSubmit.body);
    assert.ok(JSON.parse(invalidUrlSubmit.body).fields.ctaUrl);

    // Submitting with valid CTA label and URL (without UTM) succeeds and preserves exact URL
    const validSubmit = await anonReq('PUT', `/api/sponsor-docs/${doc.id}`, {
      codeHeader: doc.accessCode,
      body: {
        content: {
          ctaText: 'Try Modal Free',
          ctaUrl: 'https://modal.com/signup',
        },
        status: 'submitted',
      },
    });
    assert.strictEqual(validSubmit.statusCode, 200, validSubmit.body);
    const submittedDoc = JSON.parse(validSubmit.body).doc;
    assert.strictEqual(submittedDoc.status, 'submitted');
    assert.strictEqual(submittedDoc.content.ctaText, 'Try Modal Free');
    assert.strictEqual(
      submittedDoc.content.ctaUrl,
      'https://modal.com/signup',
      'never rewrites CTA URL silently when UTM is omitted',
    );
  });

  it('automatically sends the sponsor form email from orin@datatalks.club via Dapier on create and send-email', async () => {
    const card = await createCard(client, {
      ...templateLink(),
      title: '[Newsletter] (16 NOV 2026) #312 - ClickHouse',
      anchorDate: '2026-11-16',
      sponsor: 'ClickHouse',
    });

    const sentMessages: Array<{ url: string; rawDecoded: string; auth: string }> = [];

    try {
      setSponsorDocEmailDepsForTests({
        brokerUrl: 'https://dapier.example.test',
        credential: 'dp_test_orin_token',
        fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
          if (url === 'https://dapier.example.test/api/agent/token') {
            return new Response(
              JSON.stringify({
                access_token: 'ya29.orin-gmail-access-token',
                expires_in: 3600,
                token_type: 'Bearer',
                connection_id: 'google-calendar-orin',
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (url.includes('/gmail/v1/users/me/profile') || url.includes('/oauth2/v')) {
            return new Response(
              JSON.stringify({ emailAddress: 'orin@datatalks.club', email: 'orin@datatalks.club', verified_email: true }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') {
            const parsedBody = JSON.parse(String(init?.body || '{}'));
            const rawDecoded = Buffer.from(String(parsedBody.raw || ''), 'base64url').toString('utf8');
            const headers = (init?.headers || {}) as Record<string, string>;
            sentMessages.push({
              url,
              rawDecoded,
              auth: headers.Authorization || headers.authorization || '',
            });
            return new Response(
              JSON.stringify({ id: 'gmail-msg-orin-1', threadId: 'gmail-thread-orin-1' }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          throw new Error(`Unexpected fetch URL in test: ${url}`);
        }) as typeof globalThis.fetch,
      });

      const createRes = await staffReq('POST', '/api/sponsor-docs', {
        cardId: card.id,
        template: 'newsletter-main',
        recipientEmail: 'sponsors@clickhouse.example.com',
        recipientName: 'Alex',
      });
      assert.strictEqual(createRes.statusCode, 201, createRes.body);
      const created = JSON.parse(createRes.body);
      assert.strictEqual(created.emailDelivery?.state, 'sent', JSON.stringify(created.emailDelivery));
      assert.strictEqual(created.emailDelivery?.from, 'orin@datatalks.club');
      assert.strictEqual(created.emailDelivery?.to, 'sponsors@clickhouse.example.com');
      assert.strictEqual(created.emailDelivery?.messageId, 'gmail-msg-orin-1');
      assert.strictEqual(created.doc.emailDelivery?.state, 'sent');

      assert.strictEqual(sentMessages.length, 1);
      assert.strictEqual(sentMessages[0].auth, 'Bearer ya29.orin-gmail-access-token');
      assert.match(sentMessages[0].rawDecoded, /From: Orin <orin@datatalks\.club>/);
      assert.match(sentMessages[0].rawDecoded, /To: sponsors@clickhouse\.example\.com/);
      assert.ok(sentMessages[0].rawDecoded.includes(created.doc.shareUrl));
      assert.ok(sentMessages[0].rawDecoded.includes(created.doc.accessCode));

      // Also verify POST /api/sponsor-docs/:id/send-email when gmail.send scope is missing (403)
      setSponsorDocEmailDepsForTests({
        brokerUrl: 'https://dapier.example.test',
        credential: 'dp_test_orin_token',
        fetchImpl: (async (input: string | URL | Request) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
          if (url === 'https://dapier.example.test/api/agent/token') {
            return new Response(
              JSON.stringify({ access_token: 'ya29.orin-no-gmail-scope', expires_in: 3600 }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (url.includes('/gmail/v1/users/me/profile') || url.includes('/oauth2/v')) {
            return new Response(
              JSON.stringify({ emailAddress: 'orin@datatalks.club', email: 'orin@datatalks.club' }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') {
            return new Response(
              JSON.stringify({
                error: {
                  code: 403,
                  message: 'Request had insufficient authentication scopes.',
                  status: 'PERMISSION_DENIED',
                },
              }),
              { status: 403, headers: { 'Content-Type': 'application/json' } },
            );
          }
          throw new Error(`Unexpected fetch URL: ${url}`);
        }) as typeof globalThis.fetch,
      });

      const retryRes = await staffReq('POST', `/api/sponsor-docs/${created.doc.id}/send-email`, {
        recipientEmail: 'sponsors@clickhouse.example.com',
      });
      assert.strictEqual(retryRes.statusCode, 200, retryRes.body);
      const retried = JSON.parse(retryRes.body);
      assert.strictEqual(retried.emailDelivery?.state, 'deferred');
      assert.strictEqual(retried.emailDelivery?.reason, 'insufficient_gmail_scope');
      assert.match(retried.emailDelivery?.message || '', /gmail\.send/);
    } finally {
      setSponsorDocEmailDepsForTests({});
    }
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

  it('keeps the workshop internal section away from the speaker', async () => {
    const card = await createCard(client, { ...templateLink(), title: '[Workshop] Synthetic build', people: ['Test Speaker'] });
    const created = await staffReq('POST', '/api/sponsor-docs', { cardId: card.id });
    assert.equal(created.statusCode, 201, created.body);
    const { doc, card: linkedCard } = JSON.parse(created.body);
    assert.equal(doc.template, 'workshop');
    assert.ok(doc.docUrl.includes('/workshop-docs/'));
    assert.ok(linkedCard.cardLinks.some((link: { name: string; url: string }) => link.name === 'Workshop document' && link.url === doc.docUrl));
    assert.equal((await anonReq('GET', `/workshop-docs/${doc.id}`)).statusCode, 200);
    const staffSave = await staffReq('PUT', `/api/sponsor-docs/${doc.id}`, { content: { prepNotes: 'Rehearse Tuesday', partnerQuestions: 'Credits budget?' } });
    assert.equal(staffSave.statusCode, 200, staffSave.body);
    const save = (body: unknown) => anonReq('PUT', `/api/sponsor-docs/${doc.id}`, { codeHeader: doc.accessCode, body });
    const speaker = JSON.parse((await save({ content: { talkTitle: 'Build it', prepNotes: 'overwritten' } })).body).doc;
    assert.equal(speaker.content.prepNotes, undefined);
    assert.ok(!speaker.templateDefinition.sections.some((section: { internal?: boolean }) => section.internal));
    assert.doesNotMatch(speaker.markdownExport, /Rehearse|Credits|Internal/);
    const speakerExport = await anonReq('GET', `/api/sponsor-docs/${doc.id}/export`, { codeHeader: doc.accessCode });
    assert.doesNotMatch(speakerExport.body, /Rehearse|Credits/);
    const stored = await getSponsorDoc(client, doc.id);
    assert.equal(stored?.content.prepNotes, 'Rehearse Tuesday');
    assert.equal(stored?.content.talkTitle, 'Build it');
    const staffExport = await staffReq('GET', `/api/sponsor-docs/${doc.id}/export`);
    assert.ok(staffExport.body.includes('Rehearse Tuesday'));
  });

  it('switches a webinar form to the workshop type, keeping content and relinking the card', async () => {
    const card = await createCard(client, { ...templateLink(), title: '[Webinar] Synthetic switch', people: ['Test Speaker'] });
    const { doc } = JSON.parse((await staffReq('POST', '/api/sponsor-docs', { cardId: card.id })).body);
    await staffReq('PUT', `/api/sponsor-docs/${doc.id}`, { content: { talkTitle: 'Kept', bio: 'Bio. https://x.test/me' } });
    const switched = await staffReq('PUT', `/api/sponsor-docs/${doc.id}`, { template: 'workshop', content: { bio: 'Bio.', twitterUrl: 'https://x.test/me' } });
    assert.equal(switched.statusCode, 200, switched.body);
    const next = JSON.parse(switched.body).doc;
    assert.equal(next.template, 'workshop');
    assert.equal(next.linkType, 'Workshop document');
    assert.deepEqual([next.content.talkTitle, next.content.bio, next.content.twitterUrl], ['Kept', 'Bio.', 'https://x.test/me']);
    const reloaded = JSON.parse((await staffReq('GET', `/api/cards/${card.id}`)).body).card;
    assert.ok(reloaded.cardLinks.some((link: { name: string; url: string }) => link.name === 'Workshop document' && link.url === next.docUrl));
    assert.ok(!reloaded.cardLinks.some((link: { url: string }) => link.url.includes('/webinar-docs/')));
    const lossy = await staffReq('PUT', `/api/sponsor-docs/${doc.id}`, { template: 'podcast' });
    assert.equal(lossy.statusCode, 422, lossy.body);
    assert.equal((await getSponsorDoc(client, doc.id))?.template, 'workshop');
  });

  it('repairs a stale Card link when retrying an already persisted type switch', async () => {
    const card = await createCard(client, { ...templateLink(), title: '[Webinar] Retry switch' });
    const { doc } = JSON.parse((await staffReq('POST', '/api/sponsor-docs', { cardId: card.id })).body);
    // Reproduce interruption between the document save and the Card relink.
    await updateSponsorDoc(client, doc.id, { template: 'workshop', actorKind: 'staff' });
    const response = await staffReq('PUT', `/api/sponsor-docs/${doc.id}`, { template: 'workshop' });
    assert.equal(response.statusCode, 200, response.body);
    const next = JSON.parse(response.body).doc;
    const reloaded = JSON.parse((await staffReq('GET', `/api/cards/${card.id}`)).body).card;
    assert.ok(reloaded.cardLinks.some((link: { name: string; url: string }) => link.name === 'Workshop document' && link.url === next.docUrl));
    assert.ok(!reloaded.cardLinks.some((link: { url: string }) => link.url.includes('/webinar-docs/')));
  });

  it('uses the card kind when its description mentions another event format', async () => {
    for (const [kind, other] of [['podcast', 'webinar'], ['webinar', 'podcast']]) {
      const card = await createCard(client, {
        ...templateLink(), title: `[${kind}] Synthetic event`, description: `Follow up after the ${other}.`,
      });
      const response = await staffReq('POST', '/api/sponsor-docs', { cardId: card.id });
      assert.equal(response.statusCode, 201, response.body);
      assert.equal(JSON.parse(response.body).doc.template, kind);
    }
  });

  it('copies every template to a new draft and exports real DOCX and Markdown', async () => {
    const sourceCard = await createCard(client, { ...templateLink(), title: '[Podcast] Source' });
    const targetCard = await createCard(client, { ...templateLink(), title: '[Podcast] Target' });
    for (const card of [sourceCard, targetCard]) {
      await createPodcastEpisode(client, { title: 'Confirmed', guests: [], status: 'booked', recordingDate: '2026-12-01', cardId: card.id });
    }
    const templates = JSON.parse((await staffReq('GET', '/api/sponsor-docs/templates')).body).templates;
    for (const template of templates) {
      const fields = [...(template.fields || []), ...(template.sections || []).flatMap((section: { fields?: { key: string; type?: string; derived?: boolean }[] }) => section.fields || [])];
      const field = fields.find((value: { type?: string; derived?: boolean }) => !value.derived && !['url', 'radio', 'select'].includes(value.type || '')) || fields[0];
      const original = await staffReq('POST', '/api/sponsor-docs', { cardId: sourceCard.id, template: template.key, title: `Copy ${template.key}`, content: { [field.key]: 'Authored text' } });
      assert.equal(original.statusCode, 201, original.body);
      const source = JSON.parse(original.body).doc;
      const copied = await staffReq('POST', '/api/sponsor-docs', { cardId: targetCard.id, from: source.id });
      assert.equal(copied.statusCode, 201, copied.body);
      const copy = JSON.parse(copied.body).doc;
      assert.notEqual(copy.id, source.id);
      assert.notEqual(copy.accessCode, source.accessCode);
      assert.equal(copy.cardId, targetCard.id);
      assert.equal(copy.template, template.key);
      assert.equal(copy.content[field.key], 'Authored text');
      assert.equal(copy.status, 'draft');
      assert.equal(copy.version, 1);
      assert.equal(copy.submittedAt, null);
      const markdown = await staffReq('GET', `/api/sponsor-docs/${copy.id}/export`, undefined, { format: 'md' });
      assert.equal(markdown.statusCode, 200);
      assert.ok(markdown.body.includes(copy.title));
      const docx = await staffReq('GET', `/api/sponsor-docs/${copy.id}/export`, undefined, { format: 'docx' });
      assert.equal(docx.statusCode, 200);
      assert.equal(docx.isBase64Encoded, true);
      assert.equal(Buffer.from(docx.body, 'base64').subarray(0, 2).toString(), 'PK');
      assert.match(docx.headers?.['Content-Type'] || '', /wordprocessingml/);
    }
    const missing = await staffReq('POST', '/api/sponsor-docs', { cardId: targetCard.id, from: 'missing-doc' });
    assert.equal(missing.statusCode, 404);
    const badFormat = await staffReq('GET', `/api/sponsor-docs/${JSON.parse((await staffReq('GET', '/api/sponsor-docs', undefined, { cardId: targetCard.id })).body).docs[0].id}/export`, undefined, { format: 'pdf' });
    assert.equal(badFormat.statusCode, 400);
  });

  it('keeps workshop internal content out of external DOCX exports and denies copying anonymously', async () => {
    const card = await createCard(client, { ...templateLink(), title: '[Workshop] Export test' });
    const response = await staffReq('POST', '/api/sponsor-docs', { cardId: card.id, content: { prepNotes: 'PRIVATE-PREP', partnerQuestions: 'PRIVATE-QUESTIONS', talkTitle: 'Public title' } });
    const doc = JSON.parse(response.body).doc;
    const { fromBuffer } = await import('yauzl');
    const exported = await anonReq('GET', `/api/sponsor-docs/${doc.id}/export`, { codeHeader: doc.accessCode, query: { format: 'docx' } });
    assert.equal(exported.statusCode, 200, exported.body);
    const text = await new Promise<string>((resolve, reject) => fromBuffer(Buffer.from(exported.body, 'base64'), { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error);
      zip.on('error', reject);
      zip.on('entry', entry => {
        if (entry.fileName !== 'word/document.xml') return zip.readEntry();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError);
          const chunks: Buffer[] = [];
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => { zip.close(); resolve(Buffer.concat(chunks).toString('utf8')); });
        });
      });
      zip.readEntry();
    }));
    assert.ok(text.includes('Public title'));
    assert.ok(!text.includes('PRIVATE-PREP'));
    assert.ok(!text.includes('PRIVATE-QUESTIONS'));
    const skipAuth = process.env.SKIP_AUTH;
    try {
      process.env.SKIP_AUTH = 'false';
      const denied = await anonReq('POST', '/api/sponsor-docs', { codeHeader: doc.accessCode, body: { cardId: card.id, from: doc.id } });
      assert.ok([401, 403].includes(denied.statusCode), denied.body);
    } finally {
      if (skipAuth === undefined) delete process.env.SKIP_AUTH;
      else process.env.SKIP_AUTH = skipAuth;
    }
  });

  it('checks guest codes and rate limits before resolving a broken event relationship', async () => {
    const card = await createCard(client, { ...templateLink(), title: 'Synthetic event' });
    const created = await staffReq('POST', '/api/sponsor-docs', { cardId: card.id, template: 'podcast' });
    assert.strictEqual(created.statusCode, 201);
    const { doc } = JSON.parse(created.body);
    const stored = (await client.send(new GetCommand({ TableName: TABLE_ARTIFACTS, Key: sponsorDocKey(doc.id) }))).Item!;
    await client.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: { ...stored, cardId: 'missing-synthetic-card' } }));
    for (let attempt = 0; attempt < 4; attempt++) {
      const denied = await anonReq('GET', `/api/sponsor-docs/${doc.id}`, { codeHeader: 'WRONG-TEST-CODE', ip: '203.0.113.55' });
      assert.strictEqual(denied.statusCode, 403, 'bad event links must not bypass authentication');
    }
    const limited = await anonReq('GET', `/api/sponsor-docs/${doc.id}`, { codeHeader: 'WRONG-TEST-CODE', ip: '203.0.113.55' });
    assert.strictEqual(limited.statusCode, 429);
  });

  it('staff, guest, list and export views resolve the current event without document updates', async () => {
    const card = await createCard(client, { ...templateLink(), title: 'Synthetic event', anchorDate: '2030-01-01' });
    let hold = buildHold({ title: 'Synthetic event', topic: 'Synthetic topic', date: '2030-01-01', cardId: card.id, window: 'midday' }, 'test');
    await putCalendarHold(client, hold);
    const created = await staffReq('POST', '/api/sponsor-docs', { cardId: card.id, template: 'podcast' });
    assert.strictEqual(created.statusCode, 201);
    const original = JSON.parse(created.body).doc;
    const moved = buildHold({ title: hold.title, topic: hold.topic, date: '2030-12-03', cardId: card.id, window: 'midday' }, 'test');
    hold = { ...moved, id: hold.id, version: hold.version + 1 }; await putCalendarHold(client, hold);
    const staff = JSON.parse((await staffReq('GET', `/api/sponsor-docs/${original.id}`)).body).doc;
    const guest = JSON.parse((await anonReq('GET', `/api/sponsor-docs/${original.id}`, { codeHeader: original.accessCode })).body).doc;
    const listing = JSON.parse((await staffReq('GET', '/api/sponsor-docs', undefined, { cardId: card.id })).body).docs;
    const exported = await anonReq('GET', `/api/sponsor-docs/${original.id}/export`, { codeHeader: original.accessCode, query: { format: 'markdown' } });
    for (const live of [staff, guest, listing[0]]) {
      assert.strictEqual(live.eventMetadata.date, '2030-12-03');
      assert.strictEqual(live.eventMetadata.state, 'tentative');
      assert.strictEqual(live.version, original.version);
      assert.strictEqual(live.updatedAt, original.updatedAt);
    }
    assert.ok(guest.content.proposedSlotLabel.includes('3 Dec 2030 12:30'));
    assert.strictEqual(exported.statusCode, 200);
    assert.ok(exported.body.includes('3 Dec 2030 12:30'));
    assert.ok(!Object.hasOwn(guest, 'accessCode'));
  });

});
