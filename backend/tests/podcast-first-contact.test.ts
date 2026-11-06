import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createUser } from '../src/db/users';
import { createSession } from '../src/db/sessions';
import { createTask, getTaskConsistent } from '../src/db/tasks';
import { createCard } from '../src/db/cards';
import { createSponsorDoc } from '../src/db/sponsorDocs';
import { putCalendarHold } from '../src/db/calendarHolds';
import { buildHold } from '../src/calendar/holds';
import { templateLink } from './helpers/cardTemplate';
import { setSponsorDocEmailDepsForTests } from '../src/sponsorDocs/emailDelivery';
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
    setSponsorDocEmailDepsForTests({});
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
      'Wednesday 4 November 2026 at 16:30 CET',
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
    assert.ok(/ordinary free Mon\/Tue slots/.test(email.body));
    assert.ok(!/couple of sentences/i.test(email.body));
    assert.ok(!/either way works/i.test(email.body));
    assert.ok(/if none fit, just reply to this email/i.test(email.body));
    assert.ok(!/[\u2013\u2014\u201c\u201d]/.test(email.body));
    assert.ok(email.body.endsWith('Best regards,\nOrin Vale'));
    assert.ok(!/custom/.test(email.body));
    assert.equal(email.formUrl, 'https://ops.dtcdev.click/sponsor-docs/abc?code=CODE');
    assert.equal(email.topicSeed, 'building developer platforms');
  });

  it('keeps example publication bullets consecutive (no blank line between items)', () => {
    const email = renderPodcastFirstContactEmail({
      guestFirstName: 'Sofiia',
      slotLabel: 'Tuesday, November 4 at 12:30 CET',
    });
    // Valeria/Orin: Gmail showed extra blank lines between "- Blog posts" items
    // when the renderer joined with empty string lines. Tight list = single \n.
    assert.ok(
      email.body.includes(
        '1. Blog posts\n2. Talks and podcast interviews\n3. Social media posts\n4. Github repositories\n\n',
      ),
      'expected tight bullet block with single newlines between items',
    );
    assert.ok(
      !email.body.includes('- Blog posts\n\n- Talks'),
      'must not insert a blank line between consecutive list items',
    );
  });

  it('form-only path: no reply-instead wording without formUrl either', () => {
    const email = renderPodcastFirstContactEmail({
      guestFirstName: 'Sofiia',
      slotLabel: 'Tuesday, November 4 at 12:30 CET',
    });
    assert.ok(!/couple of sentences/i.test(email.body));
    assert.ok(!/either way works/i.test(email.body));
    assert.ok(!/reply to this email/i.test(email.body));
    assert.ok(/via the form/i.test(email.body));
    assert.ok(/do not invent alternate/i.test(email.body));
  });

  it('POST /api/podcast-first-contact/email 400s without a slot', async () => {
    const res = await staffReq('POST', '/api/podcast-first-contact/email', {
      guestFirstName: 'Sofiia',
    });
    assert.strictEqual(res.statusCode, 400, res.body);
  });

  async function invitation() {
    const card = await createCard(client, { ...templateLink(), title: 'Synthetic guest podcast', anchorDate: '2030-11-04' });
    const hold = buildHold({ date: '2030-11-04', title: 'Synthetic Guest at DataTalks.Club Podcast', topic: 'Reliable data agents', guestRef: 'guest@example.test', cardId: card.id, window: 'evening' }, staffUserId);
    hold.googleSync = { state: 'synced' };
    await putCalendarHold(client, hold);
    const { doc } = await createSponsorDoc(client, { cardId: card.id, template: 'podcast', title: 'Synthetic guest materials', createdBy: staffUserId });
    const task = await createTask(client, { description: 'Send synthetic invitation', date: '2030-11-04', cardId: card.id });
    return { holdId: hold.id, docId: doc.id, taskId: task.id, guestName: 'Synthetic Guest' };
  }

  it('previews saved proposal and guest form without sending or claiming the Task', async () => {
    const input = await invitation();
    const res = await staffReq('POST', '/api/podcast-first-contact/send', { ...input, preview: true });
    assert.equal(res.statusCode, 200, res.body);
    const output = JSON.parse(res.body);
    assert.equal(output.email.to, 'guest@example.test');
    assert.deepEqual(output.email.cc, []);
    assert.match(output.email.body, /Monday 4 November 2030 at 17:00 CET/);
    assert.match(output.email.body, /Reliable data agents/);
    assert.match(output.email.formUrl, new RegExp(`/podcast-docs/${input.docId}\\?code=`));
    assert.equal((await getTaskConsistent(client, input.taskId))!.podcastFirstContact, undefined);
  });

  it('sends through DataOps, records evidence, and replays without another provider send', async () => {
    const input = await invitation();
    let sends = 0;
    let mime = '';
    setSponsorDocEmailDepsForTests({ credential: 'synthetic-credential', fetchImpl: async (url, init) => {
      if (String(url).endsWith('/messages/send')) {
        sends += 1;
        mime = Buffer.from(JSON.parse(String(init?.body)).raw, 'base64url').toString('utf8');
        return new Response(JSON.stringify({ id: 'synthetic-message', threadId: 'synthetic-thread' }), { status: 200 });
      }
      return new Response(JSON.stringify({ access_token: 'synthetic-access', provider_account_id: 'orin@datatalks.club' }), { status: 200 });
    } });
    const results = await Promise.all([staffReq('POST', '/api/podcast-first-contact/send', input), staffReq('POST', '/api/podcast-first-contact/send', input)]);
    assert.equal(results.filter(result => result.statusCode === 200).length, 1);
    assert.equal(results.filter(result => result.statusCode === 409).length, 1);
    assert.equal(sends, 1);
    assert.match(mime, /To: guest@example.test/);
    assert.ok(!mime.includes('Cc:'));
    assert.match(mime, /Best regards,\r\nOrin Vale/);
    const saved = (await getTaskConsistent(client, input.taskId))!;
    assert.equal(saved.podcastFirstContact!.state, 'sent');
    assert.equal(saved.podcastFirstContact!.delivery!.messageId, 'synthetic-message');
    assert.ok(saved.notesLog!.some(note => note.text.includes('synthetic-message')));
    const replay = await staffReq('POST', '/api/podcast-first-contact/send', input);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(JSON.parse(replay.body).alreadySent, true);
    assert.equal(sends, 1);
    setSponsorDocEmailDepsForTests({});
  });

  it('rejects an unrelated guest form before attempting delivery', async () => {
    const input = await invitation();
    const other = await invitation();
    const res = await staffReq('POST', '/api/podcast-first-contact/send', { ...input, docId: other.docId });
    assert.equal(res.statusCode, 422, res.body);
    assert.equal((await getTaskConsistent(client, input.taskId))!.podcastFirstContact, undefined);
  });

  it('does not repeat an ambiguous provider attempt', async () => {
    const input = await invitation();
    let sends = 0;
    setSponsorDocEmailDepsForTests({ credential: 'synthetic-credential', fetchImpl: async (url) => {
      if (String(url).endsWith('/messages/send')) { sends += 1; throw new Error('synthetic timeout'); }
      return new Response(JSON.stringify({ access_token: 'synthetic-access', provider_account_id: 'orin@datatalks.club' }), { status: 200 });
    } });
    const res = await staffReq('POST', '/api/podcast-first-contact/send', input);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(JSON.parse(res.body).emailDelivery.state, 'deferred');
    const replay = await staffReq('POST', '/api/podcast-first-contact/send', input);
    assert.equal(replay.statusCode, 409, replay.body);
    assert.equal(sends, 1);
    setSponsorDocEmailDepsForTests({});
  });
});
