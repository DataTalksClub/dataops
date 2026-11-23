/**
 * Own-course newsletter slots and booking-derived sponsor emails.
 *
 * A slot booked for DataTalks.Club advertises one of our own courses: the
 * advertiser is the owner, nobody is invoiced and no sponsor mailbox is
 * emailed, so its Card leaves out the invoice and sponsor-email Tasks and its
 * sponsor document prepares no email and copies no reviewer. Every other
 * sponsor email goes to the slot's current booking contact, never to
 * whichever contact of the booked organization comes first; an unsent email
 * record left by an earlier booking can be cleared or rebuilt. All sponsors
 * and contacts here are synthetic; no test sends email.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { getClient } from '../src/db/client';
import { getCard } from '../src/db/cards';
import { createTemplate } from '../src/db/templates';
import { listTasksByCard } from '../src/db/tasks';
import { createCrmRecord } from '../src/db/sponsorCrm';
import { getNewsletterIssue, updateNewsletterIssue } from '../src/db/newsletterIssues';
import { getSponsorDoc, setSponsorDocEmailDelivery } from '../src/db/sponsorDocs';
import { setSponsorDocEmailDepsForTests } from '../src/sponsorDocs/emailDelivery';
import {
  NEWSLETTER_SPONSOR_EMAIL_TEMPLATE_ID,
  setKnowledgeEmailTemplateLoaderForTests,
} from '../src/sponsorDocs/knowledgeEmailTemplate';
import { withoutExcludedDefinitions } from '../src/templates/cardTemplateProjection';
import { OWN_COURSE_EXCLUSION_REASON } from '../src/newsletter/issueCard';
import type { TaskDefinition } from '../src/types';

const EMAIL_TEMPLATE_FIXTURE = [
  '---',
  `id: ${NEWSLETTER_SPONSOR_EMAIL_TEMPLATE_ID}`,
  'doc_type: template',
  '---',
  'Use the appropriate subject title for the type of Newsletter:',
  '',
  '1. Main Slot',
  '',
  '<COMPANY> + DataTalks.Club Newsletter - MM-DD-YYYY',
  '',
  '2. Secondary Slot',
  '',
  '<COMPANY> + DataTalks.Club Newsletter (Secondary Slot) - MM-DD-YYYY',
  '',
  '3. Stand-alone Newsletter',
  '',
  '<COMPANY> + DataTalks.Club Newsletter (Stand-alone) - MM-DD-YYYY',
  '',
  '### Template 2: Initial Introduction to Sponsor (Scheduled Newsletter Date)',
  '',
  '```text',
  'Hello <RECIPIENT_NAME>,',
  '',
  'Your <COMPANY_NAME> placement is on <NEWSLETTER_DATE>.',
  'Document: <COPY_DOCUMENT_URL>',
  'Code: <ACCESS_CODE>',
  'Submit by <COPY_DEADLINE>.',
  'Sender: <SENDER_NAME>.',
  '```',
].join('\n');

const SLOT_TASKS: Array<[string, string[]]> = [
  ['create-sponsorship-document', []],
  ['email-sponsor', ['create-sponsorship-document']],
  ['chase-sponsor-copy', ['email-sponsor']],
  ['coordinate-sponsor-copy', ['email-sponsor']],
  ['fill-sponsored-block', ['create-sponsorship-document']],
  ['create-invoice', ['create-sponsorship-document', 'schedule-email-newsletter']],
  ['send-email-sponsor-publication-live', ['schedule-email-newsletter']],
  ['schedule-sponsorship-linkedin', ['send-email-sponsor-publication-live']],
  ['send-performance-to-sponsor', ['schedule-email-newsletter']],
];
const EXCLUDED = ['chase-sponsor-copy', 'create-invoice', 'email-sponsor', 'send-email-sponsor-publication-live', 'send-performance-to-sponsor'];

const today = new Date().toISOString().slice(0, 10);
const addDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

describe('own-course newsletter slots and booking-derived sponsor emails', () => {
  let client: DynamoDBDocumentClient;
  let handler: typeof import('../src/handler').handler;
  let ownOrgId: string;
  let issueNumber = 700;
  let fetchCalls = 0;

  const invoke = (method: string, path: string, body?: unknown) =>
    handler({ httpMethod: method, path, headers: {}, queryStringParameters: {}, body: body === undefined ? null : JSON.stringify(body) }, {});
  const data = (response: { body: string }) => JSON.parse(response.body);

  /** A weekly issue due now (its Card is created at once), with the primary slot booked for `organizationId`. */
  async function bookedIssue(organizationId: string, days = 10) {
    const created = await invoke('POST', '/api/newsletter-issues', {
      kind: 'weekly', publicationDate: addDays(today, days), issueNumber: issueNumber++, slots: { primary: {}, secondary: {} },
    });
    assert.equal(created.statusCode, 201, created.body);
    const booked = await invoke('PUT', `/api/newsletter-issues/${data(created).id}/slots/primary`, {
      version: data(created).version, organizationId,
    });
    assert.equal(booked.statusCode, 200, booked.body);
    const issue = data(booked);
    assert.ok(issue.cardId, 'the issue is due, so it has a Card');
    return issue;
  }

  async function taskRefs(cardId: string) {
    const tasks = await listTasksByCard(client, cardId);
    return {
      open: tasks.filter((task) => task.status === 'todo' || task.status === 'waiting').map((task) => task.templateTaskRef).sort(),
      byRef: new Map(tasks.map((task) => [task.templateTaskRef, task])),
    };
  }

  before(async () => {
    setKnowledgeEmailTemplateLoaderForTests(async (templateId) => ({ id: templateId, revision: 'kb-fixture', markdown: EMAIL_TEMPLATE_FIXTURE }));
    client = await getClient(await startLocal());
    await createTables(client);
    process.env.IS_LOCAL = 'true';
    process.env.SKIP_AUTH = 'true';
    handler = (await import('../src/handler')).handler;
    setSponsorDocEmailDepsForTests({
      brokerUrl: 'https://dapier.example.test',
      credential: 'dp_test_token',
      fetchImpl: (async () => {
        fetchCalls += 1;
        throw new Error('No test may contact Gmail or Dapier');
      }) as typeof globalThis.fetch,
    });
    await createTemplate(client, {
      name: 'Newsletter',
      type: 'newsletter',
      cardTitle: '{date} · #{issue} · {sponsors}',
      cardLinkDefinitions: [{ name: 'Sponsorship document' }, { name: 'Secondary sponsorship document' }],
      taskDefinitions: [
        { refId: 'schedule-email-newsletter', description: 'Queue the issue', offsetDays: -1 },
        ...SLOT_TASKS.map(([refId, dependsOn], index) => ({
          refId, description: `Slot ${refId}`, offsetDays: -14 + index, optionalGroup: 'primary-slot',
          ...(dependsOn.length ? { dependsOn } : {}),
        })),
      ],
    });
    // The own organization is recognised by name in tests (and by its fixed id in production).
    ownOrgId = (await createCrmRecord(client, 'organization', { displayName: 'DataTalks.Club' } as any)).item.id;
  });
  after(async () => {
    setSponsorDocEmailDepsForTests({});
    setKnowledgeEmailTemplateLoaderForTests(null);
    await stopLocal();
  });

  it('drops excluded definitions and hands their prerequisites to the Tasks that depended on them', () => {
    const definitions: TaskDefinition[] = [
      { refId: 'a', description: 'a', offsetDays: 0 },
      { refId: 'b', description: 'b', offsetDays: 0, dependsOn: ['a'] },
      { refId: 'c', description: 'c', offsetDays: 0, dependsOn: ['b'] },
      { refId: 'd', description: 'd', offsetDays: 0, dependsOn: ['c', 'a'] },
      { refId: 'e', description: 'e', offsetDays: 0, dependsOn: ['b'] },
    ];
    const kept = withoutExcludedDefinitions(definitions, ['b', 'c']);
    assert.deepEqual(kept.map(({ refId, dependsOn }) => [refId, dependsOn]), [
      ['a', undefined],
      ['d', ['a']],
      ['e', ['a']],
    ]);
    assert.deepEqual(withoutExcludedDefinitions(definitions, []), definitions);
  });

  it('an own-course slot Card gets no invoice or sponsor-email Tasks; rebooking for a sponsor brings them back', async () => {
    const issue = await bookedIssue(ownOrgId);
    const card = (await getCard(client, issue.cardId))!;
    assert.deepEqual(card.excludedTemplateTasks, { refs: EXCLUDED, reason: OWN_COURSE_EXCLUSION_REASON });
    const { open, byRef } = await taskRefs(card.id);
    assert.deepEqual(open, ['coordinate-sponsor-copy', 'create-sponsorship-document', 'fill-sponsored-block', 'schedule-email-newsletter', 'schedule-sponsorship-linkedin']);
    for (const ref of EXCLUDED) assert.equal(byRef.has(ref), false, `${ref} is never created`);
    assert.deepEqual(byRef.get('coordinate-sponsor-copy')?.dependsOn, [byRef.get('create-sponsorship-document')?.id]);
    assert.deepEqual(byRef.get('schedule-sponsorship-linkedin')?.dependsOn, [byRef.get('schedule-email-newsletter')?.id]);

    const sponsor = (await createCrmRecord(client, 'organization', { displayName: 'Synthetic Sponsor Rebook' } as any)).item;
    const current = await getNewsletterIssue(client, issue.id);
    const rebooked = await invoke('PUT', `/api/newsletter-issues/${issue.id}/slots/primary`, { version: current!.version, organizationId: sponsor.id });
    assert.equal(rebooked.statusCode, 200, rebooked.body);
    assert.equal((await getCard(client, issue.cardId))!.excludedTemplateTasks, undefined);
    const after = await taskRefs(issue.cardId);
    for (const ref of EXCLUDED) assert.equal(after.byRef.get(ref)?.status, 'todo', `${ref} is back for a paying sponsor`);
  });

  it('sync-tasks skips the open invoice and sponsor-email Tasks of a Card booked for us before the rule existed', async () => {
    const sponsor = (await createCrmRecord(client, 'organization', { displayName: 'Synthetic Earlier Sponsor' } as any)).item;
    const issue = await bookedIssue(sponsor.id);
    assert.equal((await taskRefs(issue.cardId)).byRef.get('create-invoice')?.status, 'todo');
    // The slot is now ours, written without the Card sync (as on Cards made before this change).
    const stored = (await getNewsletterIssue(client, issue.id))!;
    await updateNewsletterIssue(client, stored, { slots: { ...stored.slots, primary: { sponsor: 'DataTalks.Club', organizationId: ownOrgId } } });

    const synced = await invoke('POST', `/api/newsletter-issues/${issue.id}/sync-tasks`, {});
    assert.equal(synced.statusCode, 200, synced.body);
    assert.equal(data(synced).cardSync, 'synced');
    assert.deepEqual(data(synced).excludedTemplateTasks.refs, EXCLUDED);
    const { open, byRef } = await taskRefs(issue.cardId);
    for (const ref of EXCLUDED) {
      assert.equal(byRef.get(ref)?.status, 'skipped', `${ref} is skipped`);
      assert.equal(byRef.get(ref)?.skipReason, OWN_COURSE_EXCLUSION_REASON);
      assert.equal(open.includes(ref), false);
    }
    const again = await invoke('POST', `/api/newsletter-issues/${issue.id}/sync-tasks`, {});
    assert.equal(data(again).cardSync, 'unchanged');
  });

  it('an own-course document prepares no email; its preview greets Alexey without a reviewer cc; a stale record is flagged and cleared', async () => {
    const issue = await bookedIssue(ownOrgId, 12);
    const created = await invoke('POST', '/api/sponsor-docs', { cardId: issue.cardId, template: 'newsletter-main' });
    assert.equal(created.statusCode, 201, created.body);
    const body = data(created);
    assert.equal(body.emailDelivery.state, 'skipped');
    assert.equal(body.emailDelivery.reason, 'own_course');
    assert.equal(body.doc.emailDelivery, undefined, 'no email record is stored');
    assert.equal((await getSponsorDoc(client, body.doc.id))?.emailDelivery, undefined);

    const draft = body.doc.emailDraft;
    assert.equal(draft.to, 'alexey@datatalks.club');
    assert.equal(draft.recipientName, 'Alexey');
    assert.deepEqual(draft.cc, []);
    assert.equal(draft.ownCourse, true);
    assert.match(draft.subject, /^Alexey Grigorev \+ DataTalks\.Club Newsletter - \d{2}-\d{2}-\d{4}$/);
    assert.match(draft.body, /^Hello Alexey,/);

    // The record a create under the earlier booking (a Maven-like org contact) left behind.
    await setSponsorDocEmailDelivery(client, body.doc.id, {
      state: 'deferred', from: 'orin@datatalks.club', to: 'contact@synthetic-platform.example', cc: ['valeriia@datatalks.club'],
      recipientName: 'Synthetic Contact', subject: 'Synthetic Platform + DataTalks.Club Newsletter - 01-01-2027',
      reason: 'task_required', message: 'A linked owning task is required before sending; the email was not sent.',
    });
    const stale = data(await invoke('GET', `/api/sponsor-docs/${body.doc.id}`)).doc;
    assert.equal(stale.emailRecordStale, true);
    assert.equal(stale.emailDraft.to, 'alexey@datatalks.club', 'the preview follows the current booking, not the stale record');
    assert.doesNotMatch(stale.emailDraft.body, /Synthetic Contact/);

    const cleared = await invoke('POST', `/api/sponsor-docs/${body.doc.id}/email-record`, { action: 'clear' });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal(data(cleared).previous.to, 'contact@synthetic-platform.example');
    assert.equal(data(cleared).emailDelivery, null);
    assert.equal(data(cleared).doc.emailDelivery, undefined);
    assert.equal(data(cleared).doc.emailRecordStale, undefined);
    assert.equal((await getSponsorDoc(client, body.doc.id))?.emailDelivery, undefined);
    assert.equal(fetchCalls, 0, 'nothing was sent');
  });

  it('never clears a sent record', async () => {
    const issue = await bookedIssue(ownOrgId, 13);
    const doc = data(await invoke('POST', '/api/sponsor-docs', { cardId: issue.cardId, template: 'newsletter-main' })).doc;
    await setSponsorDocEmailDelivery(client, doc.id, {
      state: 'sent', from: 'orin@datatalks.club', to: 'alexey@datatalks.club', subject: 'Sent', messageId: 'gmail-synthetic-1',
    });
    const refused = await invoke('POST', `/api/sponsor-docs/${doc.id}/email-record`, { action: 'clear' });
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(data(refused).code, 'email_already_sent');
    assert.equal((await getSponsorDoc(client, doc.id))?.emailDelivery?.state, 'sent');
  });

  it('addresses only the booking contact, never another contact of the booked organization; the reviewer cc is optional', async () => {
    const org = (await createCrmRecord(client, 'organization', { displayName: 'Synthetic Booked Platform' } as any)).item;
    await createCrmRecord(client, 'contact', { organizationId: org.id, name: 'Arbitrary Person', emails: ['arbitrary@synthetic-platform.example'] } as any);
    const issue = await bookedIssue(org.id, 14);

    const created = data(await invoke('POST', '/api/sponsor-docs', { cardId: issue.cardId, template: 'newsletter-main' }));
    assert.equal(created.emailDelivery.state, 'skipped');
    assert.equal(created.emailDelivery.reason, 'missing_recipient_email');
    assert.equal(created.emailDelivery.to, undefined, 'the organization contact is not picked');
    assert.equal(created.doc.emailDraft.to, null);
    assert.deepEqual(created.doc.emailDraft.cc, ['valeriia@datatalks.club']);
    assert.match(created.doc.emailDraft.body, /^Hello there,/);

    // The booked deal names its contact: rebuild re-derives the recipient from it, without sending.
    const contact = (await createCrmRecord(client, 'contact', { organizationId: org.id, name: 'Booking Contact', emails: ['booking@synthetic-platform.example'] } as any)).item;
    const { listCrmRecords, updateCrmRecord } = await import('../src/db/sponsorCrm');
    const deliverable = (await listCrmRecords(client, 'deliverable')).find((item) => item.newsletterIssueId === issue.id && !item.archivedAt)!;
    const deal = (await listCrmRecords(client, 'deal')).find((item) => item.id === deliverable.dealId)!;
    await updateCrmRecord(client, 'deal', deal, { primaryContactId: contact.id });

    const rebuilt = await invoke('POST', `/api/sponsor-docs/${created.doc.id}/email-record`, { action: 'rebuild' });
    assert.equal(rebuilt.statusCode, 200, rebuilt.body);
    const record = data(rebuilt).emailDelivery;
    assert.equal(record.state, 'deferred');
    assert.equal(record.reason, 'not_sent');
    assert.equal(record.to, 'booking@synthetic-platform.example');
    assert.equal(record.recipientName, 'Booking Contact');
    assert.deepEqual(record.cc, ['valeriia@datatalks.club']);
    assert.equal(record.sponsorName, 'Synthetic Booked Platform');
    assert.match(record.subject, /^Synthetic Booked Platform \+ DataTalks\.Club Newsletter/);

    const withoutCc = data(await invoke('POST', `/api/sponsor-docs/${created.doc.id}/email-record`, { action: 'rebuild', ccReviewer: false })).emailDelivery;
    assert.equal(withoutCc.cc, undefined);
    assert.equal(fetchCalls, 0, 'nothing was sent');
  });
});
