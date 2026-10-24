import { createUserWithId } from '../src/db/users';
import { setDefaultAssignee } from '../src/db/workspaceSettings';
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { handler } from '../src/handler';
import { appendBookingHistory } from '../src/db/sponsorCrm';
import { queryTargetMessages } from '../src/crmWorkspace/reads';
import { createTables } from '../scripts/local-dynamodb';
import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';

const GRACE_USER_ID = '00000000-0000-0000-0000-000000000001';

const invoke = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const url = new URL(path, 'http://crm-workspace.test');
  return handler({
    httpMethod: method,
    path: url.pathname,
    headers,
    queryStringParameters: Object.fromEntries(url.searchParams),
    body: body === undefined ? null : JSON.stringify(body),
  }, {});
};
const data = (response: any) => JSON.parse(response.body);

describe('crm workspace activity', () => {
  let client: DynamoDBDocumentClient;
  let seedCount = 0;
  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    await createUserWithId(client, GRACE_USER_ID, { name: 'Workspace Fixture', email: 'workspace@example.test', role: 'admin' });
    await setDefaultAssignee(client, { defaultAssigneeId: GRACE_USER_ID, expectedVersion: 0 });
    void client;
  });
  after(stopLocal);

  async function seed(suffix: string) {
    const org = data(await invoke('POST', '/api/sponsor-crm/organizations', {
      displayName: `Activity Org ${suffix}`, domain: `activity-${suffix}.example`, sourceKey: `ws-act-org-${suffix}`,
    }));
    const contact = data(await invoke('POST', '/api/sponsor-crm/contacts', {
      organizationId: org.id, name: 'Amy Activity', emails: [`amy-${suffix}@activity-${suffix}.example`],
      sourceKey: `ws-act-contact-${suffix}`,
    }));
    const deal = data(await invoke('POST', '/api/sponsor-crm/deals', {
      organizationId: org.id, primaryContactId: contact.id, status: 'open', sourceKey: `ws-act-deal-${suffix}`,
    }));
    // Provably linked person mail.
    await invoke('POST', '/api/sponsor-crm/messages', {
      personEmail: `amy-${suffix}@activity-${suffix}.example`, direction: 'inbound',
      threadId: `thread-amy-${suffix}`, snippet: `Amy confirms the slot ${suffix}`, sentAt: '2026-10-05T10:00:00Z',
    });
    // Company mail with no contact link: org timeline only, never the person's.
    await invoke('POST', '/api/sponsor-crm/messages', {
      personEmail: `boss-${suffix}@activity-${suffix}.example`, direction: 'inbound',
      threadId: `thread-boss-${suffix}`, snippet: `Front desk auto-reply ${suffix}`, sentAt: '2026-10-06T10:00:00Z',
    });
    // A touch for the contact files one touch message plus history rows.
    await invoke('POST', '/api/sponsor-crm/touches', {
      targetType: 'contact', targetId: contact.id, channel: 'call', note: 'Intro call', touchedAt: '2026-10-07T10:00:00Z',
    });
    await invoke('POST', `/api/sponsor-crm/notes/contact/${contact.id}`, { body: 'Prefers morning calls.' });
    await invoke('POST', `/api/sponsor-crm/notes/organization/${org.id}`, { body: 'Warm intro via partner.' });
    const fresh = data(await invoke('GET', `/api/sponsor-crm/deals/${deal.id}`));
    await invoke('PUT', `/api/sponsor-crm/deals/${deal.id}`, { status: 'agreed', version: fresh.version, historyNote: 'Terms accepted' });
    const task = data(await invoke('POST', '/api/tasks', {
      description: 'Send the agreement', date: '2026-10-20', subject: { type: 'sponsor-company', id: org.id },
    }));
    const other = data(await invoke('POST', '/api/tasks', { description: 'Unrelated work', date: '2026-10-21' }));
    return { org, contact, deal, task, other };
  }

  it('merges immutable events chronologically with sources, related work and reads disclosure', async () => {
    const { org, contact, deal, task, other } = await seed(String(seedCount++));
    const res = await invoke('GET', `/api/sponsor-crm/activity/organization/${org.id}`);
    assert.equal(res.statusCode, 200);
    const body = data(res);
    assert.equal(body.targetType, 'organization');
    assert.equal(body.tasksScope, 'open');
    for (const source of ['note', 'mail', 'history']) {
      assert.ok(body.sources[source] >= 1, `expected ${source} events`);
    }
    assert.ok(body.sources.touch >= 1);
    assert.ok(body.sources['deal-history'] >= 1);
    // Chronological, newest first, with stable keys.
    const stamps = body.items.map((item: any) => item.ts);
    assert.deepEqual(stamps, [...stamps].sort().reverse());
    for (const item of body.items) {
      assert.ok(item.ts && item.source && item.id && 'actor' in item && item.text && item.provenance);
      assert.ok(!['todo', 'waiting', 'done'].includes(item.source), 'tasks are not timeline events');
    }
    // The touch message appears once; its companion history rows are deduped.
    assert.equal(body.items.filter((item: any) => item.source === 'touch').length, 1);
    // Deal status change surfaces with deal provenance.
    const change = body.items.find((item: any) => item.source === 'deal-history');
    assert.equal(change.provenance.dealId, deal.id);
    assert.ok(String(change.text).includes('open') && String(change.text).includes('agreed'));
    // Open work is labeled related-work, never an event; unrelated tasks excluded.
    assert.ok(body.relatedWork.some((work: any) => work.taskId === task.id && work.scope === 'direct'));
    assert.ok(!body.relatedWork.some((work: any) => work.taskId === other.id));
    assert.ok(body.relatedWork.every((work: any) => work.subjectHref.startsWith('/sponsors/')));
    assert.ok(body.relatedWork.every((work: any) => typeof work.taskId === 'string' && work.taskId));
    assert.equal(body.total, body.items.length);
    assert.ok(body.reads.queries.some((scan: any) => scan.kind === 'message'));
    assert.ok(body.reads.queries.some((scan: any) => scan.kind === 'note'));
    assert.ok(body.reads.historyReads.length >= 1);
    assert.ok(body.reads.snapshot.includes('ORGANIZATION#'));
    void contact;
  });

  it('prefilters messages per target and counts scanned vs matched truthfully', async () => {
    const firstSuffix = String(seedCount++);
    const secondSuffix = String(seedCount++);
    const first = await seed(firstSuffix);
    const second = await seed(secondSuffix);
    const body = data(await invoke('GET', `/api/sponsor-crm/activity/organization/${first.org.id}`));
    const texts = body.items.map((item: any) => item.text);
    // Second org's mail never leaks into the first org's feed.
    assert.ok(!texts.some((text: string) => text.includes(secondSuffix)), 'second org mail never leaks into the first feed');
    const messageQuery = body.reads.queries.find((scan: any) => scan.kind === 'message');
    assert.ok(messageQuery);
    assert.ok(messageQuery.scanned >= messageQuery.matched, 'scanned counts rows evaluated, matched rows kept');
    assert.equal(messageQuery.matched, body.sources.touch + body.sources.mail);
    assert.equal(messageQuery.scanned, messageQuery.matched, 'keyed query reads only target messages without whole-table scan');
    void second;
  });

  it('serves default activity for phone-only people with no emails', async () => {
    const suffix = String(seedCount++);
    const org = data(await invoke('POST', '/api/sponsor-crm/organizations', {
      displayName: `Quiet Org ${suffix}`, domain: `quiet-${suffix}.example`, sourceKey: `ws-quiet-org-${suffix}`,
    }));
    // Valid contact without emails (validateContact only checks emails when supplied).
    const contact = data(await invoke('POST', '/api/sponsor-crm/contacts', {
      organizationId: org.id, name: 'Pat Phone', phone: '+100000000', sourceKey: `ws-quiet-contact-${suffix}`,
    }));
    const res = await invoke('GET', `/api/sponsor-crm/activity/contact/${contact.id}`);
    assert.equal(res.statusCode, 200);
    const body = data(res);
    assert.ok(body.sources.history >= 1);
    assert.equal(body.sources.mail, 0);
    assert.equal(body.sources.touch, 0);
    const messageQuery = body.reads.queries.find((scan: any) => scan.kind === 'message');
    assert.ok(messageQuery);
  });

  it('scopes person mail to provably linked messages and labels org work related-company', async () => {
    const { org, contact, task } = await seed(String(seedCount++));
    const body = data(await invoke('GET', `/api/sponsor-crm/activity/contact/${contact.id}`));
    const texts = body.items.map((item: any) => item.text);
    assert.ok(texts.some((text: string) => text.includes('Amy confirms the slot')));
    assert.ok(!texts.some((text: string) => text.includes('Front desk auto-reply')), 'company mail must not pose as person mail');
    assert.ok(body.items.some((item: any) => item.source === 'touch'));
    assert.ok(body.items.some((item: any) => item.source === 'note' && item.text === 'Prefers morning calls.'));
    const work = body.relatedWork.find((item: any) => item.taskId === task.id);
    assert.ok(work);
    assert.equal(work.scope, 'related-company');
    // Deal mail is not person mail either.
    const dealBody = data(await invoke('GET', `/api/sponsor-crm/activity/contact/${contact.id}?types=mail`));
    assert.ok(dealBody.items.every((item: any) => item.provenance.link === 'direct'));
    void org;
  });

  it('paginates smoothly past the previous history bound without erroring', async () => {
    const { deal } = await seed(String(seedCount++));
    for (let index = 0; index < 501; index++) {
      await appendBookingHistory(client, deal.id, { actorId: 'workspace-seeder', action: 'updated', note: `bulk ${index}` });
    }
    const res = await invoke('GET', `/api/sponsor-crm/activity/deal/${deal.id}?limit=30`);
    assert.equal(res.statusCode, 200);
    const body = data(res);
    assert.equal(body.items.length, 30);
    assert.ok(body.nextCursor);
    const page2 = data(await invoke('GET', `/api/sponsor-crm/activity/deal/${deal.id}?limit=30&cursor=${encodeURIComponent(body.nextCursor)}`));
    assert.equal(page2.items.length, 30);
    assert.notEqual(page2.items[0].id, body.items[0].id);
  });

  it('queries messages via keyed target query and paginates without whole-table scans', async () => {
    const { org } = await seed(String(seedCount++));
    const full = await queryTargetMessages(client, { targetType: 'organization', targetId: org.id }, 'messages');
    assert.ok(full.matched >= 1);
    assert.equal(full.scanned, full.matched);
    const paged = await queryTargetMessages(client, { targetType: 'organization', targetId: org.id }, 'messages', 1);
    assert.equal(paged.items.length, 1);
    assert.ok(paged.hasMore);
  });

  it('paginates message sources smoothly with limit and cursor', async () => {
    const { org } = await seed(String(seedCount++));
    for (let index = 0; index < 15; index++) {
      await invoke('POST', '/api/sponsor-crm/messages', {
        personEmail: `bulk-${index}@${org.domain}`,
        direction: 'inbound',
        threadId: `thread-bulk-${index}`,
        snippet: `Bulk message ${index}`,
        sentAt: `2026-10-01T${String(index % 24).padStart(2, '0')}:00:00Z`,
      });
    }
    const res = await invoke('GET', `/api/sponsor-crm/activity/organization/${org.id}?types=mail&limit=5`);
    assert.equal(res.statusCode, 200);
    const body = data(res);
    assert.equal(body.items.length, 5);
    assert.ok(body.nextCursor);
    const page2 = data(await invoke('GET', `/api/sponsor-crm/activity/organization/${org.id}?types=mail&limit=5&cursor=${encodeURIComponent(body.nextCursor)}`));
    assert.equal(page2.items.length, 5);
    assert.notEqual(page2.items[0].id, body.items[0].id);
  });

  it('orders related work by eligibility, never manufacturing urgency', async () => {
    const suffix = String(seedCount++);
    const org = data(await invoke('POST', '/api/sponsor-crm/organizations', {
      displayName: `Eligible Org ${suffix}`, domain: `eligible-${suffix}.example`, sourceKey: `ws-elig-org-${suffix}`,
    }));
    // Past original date, still open: genuinely overdue and eligible first.
    const overdue = data(await invoke('POST', '/api/tasks', {
      description: 'Overdue eligible', date: '2026-01-05',
      subject: { type: 'sponsor-company', id: org.id },
    }));
    // Future waiting follow-up: open but deferred, honestly labeled, never first.
    const snoozed = data(await invoke('POST', '/api/tasks', {
      description: 'Future follow-up', date: '2026-01-06', status: 'waiting',
      waitingFor: 'partner reply', followUpAt: '2099-01-01T00:00:00Z', comment: 'Waiting on partner.',
      subject: { type: 'sponsor-company', id: org.id },
    }));
    assert.ok(snoozed.id);
    const body = data(await invoke('GET', `/api/sponsor-crm/activity/organization/${org.id}?today=2026-10-17`));
    assert.equal(body.relatedWork[0].taskId, overdue.id);
    assert.equal(body.relatedWork[0].eligible, true);
    assert.equal(body.relatedWork[0].deferred, false);
    assert.equal(body.relatedWork[0].effectiveDate, '2026-01-05');
    const waiting = body.relatedWork.find((work: any) => work.taskId === snoozed.id);
    assert.ok(waiting);
    assert.equal(waiting.eligible, false);
    assert.equal(waiting.deferred, true);
    assert.equal(waiting.effectiveDate, '2099-01-01');
    assert.equal(waiting.deferredUntil, '2099-01-01T00:00:00Z');
    assert.equal(waiting.followUpAt, '2099-01-01T00:00:00Z');
    assert.ok(waiting.subjectHref === `/sponsors/companies/${org.id}`);
    assert.ok(!('href' in waiting), 'no looping record href under a task name');
    assert.ok(body.relatedWork.every((work: any) => typeof work.taskId === 'string'));
  });

  it('filters types, binds cursors and stays available for archived records', async () => {
    const { org, deal } = await seed(String(seedCount++));
    const notesOnly = data(await invoke('GET', `/api/sponsor-crm/activity/organization/${org.id}?types=note`));
    assert.ok(notesOnly.items.length >= 1);
    assert.ok(notesOnly.items.every((item: any) => item.source === 'note'));
    assert.equal((await invoke('GET', `/api/sponsor-crm/activity/organization/${org.id}?types=note,sms`)).statusCode, 400);

    const first = data(await invoke('GET', `/api/sponsor-crm/activity/organization/${org.id}?limit=1`));
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor);
    const next = data(await invoke('GET', `/api/sponsor-crm/activity/organization/${org.id}?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`));
    assert.ok(next.items[0].id !== first.items[0].id || next.items[0].source !== first.items[0].source);
    const reused = await invoke('GET', `/api/sponsor-crm/activity/organization/${org.id}?limit=1&types=note&cursor=${encodeURIComponent(first.nextCursor)}`);
    assert.equal(reused.statusCode, 400);

    const dealBody = data(await invoke('GET', `/api/sponsor-crm/activity/deal/${deal.id}`));
    assert.ok(dealBody.sources.history >= 2, 'deal create + status change history');
    assert.ok(dealBody.relatedWork.length === 0);

    await invoke('DELETE', `/api/sponsor-crm/organizations/${org.id}`);
    const archived = await invoke('GET', `/api/sponsor-crm/activity/organization/${org.id}`);
    assert.equal(archived.statusCode, 200, 'archived records keep their activity');
    assert.equal((await invoke('GET', '/api/sponsor-crm/activity/organization/does-not-exist-9')).statusCode, 404);
  });
});
