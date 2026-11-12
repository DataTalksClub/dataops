import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { TABLE_USERS } from '../src/db/tableNames';
import { renderGuestFirstContact } from '../src/events/guestFirstContact';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createUser } from '../src/db/users';
import { humanBearer } from './helpers/human-bearer';
import { createTask, getTaskConsistent } from '../src/db/tasks';
import { createCard } from '../src/db/cards';
import { createSponsorDoc } from '../src/db/sponsorDocs';
import { putCalendarHold } from '../src/db/calendarHolds';
import { buildHold } from '../src/calendar/holds';
import { templateLink } from './helpers/cardTemplate';
import { setSponsorDocEmailDepsForTests } from '../src/sponsorDocs/emailDelivery';
import {
  PODCAST_FIRST_CONTACT_FROM,
  formatSlotLabel,
} from '../src/podcast/firstContact';

const approvedTemplate = `Subject: <FIRST_NAME_SUBJECT_PREFIX>DataTalks.Club Podcast\n\n<GREETING>

I'm Orin, I help Alexey organize the DataTalks.Club podcast. We'd love to have you on the show<TOPIC_CLAUSE>.

Would <WEEKDAY_DATE> at <TIME_TIMEZONE> work for you? You can confirm this time or choose another available slot in the form below. If none of the times work, just reply to this email and we'll find an alternative.

The form also explains how our podcast works and asks for a short bio, photo, profile links, and any blog posts, talks, or other materials that could help us prepare.

Here's the link:
<GUEST_FORM_URL>

If prompted, enter this access code: <ACCESS_CODE>

Best regards,
Orin Vale`;

describe('podcast first-contact email (Orin ask)', () => {
  let client: DynamoDBDocumentClient;
  let handler: typeof import('../src/handler').handler;
  let staffUserId: string;
  let staffToken: string;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    await client.send(new PutCommand({ TableName: TABLE_USERS, Item: { PK: 'SETTINGS#text-templates', SK: 'SETTINGS#text-templates', version: 1, templates: [{ id: 'podcast.first-contact', title: 'Podcast first-contact', body: approvedTemplate, updatedAt: '2030-01-01T00:00:00Z' }] } }));
    process.env.IS_LOCAL = 'true';
    handler = (await import('../src/handler')).handler;
    const user = await createUser(client, {
      email: 'staff@datatalks.club',
      name: 'Orin Staff',
      passwordHash: 'unused',
      role: 'admin',
    });
    staffUserId = user.id;
    staffToken = await humanBearer(client, staffUserId);
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

  const renderInput = {
    startIso: '2030-11-04T16:00:00.000Z', guestFirstName: 'Synthetic', slotLabel: 'Monday 4 November 2030 at 17:00 CET',
    formUrl: 'https://ops.example.test/podcast-docs/synthetic?code=ABCD-EFGH',
    accessCode: 'ABCD-EFGH', topicSeed: 'Reliable data agents',
  };

  it('renders the exact approved first-contact subject and body', () => {
    const email = renderGuestFirstContact(approvedTemplate, { ...renderInput, type: 'podcast', templateId: 'podcast.first-contact', guestName: renderInput.guestFirstName, topic: renderInput.topicSeed });
    assert.equal(email.from, PODCAST_FIRST_CONTACT_FROM);
    assert.equal(email.subject, 'Synthetic at DataTalks.Club Podcast');
    assert.equal(email.body, `Hi Synthetic,

I'm Orin, I help Alexey organize the DataTalks.Club podcast. We'd love to have you on the show to discuss Reliable data agents.

Would Monday 4 November 2030 at 17:00 CET work for you? You can confirm this time or choose another available slot in the form below. If none of the times work, just reply to this email and we'll find an alternative.

The form also explains how our podcast works and asks for a short bio, photo, profile links, and any blog posts, talks, or other materials that could help us prepare.

Here's the link:
https://ops.example.test/podcast-docs/synthetic?code=ABCD-EFGH

If prompted, enter this access code: ABCD-EFGH

Best regards,
Orin Vale`);
    assert.ok(!/datatalksclub.github.io|Nice to meet you|Blog posts\n|do not invent/i.test(email.body));
  });

  it('supports email-only guests without inventing a name or topic', () => {
    const email = renderGuestFirstContact(approvedTemplate, { ...renderInput, type: 'podcast', templateId: 'podcast.first-contact' });
    assert.equal(email.subject, 'DataTalks.Club Podcast');
    assert.match(email.body, /^Hi,\n/);
    assert.ok(!email.body.includes('to discuss'));
    assert.throws(() => renderGuestFirstContact(approvedTemplate, { ...renderInput, type: 'podcast', templateId: 'podcast.first-contact', accessCode: '' }), /access code/);
  });

  it('formats the single saved slot with weekday, year and timezone', () => {
    assert.equal(formatSlotLabel('2030-11-04T16:00:00.000Z'), renderInput.slotLabel);
    assert.throws(() => formatSlotLabel('not-a-date'), /valid ISO/);
  });

  it('renders through the API without sending or creating records', async () => {
    const res = await staffReq('POST', '/api/podcast-first-contact/email', renderInput);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(JSON.parse(res.body).body, renderGuestFirstContact(approvedTemplate, { ...renderInput, type: 'podcast', templateId: 'podcast.first-contact', guestName: renderInput.guestFirstName, topic: renderInput.topicSeed }).body);
    const missing = await staffReq('POST', '/api/podcast-first-contact/email', { ...renderInput, accessCode: '' });
    assert.equal(missing.statusCode, 400, missing.body);
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
    assert.equal(output.connectionId, 'google-calendar-orin');
    assert.match(output.email.body, /Monday 4 November 2030 at 17:00 CET/);
    assert.match(output.email.body, /Reliable data agents/);
    assert.match(output.email.formUrl, new RegExp(`/podcast-docs/${input.docId}\\?code=`));
    assert.ok(output.email.body.includes(`If prompted, enter this access code: ${output.email.accessCode}`));
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
    const unsafeRetry = await staffReq('POST', '/api/podcast-first-contact/send', { ...input, retryPreSend: true });
    assert.equal(unsafeRetry.statusCode, 409, unsafeRetry.body);
    assert.equal(sends, 1);
    setSponsorDocEmailDepsForTests({});
  });

  it('recovers the same Task only after explicit pre-Gmail broker404 retry and preserves the failed attempt', async () => {
    const input = await invitation();
    let brokerFails = true;
    let sends = 0;
    const connections: string[] = [];
    setSponsorDocEmailDepsForTests({ credential: 'synthetic-credential', fetchImpl: async (url, init) => {
      if (String(url).endsWith('/messages/send')) {
        sends += 1;
        return new Response(JSON.stringify({ id: 'recovered-message', threadId: 'recovered-thread' }), { status: 200 });
      }
      connections.push(JSON.parse(String(init?.body)).connection_id);
      if (brokerFails) return new Response(JSON.stringify({ detail: 'Synthetic connection missing' }), { status: 404 });
      return new Response(JSON.stringify({ access_token: 'synthetic-access', provider_account_id: 'orin@datatalks.club' }), { status: 200 });
    } });
    const failed = await staffReq('POST', '/api/podcast-first-contact/send', input);
    assert.equal(failed.statusCode, 200, failed.body);
    assert.equal(JSON.parse(failed.body).emailDelivery.reason, 'dapier_token_http_404');
    assert.equal(sends, 0);
    const noFlag = await staffReq('POST', '/api/podcast-first-contact/send', input);
    assert.equal(noFlag.statusCode, 409);
    const preview = await staffReq('POST', '/api/podcast-first-contact/send', { ...input, preview: true });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(JSON.parse(preview.body).retryEligible, true);
    assert.equal(sends, 0);
    brokerFails = false;
    const recovered = await staffReq('POST', '/api/podcast-first-contact/send', { ...input, retryPreSend: true });
    assert.equal(recovered.statusCode, 200, recovered.body);
    assert.equal(JSON.parse(recovered.body).emailDelivery.messageId, 'recovered-message');
    const task = (await getTaskConsistent(client, input.taskId))!;
    assert.equal(task.podcastFirstContact!.attempts!.length, 1);
    assert.equal(task.podcastFirstContact!.attempts![0].delivery.reason, 'dapier_token_http_404');
    assert.ok(task.notesLog!.some(note => note.text.includes('dapier_token_http_404')));
    assert.ok(task.notesLog!.some(note => note.text.includes('recovered-message')));
    assert.deepEqual(connections, ['google-calendar-orin', 'google-calendar-orin']);
    const replay = await staffReq('POST', '/api/podcast-first-contact/send', { ...input, retryPreSend: true });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(JSON.parse(replay.body).alreadySent, true);
    assert.equal(sends, 1);
    setSponsorDocEmailDepsForTests({});
  });
});
