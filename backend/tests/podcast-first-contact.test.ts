import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createUser } from '../src/db/users';
import { createSession } from '../src/db/sessions';
import {
  PODCAST_DOCS_URL,
  PODCAST_FIRST_CONTACT_FROM,
  formatSlotLabel,
  renderPodcastFirstContactEmail,
} from '../src/podcast/firstContact';

describe('podcast first-contact email (Orin ask)', () => {
  let client: DynamoDBDocumentClient;
  let handler: typeof import('../src/handler').handler;
  let staffUserId: string;
  let staffToken: string;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    process.env.IS_LOCAL = 'true';
    handler = (await import('../src/handler')).handler;
    const user = await createUser(client, {
      email: 'staff@datatalks.club',
      name: 'Orin Staff',
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

  const staffReq = (method: string, path: string, body?: unknown) =>
    handler({
      httpMethod: method,
      path,
      headers: {
        authorization: `Bearer ${staffToken}`,
        'x-user-id': staffUserId,
        host: 'ops.dtcdev.click',
        'x-forwarded-proto': 'https',
      },
      queryStringParameters: null,
      body: body === undefined ? null : JSON.stringify(body),
    }, {});

  it('sends from orin@ with one proposed slot, the docs URL, and no card', async () => {
    const email = renderPodcastFirstContactEmail({
      guestFirstName: 'Sofiia',
      slotLabel: 'Tuesday, November 4 at 12:30 CET',
    });
    assert.strictEqual(email.from, PODCAST_FIRST_CONTACT_FROM);
    assert.strictEqual(email.from, 'orin@datatalks.club');
    assert.strictEqual(email.subject, 'Sofiia at DataTalks.Club Podcast');
    assert.ok(email.body.includes('Tuesday, November 4 at 12:30 CET'));
    assert.ok(email.body.includes(PODCAST_DOCS_URL));
    assert.strictEqual(
      PODCAST_DOCS_URL,
      'https://datatalksclub.github.io/docs/activities/podcast/',
    );
    // No topic ask: the guest is never asked to propose topics in first contact.
    assert.ok(!/ideas on the topic/i.test(email.body));
    assert.ok(!/do you already have ideas/i.test(email.body));
    // No draft card: the renderer returns copy only, never a card reference.
    assert.ok(!/card/i.test(email.body));
    assert.ok(!('cardId' in email));
    // Exactly one slot: the single label appears once, no slot list.
    assert.strictEqual(email.body.split('Tuesday, November 4 at 12:30 CET').length - 1, 1);
  });

  it('links the public docs page, never the old Google Doc', () => {
    const email = renderPodcastFirstContactEmail({
      guestFirstName: 'Jane',
      slotLabel: 'Monday, November 3 at 12:30 CET',
    });
    assert.ok(!/docs\.google\.com/.test(email.body));
    assert.ok(email.body.includes('https://datatalksclub.github.io/docs/activities/podcast/'));
  });

  it('rejects blank guest name or slot instead of rendering unresolved copy', () => {
    assert.throws(
      () => renderPodcastFirstContactEmail({ guestFirstName: '  ', slotLabel: 'Monday at 12:00' }),
      /guestFirstName is required/,
    );
    assert.throws(
      () => renderPodcastFirstContactEmail({ guestFirstName: 'Jane', slotLabel: '  ' }),
      /slotLabel is required/,
    );
  });

  it('formats a hold instant as a Berlin slot label', () => {
    // 2026-11-04 16:30 Europe/Berlin (CET) == 15:30Z.
    assert.strictEqual(
      formatSlotLabel('2026-11-04T15:30:00.000Z'),
      'Wednesday 4 November at 16:30 CET',
    );
    assert.throws(() => formatSlotLabel('not-a-date'), /startIso must be a valid ISO instant/);
  });

  it('POST /api/podcast-first-contact/email renders the same copy over HTTP', async () => {
    const res = await staffReq('POST', '/api/podcast-first-contact/email', {
      guestFirstName: 'Sofiia',
      slotLabel: 'Tuesday, November 4 at 12:30 CET',
    });
    assert.strictEqual(res.statusCode, 200, res.body);
    const payload = JSON.parse(res.body);
    assert.strictEqual(payload.from, 'orin@datatalks.club');
    assert.strictEqual(payload.subject, 'Sofiia at DataTalks.Club Podcast');
    assert.ok(payload.body.includes('Tuesday, November 4 at 12:30 CET'));
    assert.ok(payload.body.includes('https://datatalksclub.github.io/docs/activities/podcast/'));
    assert.ok(!('cardId' in payload));
    assert.ok(!('card' in payload));
  });


  it('does not ask the guest to invent alternate times; points at the form when given', () => {
    const email = renderPodcastFirstContactEmail({
      guestFirstName: 'Ian',
      slotLabel: 'Monday, November 3 at 12:30 CET',
      formUrl: 'https://ops.dtcdev.click/sponsor-docs/abc?code=CODE',
      topicSeed: 'building developer platforms',
    });
    assert.ok(email.body.includes('building developer platforms'));
    assert.ok(email.body.includes('https://ops.dtcdev.click/sponsor-docs/abc?code=CODE'));
    assert.ok(/do not invent alternate/i.test(email.body));
    assert.equal(email.formUrl, 'https://ops.dtcdev.click/sponsor-docs/abc?code=CODE');
    assert.equal(email.topicSeed, 'building developer platforms');
  });

  it('POST /api/podcast-first-contact/email 400s without a slot', async () => {
    const res = await staffReq('POST', '/api/podcast-first-contact/email', {
      guestFirstName: 'Sofiia',
    });
    assert.strictEqual(res.statusCode, 400, res.body);
  });
});
