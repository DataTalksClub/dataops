/**
 * Newsletter issues: one row per email the newsletter sends.
 *
 * A weekly issue has a date, an issue number and two sponsor slots (primary
 * and secondary); a stand-alone issue has a date and one slot. A slot is
 * booked when it names its sponsor and open otherwise; booking it through the
 * Newsletter tab also records a deliverable on the sponsor's deal, which
 * points back at the issue (`newsletterIssueId`). An issue links at most one
 * Card (`cardId`), the Card that executes it.
 *
 * The rows live in the newsletter table (named `newsletter-slots` in
 * infrastructure, from before slots became part of an issue).
 */
import { createHash } from 'crypto';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLE_NEWSLETTER_SLOTS } from './tableNames';
import { collectBoundedPages, type StoragePaginationLimits } from './boundedPagination';
import { deleteAtVersion, putAtVersion, type PlannedWrite } from './plannedWrite';

export type NewsletterIssueKind = 'weekly' | 'standalone';
export type NewsletterSlotPosition = 'primary' | 'secondary';

export interface NewsletterIssueStats {
  deliveries?: number;
  opens?: number;
  clicks?: number;
  uniqueClicks?: number;
  openRate?: number;
  clickRate?: number;
  recordedAt: string;
}

export interface NewsletterSlotStats {
  clicks?: number;
  uniqueClicks?: number;
  clickRate?: number;
  linkedinImpressions?: number;
  linkedinClicks?: number;
  linkedinCtr?: number;
  linkedinPostUrl?: string;
  xImpressions?: number;
  xClicks?: number;
  xCtr?: number;
  xPostUrl?: string;
  recordedAt: string;
}

export interface NewsletterSlot {
  /** The booked sponsor; an open slot has none. Booking adds the slot's Tasks to the Card. */
  sponsor?: string;
  /** The sponsor's company in the Sponsors tab, when known. */
  organizationId?: string;
  bookedByUserId?: string;
  /** Row ID in the schedule sheet, e.g. `NL-297-secondary`. */
  sheetId?: string;
  /** The sponsor's placement document. */
  documentUrl?: string;
  /** Performance metrics for this slot's placement and sponsored social posts. */
  stats?: NewsletterSlotStats;
}

/** A link the issue keeps before (or without) a Card: a draft, a doc, a campaign. */
export interface NewsletterIssueLink {
  name: string;
  url: string;
}

export type NewsletterIssue = {
  id: string;
  kind: NewsletterIssueKind;
  publicationDate: string;
  publicationTime?: string;
  utcOffset?: string;
  issueNumber?: number;
  status: string;
  slots: Partial<Record<NewsletterSlotPosition, NewsletterSlot>>;
  stats?: NewsletterIssueStats;
  cardId?: string;
  links?: NewsletterIssueLink[];
  publicUrl?: string;
  planningNote?: string;
  sourceType?: string;
  sourceKey?: string;
  timeZone: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

const RANGE = 'ISSUES';

export const issueKey = (id: string) => ({ PK: `ISSUE#${id}`, SK: `ISSUE#${id}` });

const clean = (item: Record<string, unknown> | undefined): NewsletterIssue | null => {
  if (!item) return null;
  const { PK, SK, rangeKey, publicationKey, ...value } = item;
  return value as unknown as NewsletterIssue;
};

/** Stored row: the issue plus its date-index attributes. */
const stored = (issue: NewsletterIssue) => ({
  rangeKey: RANGE,
  publicationKey: `${issue.publicationDate}#${issue.id}`,
  ...issue,
});

/** The table item for `issue`, keys included. */
export const issueItem = (issue: NewsletterIssue) => ({ ...issueKey(issue.id), ...stored(issue) });

/** A source-keyed issue (an import) always gets the same id. */
export const newsletterIssueId = (sourceKey: string) =>
  createHash('sha256').update(`newsletter:${sourceKey}`).digest('hex');

export async function getNewsletterIssue(client: DynamoDBDocumentClient, id: string) {
  return clean(
    (await client.send(new GetCommand({ TableName: TABLE_NEWSLETTER_SLOTS, Key: issueKey(id) }))).Item,
  );
}

export async function listNewsletterIssues(
  client: DynamoDBDocumentClient,
  from: string,
  to: string,
  limits?: StoragePaginationLimits,
) {
  const items = await collectBoundedPages<Record<string, unknown>>({
    limits,
    loadPage: async (ExclusiveStartKey, abortSignal) => client.send(
      new QueryCommand({
        TableName: TABLE_NEWSLETTER_SLOTS,
        IndexName: 'GSI-Date',
        KeyConditionExpression: 'rangeKey=:range AND publicationKey BETWEEN :from AND :to',
        ExpressionAttributeValues: { ':range': RANGE, ':from': from, ':to': `${to}~` },
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      }),
      { abortSignal },
    ),
  });
  return (items.map(clean).filter(Boolean) as NewsletterIssue[]).sort(
    (left, right) => left.publicationDate.localeCompare(right.publicationDate) || left.id.localeCompare(right.id),
  );
}

/**
 * Issues linked to one Card. `issue.cardId` is the single canonical link, so
 * the reverse lookup scans; the table holds a few hundred issues at most.
 */
export async function listNewsletterIssuesByCardId(client: DynamoDBDocumentClient, cardId: string) {
  const items: Record<string, unknown>[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new ScanCommand({
        TableName: TABLE_NEWSLETTER_SLOTS,
        FilterExpression: 'begins_with(PK,:prefix) AND cardId=:cardId',
        ExpressionAttributeValues: { ':prefix': 'ISSUE#', ':cardId': cardId },
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      }),
    );
    items.push(...((page.Items || []) as Record<string, unknown>[]));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return (items.map(clean).filter(Boolean) as NewsletterIssue[]).sort(
    (left, right) => left.publicationDate.localeCompare(right.publicationDate),
  );
}

/** A new issue row, built but not written. */
export function buildNewsletterIssue(value: Omit<NewsletterIssue, 'id' | 'version' | 'createdAt' | 'updatedAt' | 'timeZone'>, id: string): NewsletterIssue {
  const now = new Date().toISOString();
  return { ...value, id, timeZone: 'Europe/Berlin', version: 1, createdAt: now, updatedAt: now };
}

/** The next version of an issue, built but not written. */
export function nextNewsletterIssue(existing: NewsletterIssue, changes: Partial<NewsletterIssue>): NewsletterIssue {
  const next = {
    ...existing,
    ...changes,
    id: existing.id,
    version: existing.version + 1,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  } as NewsletterIssue;
  for (const [name, value] of Object.entries(next)) {
    if (value === undefined || value === null) delete (next as Record<string, unknown>)[name];
  }
  return next;
}

/** Transaction write replacing `previous` with `next`. */
export const replaceIssueWrite = (previous: NewsletterIssue, next: NewsletterIssue): PlannedWrite =>
  putAtVersion(TABLE_NEWSLETTER_SLOTS, issueKey(previous.id), stored(next), previous.version);

/** Transaction write deleting `issue`. */
export const deleteIssueWrite = (issue: NewsletterIssue): PlannedWrite =>
  deleteAtVersion(TABLE_NEWSLETTER_SLOTS, issueKey(issue.id), issue.version);

/** Write an issue change that does not touch its Card's existence. */
export async function updateNewsletterIssue(
  client: DynamoDBDocumentClient,
  existing: NewsletterIssue,
  changes: Partial<NewsletterIssue>,
) {
  const next = nextNewsletterIssue(existing, changes);
  await client.send(new PutCommand({
    TableName: TABLE_NEWSLETTER_SLOTS,
    Item: { ...issueKey(existing.id), ...stored(next) },
    ConditionExpression: '#version=:version',
    ExpressionAttributeNames: { '#version': 'version' },
    ExpressionAttributeValues: { ':version': existing.version },
  }));
  return next;
}

/** Write a new issue; it has no Card yet. */
export async function createNewsletterIssue(client: DynamoDBDocumentClient, issue: NewsletterIssue) {
  if (issue.cardId) throw new Error('A new issue has no Card yet');
  await client.send(new PutCommand({
    TableName: TABLE_NEWSLETTER_SLOTS,
    Item: issueItem(issue),
    ConditionExpression: 'attribute_not_exists(PK)',
  }));
  return issue;
}

/** Delete an issue that has no Card. */
export async function deleteCardlessNewsletterIssue(client: DynamoDBDocumentClient, issue: NewsletterIssue) {
  if (issue.cardId) throw new Error('An issue with a Card is deleted together with its Card');
  await client.send(new DeleteCommand({
    TableName: TABLE_NEWSLETTER_SLOTS,
    Key: issueKey(issue.id),
    ConditionExpression: '#version=:version AND attribute_not_exists(cardId)',
    ExpressionAttributeNames: { '#version': 'version' },
    ExpressionAttributeValues: { ':version': issue.version },
  }));
}

export async function listNewsletterAlertRecords(client: DynamoDBDocumentClient) {
  const result = await client.send(
    new ScanCommand({
      TableName: TABLE_NEWSLETTER_SLOTS,
      FilterExpression: 'begins_with(PK,:prefix)',
      ExpressionAttributeValues: { ':prefix': 'ALERT#' },
    }),
  );
  return (result.Items || []) as any[];
}

export async function putNewsletterAlertRecord(client: DynamoDBDocumentClient, record: any) {
  const k = `ALERT#${record.id}`;
  await client.send(
    new PutCommand({
      TableName: TABLE_NEWSLETTER_SLOTS,
      Item: { PK: k, SK: k, ...record },
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );
  return record;
}

export async function updateNewsletterAlertRecord(client: DynamoDBDocumentClient, id: string, changes: any) {
  const k = `ALERT#${id}`,
    names = Object.keys(changes);
  await client.send(
    new UpdateCommand({
      TableName: TABLE_NEWSLETTER_SLOTS,
      Key: { PK: k, SK: k },
      UpdateExpression: `SET ${names.map((name) => `${name}=:${name}`).join(', ')}`,
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: Object.fromEntries(names.map((name) => [`:${name}`, changes[name]])),
    }),
  );
}
