import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createCard, getCardConsistent } from '../src/db/cards';
import {
  buildNewsletterIssue,
  createNewsletterIssue,
  getNewsletterIssue,
  updateNewsletterIssue,
} from '../src/db/newsletterIssues';
import { createUser } from '../src/db/users';
import { createSession } from '../src/db/sessions';
import { templateLink } from './helpers/cardTemplate';

describe('Newsletter Markdown Storage & HTML Preview (/api/newsletter-issues/:id/markdown)', () => {
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
      email: 'alexey@datatalks.club',
      name: 'Alexey Staff',
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
      'x-forwarded-for': options?.ip || '203.0.113.55',
      'x-newsletter-preview-anonymous': 'true',
    };
    if (options?.codeHeader) {
      headers['x-newsletter-preview-code'] = options.codeHeader;
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

  it('stores issue.md, sources.md, and brief.md on a newsletter issue, renders HTML preview, links the Card, and gates external access by code', async () => {
    const card = await createCard(client, {
      ...templateLink(),
      title: '21 Oct · Phoenix AI · stand-alone',
      anchorDate: '2026-10-21',
      sponsor: 'Phoenix AI',
      cardLinks: [{ name: 'Newsletter Markdown', url: '' }],
    });

    const issue = buildNewsletterIssue(
      {
        kind: 'standalone',
        publicationDate: '2026-10-21',
        publicationTime: '14:00',
        status: 'planned',
        slots: { primary: { sponsor: 'Phoenix AI' } },
      },
      'issue-phoenix-2026-10-21',
    );
    await createNewsletterIssue(client, issue);
    await updateNewsletterIssue(client, issue, { cardId: card.id });

    const issueMd = [
      '---',
      'type: standalone',
      'sponsor: PhoenixAI (PhoenixData)',
      'send_date: 2026-10-21',
      'mailchimp_campaign: https://us19.admin.mailchimp.com/campaigns/edit?id=15816466',
      '---',
      '',
      'Subject: Next Query 2026: How data teams build for analytics and AI',
      '',
      'Preview: Hear from engineers at Apple, Cisco, Microsoft AI, AWS.',
      '',
      '# Next Query 2026: The Data + AI Infrastructure Summit',
      '',
      '![Next Query 2026](sponsor image from the sponsor draft docx, image1.png)',
      '',
      'Join Next Query 2026 on November 4.',
      '',
      '[Register free](https://nextquery.phoenixdata.ai/?utm_source=partner_email)',
      '',
      '- **Help agents answer business questions correctly.** Explore ontologies.',
      '- **Keep analytics reliable.** Hear production lessons.',
    ].join('\n');

    const sourcesMd = '# Sources\n\n- DataOps Card 2fe23a82\n- Mailchimp draft 15816466\n';
    const briefMd = '# Brief\n\n- Dedicated stand-alone sponsor email.\n';

    const putRes = await staffReq(
      'PUT',
      `/api/newsletter-issues/${issue.id}/markdown`,
      { issue: issueMd, sources: sourcesMd, brief: briefMd },
    );
    assert.strictEqual(putRes.statusCode, 200, putRes.body);
    const saved = JSON.parse(putRes.body);

    assert.strictEqual(saved.issueId, issue.id);
    assert.strictEqual(saved.cardId, card.id);
    assert.strictEqual(saved.viewerRole, 'staff');
    assert.strictEqual(saved.previewUrl, `https://ops.dtcdev.click/newsletter-issues/${issue.id}/preview`);
    assert.ok(saved.accessCode, 'generates an access code');
    assert.strictEqual(
      saved.shareUrl,
      `https://ops.dtcdev.click/newsletter-issues/${issue.id}/preview?code=${encodeURIComponent(saved.accessCode)}`,
    );
    assert.strictEqual(saved.markdown.issue, issueMd);
    assert.strictEqual(saved.markdown.sources, sourcesMd);
    assert.strictEqual(saved.markdown.brief, briefMd);
    assert.strictEqual(saved.markdown.updatedByName, 'Alexey Staff');

    // Verify rendered HTML preview
    assert.strictEqual(saved.rendered.subject, 'Next Query 2026: How data teams build for analytics and AI');
    assert.strictEqual(saved.rendered.previewText, 'Hear from engineers at Apple, Cisco, Microsoft AI, AWS.');
    assert.strictEqual(saved.rendered.frontmatter.sponsor, 'PhoenixAI (PhoenixData)');
    assert.match(saved.rendered.issueHtml, /<h1>Next Query 2026: The Data \+ AI Infrastructure Summit<\/h1>/);
    assert.match(saved.rendered.issueHtml, /newsletter-preview-image-placeholder/);
    assert.match(saved.rendered.issueHtml, /newsletter-preview-cta__link/);
    assert.match(saved.rendered.issueHtml, /<strong>Help agents answer business questions correctly\.<\/strong>/);
    assert.match(saved.rendered.sourcesHtml, /<h1>Sources<\/h1>/);
    assert.match(saved.rendered.briefHtml, /<h1>Brief<\/h1>/);

    // Verify Card link and issue link were automatically populated
    const updatedCard = await getCardConsistent(client, card.id);
    const mdCardLink = (updatedCard?.cardLinks || []).find((l) => l.name === 'Newsletter Markdown');
    assert.strictEqual(mdCardLink?.url, `https://ops.dtcdev.click/newsletter-issues/${issue.id}/preview`);

    const storedIssue = await getNewsletterIssue(client, issue.id);
    const mdIssueLink = (storedIssue?.links || []).find((l) => l.name === 'Newsletter Markdown');
    assert.strictEqual(mdIssueLink?.url, `https://ops.dtcdev.click/newsletter-issues/${issue.id}/preview`);

    // Verify GET /api/newsletter-issues/:id strips internal hash/ciphertext and exposes previewShareUrl
    const getIssueRes = await staffReq('GET', `/api/newsletter-issues/${issue.id}`);
    assert.strictEqual(getIssueRes.statusCode, 200);
    const issuePayload = JSON.parse(getIssueRes.body);
    assert.strictEqual(issuePayload.previewAccessCodeHash, undefined);
    assert.strictEqual(issuePayload.previewAccessCodeCiphertext, undefined);
    assert.strictEqual(issuePayload.previewShareUrl, saved.shareUrl);

    // Verify single-kind update preserves other kinds
    const singleUpdateRes = await staffReq(
      'PUT',
      `/api/newsletter-issues/${card.id}/markdown`,
      { kind: 'brief', content: '# Updated Brief\n\n- Ready to send.\n' },
    );
    assert.strictEqual(singleUpdateRes.statusCode, 200, singleUpdateRes.body);
    const singleSaved = JSON.parse(singleUpdateRes.body);
    assert.strictEqual(singleSaved.markdown.issue, issueMd);
    assert.strictEqual(singleSaved.markdown.sources, sourcesMd);
    assert.strictEqual(singleSaved.markdown.brief, '# Updated Brief\n\n- Ready to send.\n');
    assert.strictEqual(singleSaved.accessCode, saved.accessCode);

    // Anonymous external access without code -> 401
    const noCodeRes = await anonReq('GET', `/api/newsletter-issues/${issue.id}/markdown`);
    assert.strictEqual(noCodeRes.statusCode, 401);
    assert.strictEqual(JSON.parse(noCodeRes.body).code, 'access_code_required');

    // Anonymous external access with wrong code -> 403
    const wrongCodeRes = await anonReq('GET', `/api/newsletter-issues/${issue.id}/markdown`, {
      query: { code: '2345-6789-ABCD-EFGH' },
    });
    assert.strictEqual(wrongCodeRes.statusCode, 403);
    assert.strictEqual(JSON.parse(wrongCodeRes.body).code, 'invalid_access_code');

    // Anonymous external access with valid ?code= query parameter -> 200
    const validQueryRes = await anonReq('GET', `/api/newsletter-issues/${issue.id}/markdown`, {
      query: { code: saved.accessCode.toLowerCase().replace(/-/g, '') },
    });
    assert.strictEqual(validQueryRes.statusCode, 200, validQueryRes.body);
    const extPayload = JSON.parse(validQueryRes.body);
    assert.strictEqual(extPayload.viewerRole, 'external');
    assert.strictEqual(extPayload.accessCode, undefined);
    assert.strictEqual(extPayload.shareUrl, undefined);
    assert.strictEqual(extPayload.rendered.subject, 'Next Query 2026: How data teams build for analytics and AI');

    // Rotate code -> old code fails, new code works
    const rotateRes = await staffReq('POST', `/api/newsletter-issues/${issue.id}/markdown/rotate-code`, {});
    assert.strictEqual(rotateRes.statusCode, 200, rotateRes.body);
    const rotated = JSON.parse(rotateRes.body);
    assert.notStrictEqual(rotated.accessCode, saved.accessCode);

    const oldCodeRes = await anonReq('GET', `/api/newsletter-issues/${issue.id}/markdown`, {
      codeHeader: saved.accessCode,
    });
    assert.strictEqual(oldCodeRes.statusCode, 403);

    const newCodeRes = await anonReq('GET', `/api/newsletter-issues/${issue.id}/markdown`, {
      codeHeader: rotated.accessCode,
    });
    assert.strictEqual(newCodeRes.statusCode, 200);

    // Rate limiting after 5 failed attempts from an IP
    const rateIp = '198.51.100.77';
    for (let i = 0; i < 4; i += 1) {
      const r = await anonReq('GET', `/api/newsletter-issues/${issue.id}/markdown`, {
        codeHeader: '2345-6789-ABCD-EFGH',
        ip: rateIp,
      });
      assert.strictEqual(r.statusCode, 403);
    }
    const fifth = await anonReq('GET', `/api/newsletter-issues/${issue.id}/markdown`, {
      codeHeader: '2345-6789-ABCD-EFGH',
      ip: rateIp,
    });
    assert.strictEqual(fifth.statusCode, 429);
    assert.strictEqual(JSON.parse(fifth.body).code, 'rate_limited');
  });
});
