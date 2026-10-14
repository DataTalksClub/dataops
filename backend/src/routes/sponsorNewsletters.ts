import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaEvent, LambdaResponse } from '../types';
import {
  createCrmRecord,
  getCrmRecord,
  listCrmRecords,
  updateCrmRecord,
  type CrmRecord,
} from '../db/sponsorCrm';
import { realDate } from '../sponsorCrm/model';
import {
  NEWSLETTER_HEALTH,
  issueBelongsTo,
  issueSponsors,
  newsletterIssueRecord,
  newsletterIssueStats,
  newsletterPatch,
  newsletterRecord,
  publicNewsletter,
  sortNewsletters,
  validateNewsletter,
  validateNewsletterIssue,
} from '../sponsorCrm/newsletters';
import { NEWSLETTER_ISSUE_KIND, upsertNewsletterIssue } from '../sponsorCrm/newsletterIssues';
import { leadValue, parseSponsors, storeLead } from './sponsorLeads';

const json = (statusCode: number, body: unknown): LambdaResponse => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const parse = (event: LambdaEvent) => { try { return event.body ? JSON.parse(String(event.body)) as Record<string, unknown> : null; } catch { return null; } };
const todayOf = (event: LambdaEvent) => {
  const query = event.queryStringParameters || {};
  return realDate(query.today) ? String(query.today) : new Date().toISOString().slice(0, 10);
};

function validateList(event: LambdaEvent) {
  const query = event.queryStringParameters || {}, limit = Number(query.limit || 50), cursor = Number(query.cursor || 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(cursor) || cursor < 0) return 'Invalid pagination';
  if (query.health && !NEWSLETTER_HEALTH.includes(query.health as (typeof NEWSLETTER_HEALTH)[number])) return 'Invalid health filter';
  if (query.subscriptionStatus && !['subscribed', 'pending', 'paused', 'unsubscribed'].includes(query.subscriptionStatus)) {
    return 'Invalid subscriptionStatus filter';
  }
  return '';
}

const page = (items: unknown[], event: LambdaEvent) => {
  const query = event.queryStringParameters || {}, limit = Number(query.limit || 50), cursor = Number(query.cursor || 0);
  return { items: items.slice(cursor, cursor + limit), nextCursor: cursor + limit < items.length ? String(cursor + limit) : null };
};

function issuesOf(newsletter: CrmRecord, newsletters: CrmRecord[], issues: CrmRecord[]) {
  return issues.filter((issue) => issueBelongsTo(issue, newsletter, newsletters));
}

/** Every newsletter with its issue stats; three table reads, made together. */
async function decoratedNewsletters(client: DynamoDBDocumentClient, today: string) {
  const [newsletters, issues, leads] = await Promise.all([
    listCrmRecords(client, 'newsletter'),
    listCrmRecords(client, NEWSLETTER_ISSUE_KIND),
    listCrmRecords(client, 'lead'),
  ]);
  return sortNewsletters(newsletters, today).map((newsletter): Record<string, unknown> => ({
    ...publicNewsletter(newsletter, today),
    issues: newsletterIssueStats(issuesOf(newsletter as CrmRecord, newsletters, issues), leads),
  }));
}

async function handleIssues(client: DynamoDBDocumentClient, method: string, newsletter: CrmRecord, body: Record<string, unknown> | null) {
  if (method === 'GET') {
    const [newsletters, issues, leads] = await Promise.all([
      listCrmRecords(client, 'newsletter'),
      listCrmRecords(client, NEWSLETTER_ISSUE_KIND),
      listCrmRecords(client, 'lead'),
    ]);
    const items = issuesOf(newsletter, newsletters, issues)
      .sort((left, right) => String(right.publishedAt).localeCompare(String(left.publishedAt)))
      .map((issue) => ({
        id: issue.id,
        issueKey: issue.issueKey,
        title: issue.title,
        publishedAt: issue.publishedAt,
        url: issue.url,
        source: issue.source,
        sponsors: issueSponsors(issue, leads),
      }));
    return json(200, { items });
  }
  if (method !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!body) return json(400, { error: 'Invalid JSON' });
  const unknown = Object.keys(body).find((name) => !['issueKey', 'title', 'publishedAt', 'url', 'source', 'sender', 'sponsors'].includes(name));
  if (unknown) return json(400, { error: `Unknown field: ${unknown}` });
  const error = validateNewsletterIssue(body);
  if (error) return json(400, { error });
  let sponsors: ReturnType<typeof parseSponsors> = [];
  if (body.sponsors !== undefined) {
    if (!Array.isArray(body.sponsors)) return json(400, { error: 'Invalid sponsors' });
    try { sponsors = parseSponsors(body.sponsors); }
    catch (failure) { return json(400, { error: (failure as Error).message }); }
  }
  const record = newsletterIssueRecord(newsletter, body);
  const stored = await upsertNewsletterIssue(client, record);
  const sender = String(record.sender || (Array.isArray(newsletter.senders) ? newsletter.senders[0] || '' : ''));
  const publishedAt = new Date(String(record.publishedAt)).toISOString();
  const leads: Array<{ id: string; outcome: string }> = [];
  for (const sponsor of sponsors) {
    try {
      leads.push(await storeLead(client, leadValue(String(record.issueKey), {
        name: String(newsletter.name),
        sender,
        subject: String(record.title),
        receivedAt: publishedAt,
      }, sponsor, record.source === 'inbox' ? 'newsletter-issue' : 'newsletter-archive')));
    } catch (failure) {
      if ((failure as { statusCode?: number }).statusCode !== 409) throw failure;
      leads.push({ id: '', outcome: 'conflict' });
    }
  }
  return json(stored.outcome === 'created' ? 201 : 200, { issue: stored.item, outcome: stored.outcome, leads });
}

export async function handleSponsorNewsletterRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse> {
  const body = method === 'GET' ? null : parse(event);
  const today = todayOf(event);

  const issuesMatch = path.match(/^\/api\/sponsor-crm\/newsletters\/([^/]+)\/issues$/);
  if (issuesMatch) {
    if (!ID.test(issuesMatch[1])) return json(400, { error: 'Invalid ID' });
    const newsletter = await getCrmRecord(client, 'newsletter', issuesMatch[1]);
    if (!newsletter) return json(404, { error: 'Not found' });
    return handleIssues(client, method, newsletter, body);
  }

  const match = path.match(/^\/api\/sponsor-crm\/newsletters(?:\/([^/]+))?$/);
  if (!match) return json(404, { error: 'Not found' });
  const id = match[1];
  if (id && !ID.test(id)) return json(400, { error: 'Invalid ID' });
  if (method === 'GET' && id) {
    const record = (await decoratedNewsletters(client, today)).find((item) => item.id === id);
    return record ? json(200, record) : json(404, { error: 'Not found' });
  }
  if (method === 'GET') {
    const listError = validateList(event);
    if (listError) return json(400, { error: listError });
    const query = event.queryStringParameters || {};
    let items = await decoratedNewsletters(client, today);
    if (query.health) items = items.filter((item) => item.health === query.health);
    if (query.subscriptionStatus) items = items.filter((item) => item.subscriptionStatus === query.subscriptionStatus);
    if (query.search) {
      const q = query.search.toLowerCase();
      items = items.filter((item) => [item.name, item.slug, ...(Array.isArray(item.senders) ? item.senders : [])]
        .some((value) => String(value || '').toLowerCase().includes(q)));
    }
    return json(200, page(items, event));
  }
  if (method === 'POST' && !id) {
    if (!body) return json(400, { error: 'Invalid JSON' });
    const error = validateNewsletter(body);
    if (error) return json(400, { error });
    try {
      const created = await createCrmRecord(client, 'newsletter', newsletterRecord(body));
      return json(created.duplicate ? 200 : 201, publicNewsletter(created.item, today));
    } catch (error) {
      return json((error as { statusCode?: number }).statusCode || 409, { error: (error as Error).message });
    }
  }
  if ((method === 'PUT' || method === 'PATCH') && id) {
    if (!body) return json(400, { error: 'Invalid JSON' });
    const existing = await getCrmRecord(client, 'newsletter', id);
    if (!existing) return json(404, { error: 'Not found' });
    if (body.version !== existing.version) return json(409, { error: 'Record was changed; reload and retry' });
    const error = validateNewsletter(body, true);
    if (error) return json(400, { error });
    try {
      return json(200, publicNewsletter(await updateCrmRecord(client, 'newsletter', existing, newsletterPatch(existing, body)), today));
    } catch {
      return json(409, { error: 'Conflicting update; reload and retry' });
    }
  }
  return json(405, { error: 'Method not allowed' });
}
