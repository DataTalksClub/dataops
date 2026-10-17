/**
 * /api/newsletter-issues: the newsletter planner.
 *
 * One row per email. An issue is planned (date, slots, sponsors, links)
 * without a Card; its Card is created when it is due (the daily run, see
 * `newsletter/cardSchedule.ts`) or on request (POST `/:id/card`), filled from
 * the issue in the same transaction as the issue's next version, so an issue
 * has at most one Card. The Card cannot be linked or relinked. Removing it
 * (DELETE `/:id/card`) keeps the issue and moves the Card's links onto it,
 * and is refused while the Card holds work unless confirmed. Cancelling or
 * deleting an issue deletes its Card in the same transaction; when the Card
 * has completed Tasks the caller must confirm with `confirmCardDeletion`.
 */
import { createHash, randomUUID } from 'crypto';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import type { Card, LambdaEvent, LambdaResponse } from '../types';
import {
  buildNewsletterIssue,
  createNewsletterIssue,
  deleteCardlessNewsletterIssue,
  deleteIssueWrite,
  getNewsletterIssue,
  listNewsletterAlertRecords,
  listNewsletterIssues,
  listNewsletterIssuesByCardId,
  newsletterIssueId,
  nextNewsletterIssue,
  putNewsletterAlertRecord,
  replaceIssueWrite,
  updateNewsletterAlertRecord,
  updateNewsletterIssue,
  type NewsletterIssue,
  type NewsletterIssueKind,
  type NewsletterIssueLink,
  type NewsletterIssueStats,
  type NewsletterSlot,
  type NewsletterSlotPosition,
  type NewsletterSlotStats,
} from '../db/newsletterIssues';
import { getCard, getCardConsistent } from '../db/cards';
import { listTasksByCardConsistent } from '../db/tasks';
import {
  CardDeletionBlockedError,
  CardDeletionConflictError,
  deleteCardCascade,
} from '../db/cardDeletion';
import { resolveInteractiveActor, type VerifiedActor } from '../identity/actor';
import { berlinDate } from '../sponsorFinance/core';
import { cardDueDate, createDueIssueCards, loadCardSchedule, needsCard, type CardSchedule } from '../newsletter/cardSchedule';
import { removeIssueCard } from '../newsletter/cardRemoval';
import { summarizeCard, type CardSummary } from '../cards/recordCardLink';
import {
  createSlotDeliverable,
  moveIssueDeliverables,
  resolveSponsorDeal,
  sponsorOptions,
  withdrawDeliverable,
  withdrawSlotDeliverables,
  type SponsorChoice,
} from '../newsletter/slotBooking';
import {
  completedTasksLeavingCard,
  createIssueCard,
  issueLabel,
  issueTaskGroups,
  pushIssueToCard,
  rescheduleOpenIssueTasks,
  SLOT_POSITIONS,
  syncIssueSlotTasks,
} from '../newsletter/issueCard';
import {
  buildIssueStatsReports,
  filterSponsorStatsReports,
} from '../newsletter/statsReport';

const json = (statusCode: number, body: unknown): LambdaResponse => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KINDS = new Set<NewsletterIssueKind>(['weekly', 'standalone']);
export const ISSUE_STATUSES = ['planned', 'drafting', 'review', 'scheduled', 'sent', 'cancelled'];
const STATUSES = new Set(ISSUE_STATUSES);
const UPDATABLE_FIELDS = [
  'publicationDate',
  'publicationTime',
  'utcOffset',
  'issueNumber',
  'status',
  'slots',
  'stats',
  'publicUrl',
  'planningNote',
  'links',
] as const;
const CREATE_FIELDS = new Set<string>([...UPDATABLE_FIELDS, 'kind', 'sourceType', 'sourceKey']);
const CONFIRMATIONS = ['confirmCardDeletion', 'confirmSlotRemoval'];
const SLOT_FIELDS = new Set(['sponsor', 'organizationId', 'bookedByUserId', 'sheetId', 'documentUrl', 'stats']);
const ISSUE_STATS_COUNTS = new Set(['deliveries', 'opens', 'clicks', 'uniqueClicks']);
const ISSUE_STATS_RATES = new Set(['openRate', 'clickRate']);
const ISSUE_STATS_FIELDS = new Set([...ISSUE_STATS_COUNTS, ...ISSUE_STATS_RATES, 'recordedAt']);
const SLOT_STATS_COUNTS = new Set([
  'clicks',
  'uniqueClicks',
  'linkedinImpressions',
  'linkedinClicks',
  'xImpressions',
  'xClicks',
]);
const SLOT_STATS_RATES = new Set(['clickRate', 'linkedinCtr', 'xCtr']);
const SLOT_STATS_URLS = new Set(['linkedinPostUrl', 'xPostUrl']);
const SLOT_STATS_FIELDS = new Set([...SLOT_STATS_COUNTS, ...SLOT_STATS_RATES, ...SLOT_STATS_URLS, 'recordedAt']);

type Body = Record<string, any>;

const parse = (event: LambdaEvent): Body | null => {
  try {
    const value = event.body ? JSON.parse(String(event.body)) : null;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
};

const realDate = (value: unknown) =>
  typeof value === 'string' && DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

const httpsUrl = (value: unknown) => {
  try {
    return typeof value === 'string' && new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

const nonNegativeInt = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const percentageRate = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;

const isoTimestamp = (value: unknown) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 64 && !Number.isNaN(Date.parse(value));

function issueStatsError(stats: unknown): string {
  if (stats === undefined) return '';
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return 'Invalid stats';
  const value = stats as Record<string, unknown>;
  const unknown = Object.keys(value).find((name) => !ISSUE_STATS_FIELDS.has(name));
  if (unknown) return `Unknown stats field: ${unknown}`;
  for (const name of ISSUE_STATS_COUNTS) {
    if (value[name] != null && !nonNegativeInt(value[name])) return `Invalid stats ${name}`;
  }
  for (const name of ISSUE_STATS_RATES) {
    if (value[name] != null && !percentageRate(value[name])) return `Invalid stats ${name}`;
  }
  if (value.recordedAt != null && !isoTimestamp(value.recordedAt)) return 'Invalid stats recordedAt';
  return '';
}

function slotStatsError(position: string, stats: unknown): string {
  if (stats === undefined) return '';
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return `Invalid ${position} slot stats`;
  const value = stats as Record<string, unknown>;
  const unknown = Object.keys(value).find((name) => !SLOT_STATS_FIELDS.has(name));
  if (unknown) return `Unknown ${position} slot stats field: ${unknown}`;
  for (const name of SLOT_STATS_COUNTS) {
    if (value[name] != null && !nonNegativeInt(value[name])) return `Invalid ${position} slot stats ${name}`;
  }
  for (const name of SLOT_STATS_RATES) {
    if (value[name] != null && !percentageRate(value[name])) return `Invalid ${position} slot stats ${name}`;
  }
  for (const name of SLOT_STATS_URLS) {
    if (value[name] != null && !httpsUrl(value[name])) return `Invalid ${position} slot stats ${name}`;
  }
  if (value.recordedAt != null && !isoTimestamp(value.recordedAt)) return `Invalid ${position} slot stats recordedAt`;
  return '';
}

function slotError(position: string, slot: unknown): string {
  if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return `Invalid ${position} slot`;
  const value = slot as Record<string, unknown>;
  const unknown = Object.keys(value).find((name) => !SLOT_FIELDS.has(name));
  if (unknown) return `Unknown ${position} slot field: ${unknown}`;
  if (value.sponsor != null && (typeof value.sponsor !== 'string' || !value.sponsor.trim() || value.sponsor.length > 200)) {
    return `Invalid ${position} slot sponsor`;
  }
  for (const name of ['bookedByUserId', 'organizationId']) {
    if (value[name] != null && !ID.test(String(value[name]))) return `Invalid ${position} slot ${name}`;
  }
  if (value.sheetId != null && (typeof value.sheetId !== 'string' || !value.sheetId || value.sheetId.length > 100)) {
    return `Invalid ${position} slot sheetId`;
  }
  if (value.documentUrl != null && !httpsUrl(value.documentUrl)) return `Invalid ${position} slot documentUrl`;
  if (!value.sponsor && (value.bookedByUserId || value.organizationId)) {
    return `Name the ${position} slot's sponsor before recording who booked it`;
  }
  const statsErr = slotStatsError(position, value.stats);
  if (statsErr) return statsErr;
  return '';
}

/** Validation of a complete issue (create, or existing merged with changes). */
function validate(issue: Body): string {
  if (!KINDS.has(issue.kind)) return 'Invalid kind';
  if (!realDate(issue.publicationDate)) return 'Invalid publicationDate';
  if (issue.publicationTime != null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(issue.publicationTime)) {
    return 'Invalid publicationTime';
  }
  if (issue.publicationTime?.startsWith('02:')) {
    const year = Number(issue.publicationDate.slice(0, 4));
    const lastSunday = (month: number) => {
      const date = new Date(Date.UTC(year, month + 1, 0));
      date.setUTCDate(date.getUTCDate() - date.getUTCDay());
      return date.toISOString().slice(0, 10);
    };
    if (issue.publicationDate === lastSunday(2)) return 'Nonexistent Europe/Berlin local time';
    if (issue.publicationDate === lastSunday(9) && !['+01:00', '+02:00'].includes(issue.utcOffset)) {
      return 'Ambiguous Europe/Berlin local time requires utcOffset';
    }
  }
  if (!STATUSES.has(String(issue.status))) return 'Invalid status';
  if (issue.issueNumber != null) {
    if (issue.kind === 'standalone') return 'A stand-alone issue has no issueNumber';
    if (!Number.isSafeInteger(issue.issueNumber) || issue.issueNumber < 0) return 'Invalid issueNumber';
  }
  if (!issue.slots || typeof issue.slots !== 'object' || Array.isArray(issue.slots)) return 'Invalid slots';
  const positions: readonly string[] = SLOT_POSITIONS[issue.kind as NewsletterIssueKind];
  const extra = Object.keys(issue.slots).find((position) => !positions.includes(position));
  if (extra) return `A ${issue.kind} issue has no ${extra} slot`;
  for (const position of positions) {
    const error = slotError(position, issue.slots[position]);
    if (error) return error;
  }
  const statsErr = issueStatsError(issue.stats);
  if (statsErr) return statsErr;
  if (issue.publicUrl != null && !httpsUrl(issue.publicUrl)) return 'Invalid publicUrl';
  if (issue.links != null) {
    if (!Array.isArray(issue.links) || issue.links.length > 30) return 'Invalid links';
    for (const link of issue.links as NewsletterIssueLink[]) {
      if (!link || typeof link !== 'object' || Object.keys(link).some((name) => name !== 'name' && name !== 'url')) return 'Invalid links';
      if (typeof link.name !== 'string' || !link.name.trim() || link.name.length > 200 || !httpsUrl(link.url)) return 'Invalid links';
    }
  }
  if (issue.planningNote != null && (typeof issue.planningNote !== 'string' || issue.planningNote.length > 1000)) {
    return 'Invalid planningNote';
  }
  for (const name of ['sourceType', 'sourceKey']) {
    if (issue[name] != null && (typeof issue[name] !== 'string' || issue[name].length > 200)) return `Invalid ${name}`;
  }
  return '';
}

function statsWithoutTimestamp(stats: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!stats || typeof stats !== 'object') return {};
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stats)) {
    if (key === 'recordedAt' || value === null || value === undefined || value === '') continue;
    copy[key] = value;
  }
  return copy;
}

function normalizedStatsObject<T extends NewsletterIssueStats | NewsletterSlotStats>(
  stats: unknown,
  previous?: T,
): T | undefined {
  if (stats === null || stats === undefined) return undefined;
  if (typeof stats !== 'object' || Array.isArray(stats)) return stats as T;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stats as Record<string, unknown>)) {
    if (value === null || value === undefined || value === '') continue;
    cleaned[key] = typeof value === 'string' ? value.trim() : value;
  }
  const metricKeys = Object.keys(cleaned).filter((key) => key !== 'recordedAt');
  if (metricKeys.length === 0) return undefined;
  if (!cleaned.recordedAt) {
    const prevMetrics = statsWithoutTimestamp(previous as Record<string, unknown> | undefined);
    const nextMetrics = statsWithoutTimestamp(cleaned);
    const unchanged = previous?.recordedAt && JSON.stringify(prevMetrics) === JSON.stringify(nextMetrics);
    cleaned.recordedAt = unchanged ? previous.recordedAt : new Date().toISOString();
  }
  return cleaned as T;
}

/** Every slot of the kind is present (open when empty); strings are trimmed. */
function normalizedSlots(
  kind: NewsletterIssueKind,
  slots: Body | undefined,
  previousSlots?: NewsletterIssue['slots'],
): NewsletterIssue['slots'] {
  const out: NewsletterIssue['slots'] = {};
  for (const position of SLOT_POSITIONS[kind] as readonly NewsletterSlotPosition[]) {
    const rawSlot = slots?.[position];
    if (!rawSlot || typeof rawSlot !== 'object' || Array.isArray(rawSlot)) {
      out[position] = (rawSlot ?? {}) as NewsletterSlot;
      continue;
    }
    const slot = { ...rawSlot } as NewsletterSlot;
    if (typeof slot.sponsor === 'string') slot.sponsor = slot.sponsor.trim();
    if ('stats' in slot) {
      const normalized = normalizedStatsObject<NewsletterSlotStats>(slot.stats, previousSlots?.[position]?.stats);
      if (normalized === undefined) delete slot.stats;
      else slot.stats = normalized;
    }
    for (const name of Object.keys(slot) as (keyof NewsletterSlot)[]) {
      if (slot[name] === null || slot[name] === '') delete slot[name];
    }
    out[position] = slot;
  }
  return out;
}

/** The issue's main slot (primary, or a stand-alone's only one) has no sponsor yet. */
const needsSponsor = (issue: NewsletterIssue) => !issue.slots.primary?.sponsor;

const bookedSlots = (issue: NewsletterIssue) => Object.values(issue.slots).filter((slot) => slot?.sponsor);

function alerts(items: NewsletterIssue[], today: string) {
  const boundedDays = (name: string, fallback: number) => {
    const parsed = Number(process.env[name]);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 365 ? parsed : fallback;
  };
  const openLeadDays = boundedDays('NEWSLETTER_OPEN_ALERT_LEAD_DAYS', 14);
  const active = items.filter((item) => item.status !== 'cancelled');
  const out: any[] = [];
  for (const item of active) {
    const days = Math.floor(
      (Date.parse(`${item.publicationDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000,
    );
    if (days >= 0 && days <= openLeadDays && item.status !== 'sent' && needsSponsor(item)) {
      out.push({
        reasonCode: 'near-term-open-slot',
        severity: 'warning',
        issueId: item.id,
        fingerprint: `${item.id}#near-term-open-slot#${item.publicationDate}`,
      });
    }
  }
  const groups = new Map<string, NewsletterIssue[]>();
  for (const item of active) {
    const key = `${item.publicationDate}#${item.kind}#${item.issueNumber ?? ''}`;
    groups.set(key, [...(groups.get(key) || []), item]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const item of group) {
      out.push({
        reasonCode: 'duplicate-active-issue',
        severity: 'error',
        issueId: item.id,
        fingerprint: `${item.id}#duplicate-active-issue#${item.publicationDate}`,
      });
    }
  }
  return out;
}

/** Alerts about each issue's Card: missing, overdue, or drifted from the issue. */
function cardAlerts(items: NewsletterIssue[], cards: Map<string, Card | null>, schedule: CardSchedule, today: string) {
  const out: any[] = [];
  const add = (item: NewsletterIssue, reasonCode: string, severity: string) => out.push({
    reasonCode,
    severity,
    issueId: item.id,
    fingerprint: `${item.id}#${reasonCode}#${item.publicationDate}`,
  });
  for (const item of items.filter((value) => value.status !== 'cancelled')) {
    if (!item.cardId) {
      // The daily run had its chance: a Card due before today is missing.
      const due = cardDueDate(item, schedule);
      if (needsCard(item, today) && due !== null && due < today) add(item, 'card-not-created', 'warning');
      continue;
    }
    const card = cards.get(item.cardId);
    if (!card) {
      add(item, 'card-unavailable', 'error');
      continue;
    }
    if (
      card.anchorDate !== item.publicationDate
      || (item.issueNumber != null && card.issueNumber != null && String(card.issueNumber) !== String(item.issueNumber))
    ) add(item, 'card-date-mismatch', 'warning');
    const cardGroups = new Set(card.selectedOptionalGroups || []);
    if (item.kind === 'weekly' && issueTaskGroups(item).some((group) => !cardGroups.has(group))) {
      add(item, 'card-slot-tasks-mismatch', 'warning');
    }
  }
  return out;
}

async function linkedCards(client: DynamoDBDocumentClient, items: NewsletterIssue[]) {
  const cards = new Map<string, Card | null>();
  for (const id of new Set(items.map((item) => item.cardId).filter(Boolean) as string[])) {
    cards.set(id, await getCard(client, id));
  }
  return cards;
}

const today = () => berlinDate(new Date());

/** When the issue's Card is due, for an issue that still needs one. */
const dueDateOf = (issue: NewsletterIssue, schedule: CardSchedule) =>
  needsCard(issue, today()) ? cardDueDate(issue, schedule) : null;

async function withCardSummaries(
  client: DynamoDBDocumentClient,
  items: NewsletterIssue[],
  cards: Map<string, Card | null>,
  schedule: CardSchedule,
) {
  const summaries = new Map<string, CardSummary>();
  for (const [id, card] of cards) if (card) summaries.set(id, await summarizeCard(client, card));
  return items.map((item) => ({
    ...item,
    label: issueLabel(item),
    card: item.cardId ? summaries.get(item.cardId) || null : null,
    cardDueDate: dueDateOf(item, schedule),
  }));
}

async function recordAlerts(client: DynamoDBDocumentClient, current: any[]) {
  const existing = await listNewsletterAlertRecords(client);
  const active = new Set(current.map((value) => value.fingerprint));
  const visible: any[] = [];
  for (const alert of current) {
    let record = existing
      .filter((value) => value.fingerprint === alert.fingerprint)
      .sort((a, b) => b.occurrence - a.occurrence)[0];
    if (!record || record.active === false) {
      const occurrence = (record?.occurrence || 0) + 1;
      const id = createHash('sha256').update(`${alert.fingerprint}#${occurrence}`).digest('hex');
      record = await putNewsletterAlertRecord(client, {
        ...alert,
        id,
        occurrence,
        active: true,
        dismissed: false,
        createdAt: new Date().toISOString(),
      });
    }
    if (!record.dismissed) visible.push(record);
  }
  for (const record of existing) {
    if (record.active && !active.has(record.fingerprint)) {
      await updateNewsletterAlertRecord(client, record.id, { active: false, resolvedAt: new Date().toISOString() });
    }
  }
  return visible;
}

async function listRoute(event: LambdaEvent, client: DynamoDBDocumentClient) {
  const query = event.queryStringParameters || {};
  if (query.cardId !== undefined) {
    if (!ID.test(query.cardId)) return json(400, { error: 'Invalid cardId' });
    const linked = await listNewsletterIssuesByCardId(client, query.cardId);
    const schedule = await loadCardSchedule(client);
    return json(200, { items: await withCardSummaries(client, linked, await linkedCards(client, linked), schedule) });
  }
  const from = query.from || new Date().toISOString().slice(0, 10);
  const to = query.to || '9999-12-31';
  if (!realDate(from) || !realDate(to) || from > to) return json(400, { error: 'Invalid range' });
  if (query.booked && !['true', 'false'].includes(query.booked)) return json(400, { error: 'Invalid booked filter' });
  if (query.today && !realDate(query.today)) return json(400, { error: 'Invalid today' });
  if (query.status && !STATUSES.has(query.status)) return json(400, { error: 'Invalid status' });
  if (query.kind && !KINDS.has(query.kind as NewsletterIssueKind)) return json(400, { error: 'Invalid kind' });
  let items = await listNewsletterIssues(client, from, to);
  if (query.status) items = items.filter((item) => item.status === query.status);
  if (query.kind) items = items.filter((item) => item.kind === query.kind);
  // Booked: at least one sponsor booked. Unbooked: the main slot still needs one.
  if (query.booked === 'true') items = items.filter((item) => bookedSlots(item).length > 0);
  if (query.booked === 'false') items = items.filter(needsSponsor);
  const cards = await linkedCards(client, items);
  const schedule = await loadCardSchedule(client);
  const day = query.today || today();
  const current = [
    ...alerts(items, day),
    ...cardAlerts(items, cards, schedule, day),
  ];
  return json(200, {
    items: await withCardSummaries(client, items, cards, schedule),
    alerts: await recordAlerts(client, current),
  });
}

async function cardHasCompletedTasks(client: DynamoDBDocumentClient, cardId: string) {
  return (await listTasksByCardConsistent(client, cardId)).filter((task) => task.status === 'done').length;
}

/**
 * Delete the issue's Card together with the issue's own write. Refused when
 * the Card has completed Tasks and the caller did not confirm.
 */
async function deleteWithCard(
  client: DynamoDBDocumentClient,
  actor: VerifiedActor,
  existing: NewsletterIssue,
  write: ReturnType<typeof deleteIssueWrite>,
  confirmed: boolean,
): Promise<LambdaResponse | null> {
  const card = await getCardConsistent(client, String(existing.cardId));
  if (!card) return json(409, { error: 'The issue Card is unavailable; reload and retry' });
  const completed = await cardHasCompletedTasks(client, card.id);
  if (completed && !confirmed) {
    return json(409, {
      error: `The issue Card has ${completed} completed Task${completed === 1 ? '' : 's'}; confirm to delete it`,
      code: 'card-has-completed-tasks',
      completedTasks: completed,
    });
  }
  try {
    await deleteCardCascade(client, card.id, card.version, actor.id || 'system', {
      newsletterIssueId: existing.id,
      write,
    });
  } catch (error) {
    if (error instanceof CardDeletionBlockedError) return json(409, { error: error.message, references: error.references });
    if (error instanceof CardDeletionConflictError || (error as Error).name === 'CardVersionConflictError') {
      return json(409, { error: 'Issue or Card changed; reload and retry' });
    }
    throw error;
  }
  return null;
}

async function createRoute(body: Body, event: LambdaEvent, client: DynamoDBDocumentClient) {
  const unknown = Object.keys(body).find((name) => !CREATE_FIELDS.has(name));
  if (unknown) return json(400, { error: `Unknown field: ${unknown}` });
  const kind = body.kind as NewsletterIssueKind;
  if (KINDS.has(kind) && body.slots && typeof body.slots === 'object') {
    const extra = Object.keys(body.slots).find((position) => !(SLOT_POSITIONS[kind] as readonly string[]).includes(position));
    if (extra) return json(400, { error: `A ${kind} issue has no ${extra} slot` });
  }
  const sourceKey = typeof body.sourceKey === 'string' && body.sourceKey ? body.sourceKey : '';
  const id = sourceKey ? newsletterIssueId(sourceKey) : randomUUID();
  const existing = sourceKey ? await getNewsletterIssue(client, id) : null;
  const candidate: Body = {
    ...body,
    slots: KINDS.has(kind) ? normalizedSlots(kind, body.slots, existing?.slots) : body.slots,
    status: body.status || 'planned',
  };
  if ('stats' in candidate) {
    const normalized = normalizedStatsObject<NewsletterIssueStats>(candidate.stats, existing?.stats);
    if (normalized === undefined) delete candidate.stats;
    else candidate.stats = normalized;
  }
  const error = validate(candidate);
  if (error) return json(400, { error });
  if (existing) {
    const same = Object.keys(candidate).every(
      (name) => JSON.stringify((existing as Body)[name]) === JSON.stringify(candidate[name]),
    );
    return same ? json(200, existing) : json(409, { error: 'Source key already used' });
  }
  const issue = buildNewsletterIssue({ ...candidate, sourceType: body.sourceType || 'portal' } as any, id);
  const resolved = await resolveInteractiveActor(client, event, 'work-write');
  if (!resolved.ok) return resolved.response;
  try {
    await createNewsletterIssue(client, issue);
  } catch (failure) {
    if ((failure as Error).name === 'ConditionalCheckFailedException') return json(409, { error: 'Issue already exists' });
    throw failure;
  }
  return json(201, await issueView(client, await withDueCard(client, resolved.actor, issue)));
}

/**
 * Create the issue's Card when it is already due, e.g. an issue added or
 * moved within the lead time; the daily run would otherwise wait a day.
 */
async function withDueCard(client: DynamoDBDocumentClient, actor: VerifiedActor, issue: NewsletterIssue) {
  if (!needsCard(issue, today())) return issue;
  const due = cardDueDate(issue, await loadCardSchedule(client));
  if (due === null || due > today()) return issue;
  try {
    const created = await createIssueCard(client, actor, issue);
    return created.ok ? created.issue : issue;
  } catch (failure) {
    console.error('Newsletter issue card creation failed:', failure);
    return issue;
  }
}

async function updateRoute(id: string, body: Body, event: LambdaEvent, client: DynamoDBDocumentClient) {
  const existing = await getNewsletterIssue(client, id);
  if (!existing) return json(404, { error: 'Not found' });
  if (body.version !== existing.version) return json(409, { error: 'Issue changed; reload and retry' });
  const allowed = new Set<string>([...UPDATABLE_FIELDS, 'version', ...CONFIRMATIONS]);
  if (body.kind !== undefined && body.kind !== existing.kind) {
    return json(400, { error: 'An issue cannot change kind; cancel it and add the other kind' });
  }
  const unknown = Object.keys(body).find((name) => !allowed.has(name) && name !== 'kind');
  if (unknown) return json(400, { error: `Unknown field: ${unknown}` });
  const changes: Body = {};
  for (const name of UPDATABLE_FIELDS) if (Object.hasOwn(body, name)) changes[name] = body[name];
  if (changes.slots !== undefined) {
    if (!changes.slots || typeof changes.slots !== 'object' || Array.isArray(changes.slots)) {
      return json(400, { error: 'Invalid slots' });
    }
    const extra = Object.keys(changes.slots).find((position) => !(SLOT_POSITIONS[existing.kind] as readonly string[]).includes(position));
    if (extra) return json(400, { error: `A ${existing.kind} issue has no ${extra} slot` });
    // A slot omitted from the change keeps its current state.
    changes.slots = normalizedSlots(existing.kind, { ...existing.slots, ...changes.slots }, existing.slots);
  }
  if ('stats' in changes) {
    changes.stats = normalizedStatsObject<NewsletterIssueStats>(changes.stats, existing.stats);
  }
  const merged = { ...existing, ...changes };
  const error = validate(merged);
  if (error) return json(400, { error });
  const resolved = await resolveInteractiveActor(client, event, 'work-write');
  if (!resolved.ok) return resolved.response;
  const actor = resolved.actor;

  const cancelling = existing.status !== 'cancelled' && merged.status === 'cancelled';
  const reinstating = existing.status === 'cancelled' && merged.status !== 'cancelled';
  if (cancelling) {
    const next = nextNewsletterIssue(existing, { ...changes, cardId: undefined });
    const failure = existing.cardId
      ? await deleteWithCard(client, actor, existing, replaceIssueWrite(existing, next), body.confirmCardDeletion === true)
      : null;
    if (failure) return failure;
    if (!existing.cardId) await updateNewsletterIssue(client, existing, changes);
    return json(200, await issueView(client, next));
  }

  const draft = nextNewsletterIssue(existing, changes);
  const leaving = await completedTasksLeavingCard(client, existing, draft);
  if (leaving.length && body.confirmSlotRemoval !== true) {
    return json(409, {
      error: `Releasing the slot keeps ${leaving.length} completed Task${leaving.length === 1 ? '' : 's'} and skips its open ones; confirm to continue`,
      code: 'slot-has-completed-tasks',
      completedTasks: leaving.map((task) => ({ id: task.id, description: task.description })),
    });
  }
  let next: NewsletterIssue;
  try {
    next = await updateNewsletterIssue(client, existing, changes);
  } catch {
    return json(409, { error: 'Conflicting update' });
  }
  let cardSync = 'unchanged';
  try {
    const slotTasks = await syncIssueSlotTasks(client, existing, next, actor.id || 'system');
    await pushIssueToCard(client, next);
    if (next.publicationDate !== existing.publicationDate) {
      await rescheduleOpenIssueTasks(client, next);
      await moveIssueDeliverables(client, next, actor.id || 'system');
    }
    cardSync = slotTasks === 'synced' ? 'synced' : 'pushed';
  } catch (failure) {
    console.error('Newsletter issue card sync failed:', failure);
    cardSync = 'failed';
  }
  return json(200, await issueView(client, await withDueCard(client, actor, next), { cardSync }));
}

async function deleteRoute(id: string, body: Body, event: LambdaEvent, client: DynamoDBDocumentClient) {
  const existing = await getNewsletterIssue(client, id);
  if (!existing) return json(404, { error: 'Not found' });
  if (body.version !== existing.version) return json(409, { error: 'Issue changed; reload and retry' });
  const resolved = await resolveInteractiveActor(client, event, 'work-write');
  if (!resolved.ok) return resolved.response;
  if (existing.cardId) {
    const failure = await deleteWithCard(
      client,
      resolved.actor,
      existing,
      deleteIssueWrite(existing),
      body.confirmCardDeletion === true,
    );
    if (failure) return failure;
    return { statusCode: 204, headers: {}, body: '' };
  }
  try {
    await deleteCardlessNewsletterIssue(client, existing);
  } catch {
    return json(409, { error: 'Conflicting delete' });
  }
  return { statusCode: 204, headers: {}, body: '' };
}

/** The issue as the routes return it: label, Card summary and Card due date attached. */
async function issueView(client: DynamoDBDocumentClient, issue: NewsletterIssue, extra: Body = {}) {
  const card = issue.cardId ? await getCard(client, issue.cardId) : null;
  return {
    ...issue,
    label: issueLabel(issue),
    card: card ? await summarizeCard(client, card) : null,
    cardDueDate: dueDateOf(issue, await loadCardSchedule(client)),
    ...extra,
  };
}

/**
 * POST creates the issue's Card now, whenever it is due; repeating it
 * returns the Card the issue already has. DELETE removes the Card and keeps
 * the issue (`dryRun` shows what would move and what keeps it).
 */
async function cardRoute(id: string, method: string, body: Body, event: LambdaEvent, client: DynamoDBDocumentClient) {
  const existing = await getNewsletterIssue(client, id);
  if (!existing) return json(404, { error: 'Not found' });
  if (method === 'POST' && existing.cardId) return json(200, await issueView(client, existing));
  if (body.version !== existing.version) return json(409, { error: 'Issue changed; reload and retry' });
  const resolved = await resolveInteractiveActor(client, event, 'work-write');
  if (!resolved.ok) return resolved.response;
  if (method === 'POST') {
    if (['cancelled', 'sent'].includes(existing.status)) {
      return json(409, { error: `A ${existing.status} issue gets no Card` });
    }
    try {
      const created = await createIssueCard(client, resolved.actor, existing);
      if (!created.ok) return created.response;
      return json(201, await issueView(client, created.issue));
    } catch (failure) {
      if ((failure as Error).name === 'TransactionCanceledException') return json(409, { error: 'Issue changed; reload and retry' });
      throw failure;
    }
  }
  const removed = await removeIssueCard(client, existing, resolved.actor.id || 'system', {
    confirm: body.confirmCardDeletion === true,
    dryRun: body.dryRun === true,
  });
  if (!removed.ok) {
    return json(removed.status, {
      error: removed.error,
      ...(removed.code ? { code: removed.code } : {}),
      ...(removed.plan ? { keep: removed.plan.keep, moves: removed.plan.moves } : {}),
    });
  }
  const { next, ...plan } = removed.plan;
  return json(200, {
    ...plan,
    removed: removed.removed,
    issue: removed.removed ? await issueView(client, next) : await issueView(client, existing),
  });
}

/**
 * Apply a slot change made by booking, changing or releasing a sponsor:
 * refuse when releasing would leave completed slot Tasks unless confirmed,
 * write the issue, then bring the Card's slot Tasks and title along.
 */
async function writeSlotChange(
  client: DynamoDBDocumentClient,
  existing: NewsletterIssue,
  slots: NewsletterIssue['slots'],
  actorId: string,
  confirmed: boolean,
): Promise<{ ok: true; issue: NewsletterIssue; cardSync: string } | { ok: false; response: LambdaResponse }> {
  const draft = nextNewsletterIssue(existing, { slots });
  const leaving = await completedTasksLeavingCard(client, existing, draft);
  if (leaving.length && !confirmed) {
    return {
      ok: false,
      response: json(409, {
        error: `Releasing the slot keeps ${leaving.length} completed Task${leaving.length === 1 ? '' : 's'} and skips its open ones; confirm to continue`,
        code: 'slot-has-completed-tasks',
        completedTasks: leaving.map((task) => ({ id: task.id, description: task.description })),
      }),
    };
  }
  let issue: NewsletterIssue;
  try {
    issue = await updateNewsletterIssue(client, existing, { slots });
  } catch {
    return { ok: false, response: json(409, { error: 'Issue changed; reload and retry' }) };
  }
  let cardSync = 'unchanged';
  try {
    const synced = await syncIssueSlotTasks(client, existing, issue, actorId);
    await pushIssueToCard(client, issue);
    cardSync = synced === 'synced' ? 'synced' : issue.cardId ? 'pushed' : 'unchanged';
  } catch (failure) {
    console.error('Newsletter issue card sync failed:', failure);
    cardSync = 'failed';
  }
  return { ok: true, issue, cardSync };
}

/**
 * PUT books the slot for a sponsor from the Sponsors tab (`dealId`, or
 * `organizationId` to open a new deal) and withdraws the slot's previous
 * booking, so changing the sponsor is one step. DELETE releases the slot.
 */
async function slotRoute(
  id: string,
  position: string,
  method: string,
  body: Body,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
) {
  const existing = await getNewsletterIssue(client, id);
  if (!existing) return json(404, { error: 'Not found' });
  if (!(SLOT_POSITIONS[existing.kind] as readonly string[]).includes(position)) {
    return json(400, { error: `A ${existing.kind} issue has no ${position} slot` });
  }
  if (body.version !== existing.version) return json(409, { error: 'Issue changed; reload and retry' });
  if (['sent', 'cancelled'].includes(existing.status)) {
    return json(409, { error: `A ${existing.status} issue's slots cannot change` });
  }
  const resolved = await resolveInteractiveActor(client, event, 'work-write');
  if (!resolved.ok) return resolved.response;
  const actorId = resolved.actor.id || 'system';
  const slotPosition = position as NewsletterSlotPosition;
  const current = existing.slots[slotPosition] || {};

  if (method === 'DELETE') {
    const slots = { ...existing.slots, [slotPosition]: current.sheetId ? { sheetId: current.sheetId } : {} };
    const written = await writeSlotChange(client, existing, slots, actorId, body.confirmSlotRemoval === true);
    if (!written.ok) return written.response;
    const withdrawn = await withdrawSlotDeliverables(client, written.issue, slotPosition, actorId);
    return json(200, await issueView(client, written.issue, { cardSync: written.cardSync, withdrawnDeliverables: withdrawn }));
  }

  const choice: SponsorChoice | null = typeof body.dealId === 'string' && ID.test(body.dealId)
    ? { dealId: body.dealId }
    : typeof body.organizationId === 'string' && ID.test(body.organizationId)
      ? { organizationId: body.organizationId }
      : null;
  if (!choice) return json(400, { error: 'Choose a sponsor: dealId or organizationId' });
  const sponsor = await resolveSponsorDeal(client, choice, actorId, `${issueLabel(existing)} ${position} slot`);
  if ('error' in sponsor) return json(422, { error: sponsor.error });
  const deliverable = await createSlotDeliverable(client, existing, slotPosition, sponsor.deal, actorId);
  const slot = {
    ...(current.sheetId ? { sheetId: current.sheetId } : {}),
    // The placement document and stats belong to the sponsor they were recorded for.
    ...(current.documentUrl && current.sponsor === sponsor.name ? { documentUrl: current.documentUrl } : {}),
    ...(current.stats && current.sponsor === sponsor.name ? { stats: current.stats } : {}),
    sponsor: sponsor.name,
    organizationId: String(sponsor.deal.organizationId),
    bookedByUserId: actorId,
  };
  const written = await writeSlotChange(client, existing, { ...existing.slots, [slotPosition]: slot }, actorId, true);
  if (!written.ok) {
    await withdrawDeliverable(client, deliverable, actorId);
    return written.response;
  }
  const withdrawn = await withdrawSlotDeliverables(client, written.issue, slotPosition, actorId, deliverable.id);
  return json(200, await issueView(client, written.issue, {
    cardSync: written.cardSync,
    deliverableId: deliverable.id,
    dealId: sponsor.deal.id,
    withdrawnDeliverables: withdrawn,
  }));
}

async function sponsorReportRoute(event: LambdaEvent, client: DynamoDBDocumentClient) {
  const query = event.queryStringParameters || {};
  const sponsor = typeof query.sponsor === 'string' ? query.sponsor.trim() : '';
  const organizationId = typeof query.organizationId === 'string' ? query.organizationId.trim() : '';
  if (!sponsor && !organizationId) return json(400, { error: 'Provide a sponsor or organizationId query parameter' });
  const from = query.from || '0000-01-01';
  const to = query.to || '9999-12-31';
  if ((query.from && !realDate(from)) || (query.to && !realDate(to)) || from > to) {
    return json(400, { error: 'Invalid range' });
  }
  const slot = typeof query.slot === 'string' && query.slot ? (query.slot as NewsletterSlotPosition) : undefined;
  if (slot && !['primary', 'secondary'].includes(slot)) return json(400, { error: 'Invalid slot' });
  const contactName = typeof query.contactName === 'string' ? query.contactName : undefined;
  const items = await listNewsletterIssues(client, from, to);
  const reports = filterSponsorStatsReports(items, { sponsor, organizationId, slot, contactName });
  return json(200, {
    sponsor: sponsor || null,
    organizationId: organizationId || null,
    items: reports,
  });
}

async function issueReportRoute(id: string, event: LambdaEvent, client: DynamoDBDocumentClient) {
  const item = await getNewsletterIssue(client, id);
  if (!item) return json(404, { error: 'Not found' });
  const query = event.queryStringParameters || {};
  const validPositions = SLOT_POSITIONS[item.kind] as readonly NewsletterSlotPosition[];
  const slot = typeof query.slot === 'string' && query.slot ? (query.slot as NewsletterSlotPosition) : undefined;
  if (slot !== undefined && !validPositions.includes(slot)) {
    return json(400, { error: `A ${item.kind} issue has no ${slot} slot` });
  }
  const contactName = typeof query.contactName === 'string' ? query.contactName : undefined;
  const reports = buildIssueStatsReports(item, { slot, contactName });
  return json(200, {
    issueId: item.id,
    label: issueLabel(item),
    publicationDate: item.publicationDate,
    issueStats: item.stats || null,
    report: reports[0] || null,
    reports,
  });
}

export async function handleNewsletterIssueRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
) {
  const dismiss = path.match(/^\/api\/newsletter-issues\/alerts\/([^/]+)\/dismiss$/);
  if (dismiss) {
    if (method !== 'POST') return json(405, { error: 'Method not allowed' });
    try {
      await updateNewsletterAlertRecord(client, dismiss[1], { dismissed: true, dismissedAt: new Date().toISOString() });
      return json(200, { dismissed: true });
    } catch {
      return json(404, { error: 'Alert not found' });
    }
  }
  if (path === '/api/newsletter-issues/create-due-cards') {
    if (method !== 'POST') return json(405, { error: 'Method not allowed' });
    const body = parse(event) || {};
    const resolved = await resolveInteractiveActor(client, event, 'work-write');
    if (!resolved.ok) return resolved.response;
    return json(200, await createDueIssueCards(client, today(), { dryRun: body.dryRun === true }));
  }
  if (path === '/api/newsletter-issues/report') {
    if (method !== 'GET') return json(405, { error: 'Method not allowed' });
    return sponsorReportRoute(event, client);
  }
  const issueReport = path.match(/^\/api\/newsletter-issues\/([^/]+)\/report$/);
  if (issueReport) {
    if (method !== 'GET') return json(405, { error: 'Method not allowed' });
    return issueReportRoute(issueReport[1], event, client);
  }
  const card = path.match(/^\/api\/newsletter-issues\/([^/]+)\/card$/);
  if (card) {
    if (method !== 'POST' && method !== 'DELETE') return json(405, { error: 'Method not allowed' });
    const body = parse(event);
    if (!body) return json(400, { error: 'Invalid JSON' });
    return cardRoute(card[1], method, body, event, client);
  }
  if (path === '/api/newsletter-issues/sponsor-options') {
    if (method !== 'GET') return json(405, { error: 'Method not allowed' });
    return json(200, { items: await sponsorOptions(client) });
  }
  const slot = path.match(/^\/api\/newsletter-issues\/([^/]+)\/slots\/([^/]+)$/);
  if (slot) {
    if (method !== 'PUT' && method !== 'DELETE') return json(405, { error: 'Method not allowed' });
    const body = parse(event);
    if (!body) return json(400, { error: 'Invalid JSON' });
    return slotRoute(slot[1], slot[2], method, body, event, client);
  }
  const match = path.match(/^\/api\/newsletter-issues(?:\/([^/]+))?$/);
  if (!match) return json(404, { error: 'Not found' });
  const id = match[1];
  if (method === 'GET' && !id) return listRoute(event, client);
  if (method === 'GET') {
    const item = await getNewsletterIssue(client, id);
    if (!item) return json(404, { error: 'Not found' });
    return json(200, await issueView(client, item));
  }
  const body = parse(event);
  if (!body) return json(400, { error: 'Invalid JSON' });
  if (method === 'POST' && !id) return createRoute(body, event, client);
  if (method === 'PUT' && id) return updateRoute(id, body, event, client);
  if (method === 'DELETE' && id) return deleteRoute(id, body, event, client);
  return json(405, { error: 'Method not allowed' });
}
