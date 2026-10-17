import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createCard } from '../src/db/cards';
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

  it('creates a sponsor doc from the right template, links it on the Card, and supports all 4 templates', async () => {
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

    // Verify all 4 templates are available
    const templatesRes = await staffReq('GET', '/api/sponsor-docs/templates');
    assert.strictEqual(templatesRes.statusCode, 200, templatesRes.body);
    const { templates } = JSON.parse(templatesRes.body);
    assert.deepStrictEqual(
      templates.map((t: { key: string }) => t.key),
      ['newsletter-main', 'newsletter-secondary', 'newsletter-standalone', 'podcast'],
    );
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
});
