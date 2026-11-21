import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTemplate } from '../src/db/templates';
import { createUser } from '../src/db/users';
import { humanBearer } from './helpers/human-bearer';
import type { LambdaResponse, Template } from '../src/types';

/**
 * The event format policy: DataOps runs events only as workshop, webinar and
 * podcast, each served by its one canonical Git-authored Template. Custom
 * Templates never claim an event format, event Cards never instantiate from
 * non-canonical Templates, event Cards carry only their format's documents,
 * and `sponsored` is a flag that changes no template or validation.
 */

describe('Event format policy (three formats, format docs, sponsored flag)', () => {
  let port: number;
  let client: DynamoDBDocumentClient;
  let handler: typeof import('../src/handler').handler;
  let adminUserId: string;
  let adminToken: string;

  let podcastGit: Template;
  let webinarGit: Template;
  let workshopGit: Template;
  let newsletterGit: Template;
  let aishlVariant: Template;
  let plainCustom: Template;

  const PODCAST_GUEST_MATERIALS_CONTENT = {
    guestName: 'Test Guest',
    introduction: 'A short introduction.',
    currentFocus: 'Current work.',
    topicsToCover: 'Topic one\nTopic two',
  };
  const EPISODE_BRIEF_REQUIRED_CONTENT = {
    goal: 'Help listeners understand the topic.',
    audience: 'Data engineers.',
    structure: 'Intro, questions, closing.',
    guestName: 'Test Guest',
    guestBio: 'A guest.',
    keyMessages: 'One\nTwo\nThree',
    linksAssets: 'https://example.test/brief',
    nextSteps: 'Confirm the recording date.',
  };
  const WEBINAR_REQUIRED_FIELDS = ['talkTitle', 'outline', 'bio'];

  before(async () => {
    port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    process.env.IS_LOCAL = 'true';
    handler = (await import('../src/handler')).handler;

    const user = await createUser(client, {
      email: 'formats-admin@datatalks.club',
      name: 'Formats Admin',
      passwordHash: 'unused',
      role: 'admin',
    });
    adminUserId = user.id;
    adminToken = await humanBearer(client, adminUserId);

    const eventTasks = [{ refId: 'run', description: 'Run the event', offsetDays: 0 }];
    podcastGit = await createTemplate(client, {
      name: 'Podcast', type: 'podcast', origin: 'git',
      sourcePath: 'workflow-templates/podcast.yaml', sourceRevision: 'test-podcast-sha',
      triggerType: 'manual', taskDefinitions: eventTasks,
    });
    webinarGit = await createTemplate(client, {
      name: 'Webinar', type: 'webinar', origin: 'git',
      sourcePath: 'workflow-templates/webinar.yaml', sourceRevision: 'test-webinar-sha',
      triggerType: 'manual', taskDefinitions: eventTasks,
    });
    workshopGit = await createTemplate(client, {
      name: 'Workshop', type: 'workshop', origin: 'git',
      sourcePath: 'workflow-templates/workshop.yaml', sourceRevision: 'test-workshop-sha',
      triggerType: 'manual', taskDefinitions: eventTasks,
    });
    newsletterGit = await createTemplate(client, {
      name: 'Newsletter', type: 'newsletter', origin: 'git',
      sourcePath: 'workflow-templates/newsletter.yaml', sourceRevision: 'test-newsletter-sha',
      triggerType: 'manual', taskDefinitions: eventTasks,
    });
    // The legacy shape the policy must contain: a Custom Template claiming a
    // workshop variant, seeded directly as it exists in the live table.
    aishlVariant = await createTemplate(client, {
      name: 'AISHL Workshop', type: 'aishl-workshop', origin: 'custom',
      triggerType: 'manual', taskDefinitions: eventTasks,
    });
    plainCustom = await createTemplate(client, {
      name: 'Internal Notes', type: 'internal-notes', origin: 'custom',
      triggerType: 'manual', taskDefinitions: eventTasks,
    });
  });

  after(async () => {
    await stopLocal();
    delete process.env.IS_LOCAL;
  });

  function req(method: string, path: string, body?: unknown) {
    return handler({
      httpMethod: method,
      path,
      headers: {
        authorization: `Bearer ${adminToken}`,
        'x-user-id': adminUserId,
        host: 'ops.dtcdev.click',
        'x-forwarded-proto': 'https',
      },
      queryStringParameters: null,
      body: body === undefined ? null : JSON.stringify(body),
    }, {}) as Promise<LambdaResponse>;
  }

  function payload(response: LambdaResponse): any {
    return JSON.parse(response.body);
  }

  async function createCard(templateId: string, overrides: Record<string, unknown> = {}): Promise<LambdaResponse> {
    return req('POST', '/api/cards', {
      templateId,
      title: 'Test Event',
      anchorDate: '2026-12-01',
      ...overrides,
    });
  }

  describe('Custom Templates never claim an event format', () => {
    for (const type of ['sponsored-podcast', 'podcast-sponsor', 'aishl-workshop', 'workshop', 'webinar', 'podcast']) {
      it(`POST /api/templates rejects type "${type}" with a clear error`, async () => {
        const res = await req('POST', '/api/templates', {
          name: 'Sponsor Variant', type, triggerType: 'manual',
          taskDefinitions: [{ refId: 'one', description: 'Task', offsetDays: 0 }],
        });
        assert.strictEqual(res.statusCode, 422);
        const body = payload(res);
        assert.strictEqual(body.code, 'event-format-template-forbidden');
        assert.match(body.error, /canonical|variant/i);
        assert.match(body.error, /Sponsorship is a Card flag, not a format/);
      });
    }

    it('a Custom Template outside the event formats still creates', async () => {
      const res = await req('POST', '/api/templates', {
        name: 'Internal Reference Check', type: 'internal-refcheck', triggerType: 'manual',
        taskDefinitions: [{ refId: 'one', description: 'Task', offsetDays: 0 }],
      });
      assert.strictEqual(res.statusCode, 201);
    });
  });

  describe('Event Cards instantiate only from the canonical format Templates', () => {
    it('a Custom event-format variant Template cannot create a Card', async () => {
      const res = await createCard(aishlVariant.id);
      assert.strictEqual(res.statusCode, 422);
      assert.strictEqual(payload(res).code, 'event-format-template-required');
      assert.match(payload(res).error, /only from the canonical workshop, webinar and podcast Templates/);
    });

    it('a Custom Template cannot claim an event format through the title tag', async () => {
      const res = await createCard(plainCustom.id, { title: '[Workshop] Sneaky Sponsor Run' });
      assert.strictEqual(res.statusCode, 422);
      assert.strictEqual(payload(res).code, 'event-format-template-required');
    });

    it('a Custom Template accepts an untagged, non-event title', async () => {
      const res = await createCard(plainCustom.id, { title: 'Quarterly notes sweep' });
      assert.strictEqual(res.statusCode, 201);
    });

    it('the canonical podcast Template still creates Cards, tagged legacy titles included', async () => {
      for (const title of ['Web Scraping at Scale', '[Podcast] Legacy Tagged Title']) {
        const res = await createCard(podcastGit.id, { title });
        assert.strictEqual(res.statusCode, 201, `${title}: ${res.body}`);
        assert.strictEqual(payload(res).card.templateId, podcastGit.id);
      }
    });
  });

  describe('Event Cards carry only their format\'s documents', () => {
    let podcastCardId: string;

    before(async () => {
      const res = await createCard(podcastGit.id, { title: 'Doc Format Host Card' });
      assert.strictEqual(res.statusCode, 201);
      podcastCardId = payload(res).card.id;
    });

    it('a workshop document on a podcast Card is rejected with a clear error', async () => {
      const res = await req('POST', '/api/sponsor-docs', {
        cardId: podcastCardId, template: 'workshop', autoSendEmail: false,
      });
      assert.strictEqual(res.statusCode, 422);
      const body = payload(res);
      assert.strictEqual(body.code, 'doc_template_format_mismatch');
      assert.match(body.error, /does not belong to the podcast format/);
      assert.match(body.error, /podcast, podcast-episode-brief, podcast-run-sheet, podcast-guest-research/);
    });

    it('a webinar document on a podcast Card is rejected the same way', async () => {
      const res = await req('POST', '/api/sponsor-docs', {
        cardId: podcastCardId, template: 'webinar', autoSendEmail: false,
      });
      assert.strictEqual(res.statusCode, 422);
      assert.strictEqual(payload(res).code, 'doc_template_format_mismatch');
    });

    it('the podcast format\'s own document templates still create', async () => {
      for (const template of ['podcast', 'podcast-episode-brief']) {
        const res = await req('POST', '/api/sponsor-docs', {
          cardId: podcastCardId, template, autoSendEmail: false,
        });
        assert.strictEqual(res.statusCode, 201, `${template}: ${res.body}`);
        assert.strictEqual(payload(res).doc.template, template);
      }
    });

    it('a template switch stays inside the Card\'s format', async () => {
      const fresh = await req('POST', '/api/sponsor-docs', {
        cardId: podcastCardId, template: 'podcast', autoSendEmail: false,
      });
      const freshId = payload(fresh).doc.id;
      const stay = await req('PUT', `/api/sponsor-docs/${freshId}`, { template: 'podcast-episode-brief' });
      assert.strictEqual(stay.statusCode, 200);
      assert.strictEqual(payload(stay).doc.template, 'podcast-episode-brief');

      const leave = await req('PUT', `/api/sponsor-docs/${freshId}`, { template: 'webinar' });
      assert.strictEqual(leave.statusCode, 422);
      assert.strictEqual(payload(leave).code, 'doc_template_format_mismatch');
    });
  });

  describe('Deviating document content is rejected on save', () => {
    let podcastCardId: string;
    let docId: string;

    before(async () => {
      const res = await createCard(podcastGit.id, { title: 'Deviating Content Host' });
      podcastCardId = payload(res).card.id;
      const doc = await req('POST', '/api/sponsor-docs', {
        cardId: podcastCardId, template: 'podcast', autoSendEmail: false,
      });
      docId = payload(doc).doc.id;
    });

    it('a save carrying a field outside the template fails with a visible error', async () => {
      const res = await req('PUT', `/api/sponsor-docs/${docId}`, {
        content: { guestName: 'Test Guest', sponsoredPlacement: 'logo in show notes' },
      });
      assert.strictEqual(res.statusCode, 422);
      const body = payload(res);
      assert.strictEqual(body.code, 'invalid_content');
      assert.match(body.fields.sponsoredPlacement, /is not a field of the/);
    });

    it('a created document with off-template content is rejected, not silently reshaped', async () => {
      const res = await req('POST', '/api/sponsor-docs', {
        cardId: podcastCardId, template: 'podcast', autoSendEmail: false,
        content: { guestName: 'Test Guest', freeformBanner: 'buy widgets' },
      });
      assert.strictEqual(res.statusCode, 422);
      assert.strictEqual(payload(res).code, 'invalid_content');
      assert.ok(payload(res).fields.freeformBanner);
    });

    it('submitting an incomplete document still lists its missing required fields', async () => {
      const webinarCard = payload(await createCard(webinarGit.id, { title: 'Incomplete Submit Host' })).card;
      const doc = await req('POST', '/api/sponsor-docs', {
        cardId: webinarCard.id, template: 'webinar', autoSendEmail: false,
      });
      const res = await req('PUT', `/api/sponsor-docs/${payload(doc).doc.id}`, {
        content: {}, status: 'submitted',
      });
      assert.strictEqual(res.statusCode, 422);
      assert.strictEqual(payload(res).code, 'invalid_content');
      for (const field of WEBINAR_REQUIRED_FIELDS) {
        assert.ok(payload(res).fields[field], `expected ${field} among ${JSON.stringify(payload(res).fields)}`);
      }
    });

    it('a complete on-template save succeeds', async () => {
      const res = await req('PUT', `/api/sponsor-docs/${docId}`, {
        content: PODCAST_GUEST_MATERIALS_CONTENT,
        status: 'submitted',
      });
      assert.strictEqual(res.statusCode, 200, res.body);
      assert.strictEqual(payload(res).doc.status, 'submitted');
    });
  });

  describe('The sponsored flag is a Card attribute, never a format', () => {
    it('creates with sponsored: true and the flag is visible on the Card', async () => {
      const res = await createCard(podcastGit.id, { title: 'Sponsored Run', sponsored: true });
      assert.strictEqual(res.statusCode, 201);
      assert.strictEqual(payload(res).card.sponsored, true);
    });

    it('rejects a non-boolean sponsored value', async () => {
      const res = await createCard(podcastGit.id, { title: 'Bad Flag', sponsored: 'yes' });
      assert.strictEqual(res.statusCode, 400);
      assert.match(payload(res).error, /sponsored must be a boolean/);
    });

    it('updates the flag in both directions', async () => {
      const created = await createCard(podcastGit.id, { title: 'Flag Flip', sponsored: false });
      const { id, version } = payload(created).card;
      const on = await req('PUT', `/api/cards/${id}`, { sponsored: true, expectedVersion: version });
      assert.strictEqual(on.statusCode, 200);
      assert.strictEqual(payload(on).card.sponsored, true);
      const off = await req('PUT', `/api/cards/${id}`, { sponsored: false, expectedVersion: payload(on).card.version });
      assert.strictEqual(off.statusCode, 200);
      assert.strictEqual(payload(off).card.sponsored, false);
    });

    it('a sponsored and a non-sponsored Card of one format get identical document templates and validation', async () => {
      const plain = payload(await createCard(podcastGit.id, { title: 'Same Format A' })).card;
      const flagged = payload(await createCard(podcastGit.id, {
        title: 'Same Format B', sponsored: true,
      })).card;

      const plainDoc = await req('POST', '/api/sponsor-docs', { cardId: plain.id, autoSendEmail: false });
      const flaggedDoc = await req('POST', '/api/sponsor-docs', { cardId: flagged.id, autoSendEmail: false });
      assert.strictEqual(plainDoc.statusCode, 201);
      assert.strictEqual(flaggedDoc.statusCode, 201);
      assert.strictEqual(payload(plainDoc).doc.template, 'podcast');
      assert.strictEqual(payload(flaggedDoc).doc.template, 'podcast');

      // Identical validation: the same on-template submit succeeds on both,
      // and the same off-template field fails on both with the same error.
      for (const doc of [plainDoc, flaggedDoc]) {
        const docId = payload(doc).doc.id;
        const ok = await req('PUT', `/api/sponsor-docs/${docId}`, {
          content: PODCAST_GUEST_MATERIALS_CONTENT, status: 'submitted',
        });
        assert.strictEqual(ok.statusCode, 200, ok.body);
      }
      const brief = payload(await req('POST', '/api/sponsor-docs', {
        cardId: plain.id, template: 'podcast-episode-brief', autoSendEmail: false,
        content: EPISODE_BRIEF_REQUIRED_CONTENT,
      })).doc;
      const flaggedBrief = payload(await req('POST', '/api/sponsor-docs', {
        cardId: flagged.id, template: 'podcast-episode-brief', autoSendEmail: false,
        content: EPISODE_BRIEF_REQUIRED_CONTENT,
      })).doc;
      for (const doc of [brief, flaggedBrief]) {
        const deviation = await req('PUT', `/api/sponsor-docs/${doc.id}`, {
          content: { offTemplateField: 'x' },
        });
        assert.strictEqual(deviation.statusCode, 422);
        assert.strictEqual(payload(deviation).code, 'invalid_content');
      }
    });

    it('workshop and webinar Cards take the flag through the same path', async () => {
      for (const template of [workshopGit.id, webinarGit.id]) {
        const res = await createCard(template, { title: 'Flagged Non-Podcast', sponsored: true });
        assert.strictEqual(res.statusCode, 201);
        assert.strictEqual(payload(res).card.sponsored, true);
      }
    });
  });

  describe('Newsletter stays allowed and untouched', () => {
    it('the canonical newsletter Template still creates Cards', async () => {
      const res = await createCard(newsletterGit.id, { title: '16 Nov · #303 · Astronomer' });
      assert.strictEqual(res.statusCode, 201);
    });

    it('a newsletter document on a newsletter Card still creates and saves', async () => {
      const card = payload(await createCard(newsletterGit.id, { title: 'Newsletter Doc Host' })).card;
      const created = await req('POST', '/api/sponsor-docs', {
        cardId: card.id, template: 'newsletter-main', autoSendEmail: false,
      });
      assert.strictEqual(created.statusCode, 201, created.body);
      const docId = payload(created).doc.id;
      const saved = await req('PUT', `/api/sponsor-docs/${docId}`, {
        content: { subjectLine: 'Weekly', title: 'Issue', intro: 'Hello' },
      });
      assert.strictEqual(saved.statusCode, 200, saved.body);
    });

    it('a Custom Template may keep newsletter-tagged titles', async () => {
      const res = await createCard(plainCustom.id, { title: '[Newsletter] 1 Dec · #999' });
      assert.strictEqual(res.statusCode, 201);
    });
  });

});
