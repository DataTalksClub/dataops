/**
 * /api/newsletter-issues: the newsletter planner.
 *
 * One row per email. Every issue that is not cancelled has exactly one Card,
 * created with the issue in one transaction; the Card cannot be unlinked,
 * relinked, or deleted on its own. Cancelling or deleting an issue deletes its
 * Card in the same transaction (the Card exists only to execute that issue);
 * when the Card has completed Tasks the caller must confirm with
 * `confirmCardDeletion`. Reinstating a cancelled issue creates a fresh Card.
 */
import { createHash, randomUUID } from 'crypto';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import type { Card, LambdaEvent, LambdaResponse } from '../types';
import {
  buildNewsletterIssue,
  deleteCardlessNewsletterIssue,
  deleteIssueWrite,
  getNewsletterIssue,
  listNewsletterAlertRecords,
  listNewsletterIssues,
  listNewsletterIssuesByCardId,
  newsletterIssueId,
  nextNewsletterIssue,
  putCardlessNewsletterIssue,
  putNewsletterAlertRecord,
  replaceIssueWrite,
  updateNewsletterAlertRecord,
  updateNewsletterIssue,
  type NewsletterIssue,
  type NewsletterIssueKind,
  type NewsletterSlot,
  type NewsletterSlotPosition,
} from '../db/newsletterIssues';
import { getCrmRecord } from '../db/sponsorCrm';
import { getCard, getCardConsistent } from '../db/cards';
import { listTasksByCardConsistent } from '../db/tasks';
import {
  CardDeletionBlockedError,
  CardDeletionConflictError,
  deleteCardCascade,
} from '../db/cardDeletion';
import { resolveInteractiveActor, type VerifiedActor } from '../identity/actor';
import { summarizeCard, type CardSummary } from '../cards/recordCardLink';
import { handleNewsletterSlotMigration } from './newsletterSlotMigration';
import {
  completedTasksLeavingCard,
  createIssueCard,
  issueLabel,
  issueTaskGroups,
  pushIssueToCard,
  SLOT_POSITIONS,
  syncIssueSlotTasks,
} from '../newsletter/issueCard';

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
  'publicUrl',
  'planningNote',
] as const;
const CREATE_FIELDS = new Set<string>([...UPDATABLE_FIELDS, 'kind', 'sourceType', 'sourceKey']);
const CONFIRMATIONS = ['confirmCardDeletion', 'confirmSlotRemoval'];
const SLOT_FIELDS = new Set(['ticked', 'sponsor', 'bookedByUserId', 'sponsorBookingId', 'sheetId', 'documentUrl']);

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

function slotError(position: string, slot: unknown): string {
  if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return `Invalid ${position} slot`;
  const value = slot as Record<string, unknown>;
  const unknown = Object.keys(value).find((name) => !SLOT_FIELDS.has(name));
  if (unknown) return `Unknown ${position} slot field: ${unknown}`;
  if (typeof value.ticked !== 'boolean') return `${position} slot needs ticked true or false`;
  if (value.sponsor != null && (typeof value.sponsor !== 'string' || !value.sponsor.trim() || value.sponsor.length > 200)) {
    return `Invalid ${position} slot sponsor`;
  }
  for (const name of ['bookedByUserId', 'sponsorBookingId']) {
    if (value[name] != null && !ID.test(String(value[name]))) return `Invalid ${position} slot ${name}`;
  }
  if (value.sheetId != null && (typeof value.sheetId !== 'string' || !value.sheetId || value.sheetId.length > 100)) {
    return `Invalid ${position} slot sheetId`;
  }
  if (value.documentUrl != null && !httpsUrl(value.documentUrl)) return `Invalid ${position} slot documentUrl`;
  if (!value.ticked && (value.sponsor || value.bookedByUserId || value.sponsorBookingId)) {
    return `Tick the ${position} slot before booking a sponsor on it`;
  }
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
  if (issue.kind === 'standalone' && !issue.slots.primary.ticked) return 'A stand-alone issue always has its slot';
  if (issue.publicUrl != null && !httpsUrl(issue.publicUrl)) return 'Invalid publicUrl';
  if (issue.planningNote != null && (typeof issue.planningNote !== 'string' || issue.planningNote.length > 1000)) {
    return 'Invalid planningNote';
  }
  for (const name of ['sourceType', 'sourceKey']) {
    if (issue[name] != null && (typeof issue[name] !== 'string' || issue[name].length > 200)) return `Invalid ${name}`;
  }
  return '';
}

/** Missing slots default to unticked; strings are trimmed. */
function normalizedSlots(kind: NewsletterIssueKind, slots: Body | undefined): NewsletterIssue['slots'] {
  const out: NewsletterIssue['slots'] = {};
  for (const position of SLOT_POSITIONS[kind] as readonly NewsletterSlotPosition[]) {
    const slot = { ticked: kind === 'standalone', ...(slots?.[position] || {}) } as NewsletterSlot;
    if (typeof slot.sponsor === 'string') slot.sponsor = slot.sponsor.trim();
    for (const name of Object.keys(slot) as (keyof NewsletterSlot)[]) {
      if (slot[name] === null || slot[name] === '') delete slot[name];
    }
    out[position] = slot;
  }
  return out;
}

async function sponsorBookingError(client: DynamoDBDocumentClient, issue: Body): Promise<string> {
  for (const slot of Object.values(issue.slots || {}) as NewsletterSlot[]) {
    if (slot?.sponsorBookingId && !(await getCrmRecord(client, 'deliverable', String(slot.sponsorBookingId)))) {
      return 'Sponsor booking unavailable';
    }
  }
  return '';
}

/** A ticked slot nobody has booked yet. */
const openSlots = (issue: NewsletterIssue) =>
  (Object.entries(issue.slots) as [NewsletterSlotPosition, NewsletterSlot | undefined][])
    .filter(([, slot]) => slot?.ticked && !slot.sponsor && !slot.bookedByUserId && !slot.sponsorBookingId)
    .map(([position]) => position);

const bookedSlots = (issue: NewsletterIssue) =>
  Object.values(issue.slots).filter((slot) => slot?.ticked && (slot.sponsor || slot.bookedByUserId || slot.sponsorBookingId));

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
    if (days >= 0 && days <= openLeadDays && item.status !== 'sent' && openSlots(item).length) {
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

/** Alerts about each issue's Card: missing, drifted, or unfinished after sending. */
function cardAlerts(items: NewsletterIssue[], cards: Map<string, Card | null>) {
  const out: any[] = [];
  const add = (item: NewsletterIssue, reasonCode: string, severity: string) => out.push({
    reasonCode,
    severity,
    issueId: item.id,
    fingerprint: `${item.id}#${reasonCode}#${item.publicationDate}`,
  });
  for (const item of items.filter((value) => value.status !== 'cancelled')) {
    const card = item.cardId ? cards.get(item.cardId) : null;
    if (!card) {
      add(item, 'card-unavailable', 'error');
      continue;
    }
    if (
      card.anchorDate !== item.publicationDate
      || (item.issueNumber != null && card.issueNumber != null && String(card.issueNumber) !== String(item.issueNumber))
    ) add(item, 'card-date-mismatch', 'warning');
    const expected = issueTaskGroups(item).sort();
    if (item.kind === 'weekly' && JSON.stringify([...(card.selectedOptionalGroups || [])].sort()) !== JSON.stringify(expected)) {
      add(item, 'card-slot-tasks-mismatch', 'warning');
    }
    if (item.status === 'sent') {
      const hasCampaign = (card.cardLinks || []).some(
        (link) => /mailchimp|campaign/i.test(String(link.name)) && /^https:\/\//.test(String(link.url)),
      );
      if (!hasCampaign || card.stage !== 'done') add(item, 'sent-issue-card-incomplete', 'warning');
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

async function withCardSummaries(
  client: DynamoDBDocumentClient,
  items: NewsletterIssue[],
  cards: Map<string, Card | null>,
) {
  const summaries = new Map<string, CardSummary>();
  for (const [id, card] of cards) if (card) summaries.set(id, await summarizeCard(client, card));
  return items.map((item) => ({
    ...item,
    label: issueLabel(item),
    card: item.cardId ? summaries.get(item.cardId) || null : null,
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
    return json(200, { items: await withCardSummaries(client, linked, await linkedCards(client, linked)) });
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
  // Booked: at least one sponsor booked. Unbooked: a ticked slot still needs one.
  if (query.booked === 'true') items = items.filter((item) => bookedSlots(item).length > 0);
  if (query.booked === 'false') items = items.filter((item) => openSlots(item).length > 0);
  const cards = await linkedCards(client, items);
  const current = [
    ...alerts(items, query.today || new Date().toISOString().slice(0, 10)),
    ...cardAlerts(items, cards),
  ];
  return json(200, {
    items: await withCardSummaries(client, items, cards),
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
  const candidate: Body = {
    ...body,
    slots: KINDS.has(kind) ? normalizedSlots(kind, body.slots) : body.slots,
    status: body.status || 'planned',
  };
  const error = validate(candidate);
  if (error) return json(400, { error });
  const bookingError = await sponsorBookingError(client, candidate);
  if (bookingError) return json(422, { error: bookingError });
  const sourceKey = typeof body.sourceKey === 'string' && body.sourceKey ? body.sourceKey : '';
  const id = sourceKey ? newsletterIssueId(sourceKey) : randomUUID();
  if (sourceKey) {
    const existing = await getNewsletterIssue(client, id);
    if (existing) {
      const same = Object.keys(candidate).every(
        (name) => JSON.stringify((existing as Body)[name]) === JSON.stringify(candidate[name]),
      );
      return same ? json(200, existing) : json(409, { error: 'Source key already used' });
    }
  }
  const issue = buildNewsletterIssue({ ...candidate, sourceType: body.sourceType || 'portal' } as any, id);
  if (issue.status === 'cancelled') {
    try {
      return json(201, await putCardlessNewsletterIssue(client, issue));
    } catch (failure) {
      if ((failure as Error).name === 'ConditionalCheckFailedException') return json(409, { error: 'Issue already exists' });
      throw failure;
    }
  }
  const resolved = await resolveInteractiveActor(client, event, 'work-write');
  if (!resolved.ok) return resolved.response;
  try {
    const created = await createIssueCard(client, resolved.actor, issue);
    if (!created.ok) return created.response;
    return json(201, {
      ...issue,
      cardId: created.card.id,
      label: issueLabel(issue),
      card: await summarizeCard(client, created.card),
    });
  } catch (failure) {
    if ((failure as Error).name === 'TransactionCanceledException') return json(409, { error: 'Issue already exists' });
    throw failure;
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
    changes.slots = normalizedSlots(existing.kind, { ...existing.slots, ...changes.slots });
  }
  const merged = { ...existing, ...changes };
  const error = validate(merged);
  if (error) return json(400, { error });
  const bookingError = await sponsorBookingError(client, merged);
  if (bookingError) return json(422, { error: bookingError });
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
    return json(200, { ...next, label: issueLabel(next), card: null });
  }
  if (reinstating) {
    const next = nextNewsletterIssue(existing, changes);
    try {
      const created = await createIssueCard(client, actor, next, (cardId) => replaceIssueWrite(existing, { ...next, cardId }));
      if (!created.ok) return created.response;
      return json(200, {
        ...next,
        cardId: created.card.id,
        label: issueLabel(next),
        card: await summarizeCard(client, created.card),
      });
    } catch (failure) {
      if ((failure as Error).name === 'TransactionCanceledException') return json(409, { error: 'Issue changed; reload and retry' });
      throw failure;
    }
  }

  const draft = nextNewsletterIssue(existing, changes);
  const leaving = await completedTasksLeavingCard(client, existing, draft);
  if (leaving.length && body.confirmSlotRemoval !== true) {
    return json(409, {
      error: `Unticking keeps ${leaving.length} completed Task${leaving.length === 1 ? '' : 's'} and skips the slot's open ones; confirm to continue`,
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
    const slotTasks = await syncIssueSlotTasks(client, next, actor.id || 'system');
    await pushIssueToCard(client, next);
    cardSync = slotTasks === 'synced' ? 'synced' : 'pushed';
  } catch (failure) {
    console.error('Newsletter issue card sync failed:', failure);
    cardSync = 'failed';
  }
  const card = next.cardId ? await getCard(client, next.cardId) : null;
  return json(200, {
    ...next,
    label: issueLabel(next),
    card: card ? await summarizeCard(client, card) : null,
    cardSync,
  });
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
  // ONE-OFF: remove with newsletterSlotMigration.ts once it has run.
  if (path === '/api/newsletter-issues/migrations/from-slots') {
    if (method !== 'POST') return json(405, { error: 'Method not allowed' });
    return handleNewsletterSlotMigration(event, client);
  }
  const match = path.match(/^\/api\/newsletter-issues(?:\/([^/]+))?$/);
  if (!match) return json(404, { error: 'Not found' });
  const id = match[1];
  if (method === 'GET' && !id) return listRoute(event, client);
  if (method === 'GET') {
    const item = await getNewsletterIssue(client, id);
    if (!item) return json(404, { error: 'Not found' });
    const card = item.cardId ? await getCard(client, item.cardId) : null;
    return json(200, { ...item, label: issueLabel(item), card: card ? await summarizeCard(client, card) : null });
  }
  const body = parse(event);
  if (!body) return json(400, { error: 'Invalid JSON' });
  if (method === 'POST' && !id) return createRoute(body, event, client);
  if (method === 'PUT' && id) return updateRoute(id, body, event, client);
  if (method === 'DELETE' && id) return deleteRoute(id, body, event, client);
  return json(405, { error: 'Method not allowed' });
}
