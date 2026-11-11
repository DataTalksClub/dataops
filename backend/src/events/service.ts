import { cardEventInterval } from '../calendar/cardEventTime';
import { manualCalendarPolicy } from './manualCalendarPolicy';
import { claimGuestSlotAllocator, releaseAllocator } from './guestIntakeAllocator';
import { guestEventSlots } from './guestIntakeSlots';
import type { GuestIntakeJob } from './guestIntakeStore';
import { resolveGuestAcceptanceTask } from './guestIntakeCompletion';
import { randomUUID } from 'node:crypto';
import {
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { TABLE_CALENDAR, TABLE_CARDS, TABLE_PODCAST_EPISODES } from '../db/tableNames';
import { getCardConsistent, updateCardAdditive } from '../db/cards';
import { getTemplate } from '../db/templates';
import { getPodcastEpisode, listPodcastEpisodes, type PodcastEpisode } from '../db/podcastEpisodes';
import { calendarInviteDeps } from '../db/calendarHolds';
import {
  ensureEventRescheduleTask,
  EVENT_RESCHEDULE_CHECKLIST_ID,
  loadTaskChecklistDefinition,
} from '../taskChecklist';
import {
  calendarInviteUrl,
  cardGuestDocument,
  cardGuests,
  closeCardInviteTasks,
  parseCardGuests,
} from '../calendar/cardInvite';
import {
  createHoldGoogleEvents,
  deleteHoldGoogleEvents,
  fetchGoogleEvent,
  HOLD_ORGANIZER,
  updateHoldGoogleEvents,
  type HoldGoogleDeps,
  type HoldGoogleEvent,
  type HoldGoogleResult,
} from '../calendar/holdGoogleSync';
import type { Card } from '../types';
import { parseEventPolicy, type EventPolicy } from './policy';
import {
  EventConflictError,
  planEventTransition,
  type EventCommand,
  type EventHistoryEntry,
  type EventOperation,
  type EventOperationTransition,
  type EventRecord,
} from './lifecycle';
import {
  claimEventOperation,
  commitEventTransition,
  completeEventOperation,
  getEventHistory,
  getEventRecord,
} from './store';

export { EventConflictError };
export class EventInputError extends Error {}
export class EventNotFoundError extends Error {}

export interface EventEmailMessage {
  to: string[];
  subject: string;
  body: string;
}

export interface EventEmailReceipt {
  state: 'dispatching' | 'sent' | 'outcome-unknown';
  messageId?: string;
  at: string;
  error?: string;
}

export type EventEmailSender = (message: EventEmailMessage) => Promise<{ messageId: string }>;

let customEmailSender: EventEmailSender | null = null;

export function setEventEmailSenderForTests(sender: EventEmailSender | null): void {
  customEmailSender = sender;
}

async function sendTransitionEmail(message: EventEmailMessage): Promise<{ messageId: string }> {
  if (customEmailSender) return customEmailSender(message);
  return { messageId: `msg_${randomUUID()}` };
}

export interface EventLifecycleResult {
  event: EventRecord;
  history: EventHistoryEntry[];
  card: Card;
  episode: PodcastEpisode | null;
  sync: { state: 'synced' | 'deferred'; reason?: string; eventIds: Record<string, string> };
  emailReceipts: Record<number, EventEmailReceipt>;
  attendeeResponses?: Record<string, string>;
  declinedBy?: Array<{ email: string; at: string }>;
  rescheduleTaskId?: string;
}

const eventKey = (id: string) => ({ PK: `CALHOLD#${id}`, SK: `CALHOLD#${id}` });
const logKey = (id: string, key: string) => ({ PK: `CALEVENTLOG#${id}`, SK: `OP#${key}` });
const cardKey = (id: string) => ({ PK: `CARD#${id}`, SK: `CARD#${id}` });

/** Resolve the declarative EventPolicy from the Card's reviewed Template snapshot (or its Template). */
export async function resolveCardEventPolicy(
  client: DynamoDBDocumentClient,
  card: Card,
): Promise<{ templateId: string; templateVersion: number; policy: EventPolicy }> {
  const snapshotPolicy = card.templateDefinitionSnapshot?.eventPolicy;
  if (snapshotPolicy) {
    return {
      templateId: card.templateId,
      templateVersion: card.templateVersion || 1,
      policy: parseEventPolicy(snapshotPolicy),
    };
  }
  const template = card.templateId ? await getTemplate(client, card.templateId) : null;
  if (template?.eventPolicy) {
    return {
      templateId: template.id,
      templateVersion: template.version || 1,
      policy: parseEventPolicy(template.eventPolicy),
    };
  }
  // A pinned (operator-edited) Git Template keeps its live definition, but its
  // Git base still follows workflow-templates/. When the live definition never
  // declared an eventPolicy, use the Git-authored one from the base (eb5012d8).
  const basePolicy = template?.base?.eventPolicy;
  if (template && basePolicy) {
    return {
      templateId: template.id,
      templateVersion: template.version || 1,
      policy: parseEventPolicy(basePolicy),
    };
  }
  throw new EventInputError(
    `Card '${card.id}' (template '${card.templateId}') does not declare an eventPolicy in its Template.`,
  );
}

interface ResolvedTarget {
  card: Card;
  episode: PodcastEpisode | null;
  event: EventRecord | null;
  holdId: string;
}

async function findEpisodeForCard(
  client: DynamoDBDocumentClient,
  cardId: string,
): Promise<PodcastEpisode | null> {
  const episodes = await listPodcastEpisodes(client);
  return episodes.find((ep) => ep.cardId === cardId) || null;
}

/** Upgrade a legacy CalendarHold row in TABLE_CALENDAR when transitioning via unified service. */
async function readOrUpgradeEventRecord(
  client: DynamoDBDocumentClient,
  holdId: string,
  card: Card,
): Promise<EventRecord | null> {
  try {
    return await getEventRecord(client, holdId);
  } catch (err) {
    if (!(err instanceof EventConflictError)) throw err;
    const raw = (
      await client.send(new GetCommand({ TableName: TABLE_CALENDAR, Key: eventKey(holdId), ConsistentRead: true }))
    ).Item;
    if (!raw) return null;
    const { templateId, templateVersion, policy } = await resolveCardEventPolicy(client, card);
    const status =
      raw.status === 'confirmed' ? 'approved' : raw.status === 'tentative' ? 'proposed' : 'released';
    const time =
      typeof raw.startIso === 'string'
        ? new Intl.DateTimeFormat('en-GB', {
            timeZone: String(raw.timeZone || policy.timeZone),
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          }).format(new Date(raw.startIso))
        : Object.values(policy.windows)[0] || '12:00';
    const opKey = `migrated-${raw.version || 1}`;
    const op: EventOperation = {
      key: opKey,
      fingerprint: `migrated-${holdId}-${raw.version || 1}`,
      transition: status === 'approved' ? 'approve' : status === 'released' ? 'release' : 'propose',
      state: 'complete',
      result: { googleEventIds: (raw.googleEventIds as Record<string, string>) || {} },
      desired: {
        summary: String(raw.googleTitle || raw.title || card.title || 'Event'),
        description: String(raw.topic || ''),
        location: '',
        attendees: typeof raw.guestRef === 'string' && raw.guestRef.includes('@') ? [raw.guestRef.trim().toLowerCase()] : [],
        startIso: String(raw.startIso || new Date().toISOString()),
        endIso: String(raw.endIso || new Date().toISOString()),
        timeZone: String(raw.timeZone || policy.timeZone),
        sendUpdates: 'all',
        emails: [],
      },
    };
    const migrated: EventRecord = {
      id: holdId,
      cardId: card.id,
      templateId,
      templateVersion,
      version: Number(raw.version || 1),
      generation: 1,
      identityGeneration: 1,
      status,
      date: String(raw.date || card.anchorDate || '2030-01-01'),
      time,
      timeZone: String(raw.timeZone || policy.timeZone),
      startIso: String(raw.startIso || new Date().toISOString()),
      endIso: String(raw.endIso || new Date().toISOString()),
      durationMinutes: Number(raw.durationMinutes || policy.durationMinutes),
      expiresAt: String(raw.expiresAt || new Date(Date.now() + policy.expiresDays * 86400000).toISOString()),
      policy,
      renderValues: {
        title: String(raw.title || card.title || 'Event'),
        topic: String(raw.topic || card.title || 'Event'),
        guestNames: (card.people || []).join(', '),
        date: String(raw.date || card.anchorDate || '2030-01-01'),
        time,
        timeZone: String(raw.timeZone || policy.timeZone),
        documentUrl: String(raw.documentUrl || ''),
        zoomUrl: policy.zoom.enabled ? policy.zoom.url || '' : '',
      },
      guestEmails:
        typeof raw.guestRef === 'string' && raw.guestRef.includes('@')
          ? [raw.guestRef.trim().toLowerCase()]
          : card.guestEmails || [],
      googleEventIds: (raw.googleEventIds as Record<string, string>) || {},
      previousGoogleEventIds: [],
      history: [],
      operations: [op],
    };
    await client.send(
      new PutCommand({
        TableName: TABLE_CALENDAR,
        Item: { ... logKey(holdId, opKey), operation: op, generation: 1, previousGoogleEventIds: [] },
      }),
    );
    const { operations: _ops, history: _hist, previousGoogleEventIds: _prev, ...authority } = migrated;
    await client.send(
      new PutCommand({
        TableName: TABLE_CALENDAR,
        Item: { ...eventKey(holdId), ...authority, latestOperationKey: opKey },
      }),
    );
    return migrated;
  }
}

/** Resolve targetId (Card ID, Hold ID, or PodcastEpisode ID) to its canonical Card and EventRecord. */
export async function resolveEventTarget(
  client: DynamoDBDocumentClient,
  targetId: string,
): Promise<ResolvedTarget> {
  const trimmed = String(targetId || '').trim();
  if (!trimmed) throw new EventInputError('A Card ID, Hold ID, or Episode ID is required.');

  // 1. Direct Card ID
  let card = await getCardConsistent(client, trimmed);
  let episode: PodcastEpisode | null = null;
  if (card) {
    episode = await findEpisodeForCard(client, card.id);
    const holdId =
      card.eventTime?.eventKey && card.eventTime.eventKey.startsWith('hold_')
        ? card.eventTime.eventKey
        : `hold_${card.id}`;
    const event = await readOrUpgradeEventRecord(client, holdId, card);
    if (event) return { card, episode, event, holdId };
    // Check if another CALHOLD# row references this cardId
    const scan = await client.send(
      new ScanCommand({
        TableName: TABLE_CALENDAR,
        FilterExpression: 'begins_with(PK, :prefix) AND cardId = :cardId',
        ExpressionAttributeValues: { ':prefix': 'CALHOLD#', ':cardId': card.id },
        ConsistentRead: true,
      }),
    );
    const match = (scan.Items || [])[0];
    if (match && typeof match.id === 'string') {
      const existing = await readOrUpgradeEventRecord(client, match.id, card);
      return { card, episode, event: existing, holdId: match.id };
    }
    return { card, episode, event: null, holdId };
  }

  // 2. Hold ID in TABLE_CALENDAR
  const holdItem = (
    await client.send(new GetCommand({ TableName: TABLE_CALENDAR, Key: eventKey(trimmed), ConsistentRead: true }))
  ).Item;
  if (holdItem && typeof holdItem.cardId === 'string') {
    card = await getCardConsistent(client, holdItem.cardId);
    if (!card) throw new EventNotFoundError(`Card '${holdItem.cardId}' for hold '${trimmed}' not found.`);
    episode = await findEpisodeForCard(client, card.id);
    const event = await readOrUpgradeEventRecord(client, trimmed, card);
    return { card, episode, event, holdId: trimmed };
  }

  // 3. Podcast Episode ID
  episode = await getPodcastEpisode(client, trimmed);
  if (episode) {
    if (!episode.cardId) {
      throw new EventInputError(`Episode '${episode.id}' is not linked to a Card yet.`);
    }
    card = await getCardConsistent(client, episode.cardId);
    if (!card) throw new EventNotFoundError(`Card '${episode.cardId}' for episode '${episode.id}' not found.`);
    const holdId =
      episode.recordingHoldId ||
      (card.eventTime?.eventKey && card.eventTime.eventKey.startsWith('hold_')
        ? card.eventTime.eventKey
        : `hold_${card.id}`);
    const event = await readOrUpgradeEventRecord(client, holdId, card);
    return { card, episode, event, holdId };
  }

  throw new EventNotFoundError(`Event target '${trimmed}' not found.`);
}

async function resolveProposalGuests(
  client: DynamoDBDocumentClient,
  card: Card,
  episode: PodcastEpisode | null,
  current: EventRecord | null,
  explicitGuests: string[] | undefined,
  policy: EventPolicy,
): Promise<string[]> {
  if (explicitGuests !== undefined) {
    return explicitGuests.length ? parseCardGuests(explicitGuests) : [];
  }
  if (current?.guestEmails?.length) return current.guestEmails;
  if (card.guestEmails?.length) return parseCardGuests(card.guestEmails);
  const episodeEmails = (episode?.guests || [])
    .map((g) => g.email)
    .filter((e): e is string => Boolean(e && e.trim()));
  if (episodeEmails.length) return parseCardGuests(episodeEmails);
  try {
    return await cardGuests(client, card);
  } catch (err) {
    if (policy.calendarAcceptance.enabled || policy.guests.proposal) {
      throw new EventInputError(err instanceof Error ? err.message : 'Guest email addresses are required.');
    }
    return [];
  }
}

export function buildEpisodeTransactionWrite(
  episode: PodcastEpisode | null,
  next: EventRecord,
  at: string,
) {
  if (!episode) return [];
  return [
    {
      Update: {
        TableName: TABLE_PODCAST_EPISODES,
        Key: { PK: `EPISODE#${episode.id}`, SK: `EPISODE#${episode.id}` },
        UpdateExpression:
          'SET recordingDate = :date, recordingTime = :time, recordingTimeZone = :tz, recordingStartIso = :startIso, recordingEndIso = :endIso, recordingEventStatus = :status, recordingHoldId = :holdId, dateKey = :dateKey, updatedAt = :at ADD #version :one',
        ConditionExpression: '#version = :expectedVersion',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: {
          ':date': next.date,
          ':time': next.time,
          ':tz': next.timeZone,
          ':startIso': next.startIso,
          ':endIso': next.endIso,
          ':status': next.status,
          ':holdId': next.id,
          ':dateKey': `${episode.releaseDate || next.date}#${episode.id}`,
          ':at': at,
          ':one': 1,
          ':expectedVersion': episode.version,
        },
      },
    },
  ];
}

/** Reconcile pending Google Calendar and email side effects for an operation under an exclusive worker lease. */
export async function reconcileEventOperation(
  client: DynamoDBDocumentClient,
  eventId: string,
  operationKey: string,
  deps: HoldGoogleDeps,
  actor: string,
  options: { forceEmailRetry?: boolean } = {},
): Promise<{
  sync: HoldGoogleResult;
  emailReceipts: Record<number, EventEmailReceipt>;
}> {
  const nowIso = new Date().toISOString();
  let current = await getEventRecord(client, eventId, operationKey);
  if (!current) throw new EventNotFoundError(`Event '${eventId}' not found.`);
  const op = current.operations.find((entry) => entry.key === operationKey);
  if (!op) throw new EventNotFoundError(`Operation '${operationKey}' on event '${eventId}' not found.`);

  const logRow = (
    await client.send(new GetCommand({ TableName: TABLE_CALENDAR, Key: logKey(eventId, operationKey), ConsistentRead: true }))
  ).Item || {};
  const emailReceipts: Record<number, EventEmailReceipt> = {
    ...((logRow.emailReceipts as Record<number, EventEmailReceipt>) || {}),
  };

  if (op.state === 'complete') {
    return {
      sync: { state: 'synced', eventIds: op.result?.googleEventIds || current.googleEventIds },
      emailReceipts,
    };
  }

  const lease = await claimEventOperation(client, eventId, operationKey, nowIso);
  if (!lease) {
    throw new EventConflictError('Event operation is currently being reconciled by another worker; retry shortly.');
  }

  // Reload after claiming lease
  current = (await getEventRecord(client, eventId, operationKey))!;
  const googleEventKey =
    current.identityGeneration === 1 ? current.id : `${current.id}:gen:${current.identityGeneration}`;

  let sync: HoldGoogleResult;
  if (op.transition === 'release') {
    sync = await deleteHoldGoogleEvents(current.googleEventIds, {
      ...deps,
      sendUpdates: op.desired.sendUpdates,
    });
  } else {
    const googlePayload: HoldGoogleEvent = {
      eventKey: googleEventKey,
      summary: op.desired.summary,
      description: op.desired.description,
      location: op.desired.location,
      attendees: op.desired.attendees,
      startIso: op.desired.startIso,
      endIso: op.desired.endIso,
      timeZone: op.desired.timeZone,
      extendedProperties: {
        private: {
          dataopsHoldId: current.id,
          dataopsCardId: current.cardId,
          dataopsGeneration: String(current.generation),
          dataopsStatus: current.status,
        },
      },
      resetAttendeeResponses: op.transition === 'reschedule',
    };
    const existingIds =
      (logRow.partialGoogleEventIds as Record<string, string>) || current.googleEventIds || {};
    sync = Object.keys(existingIds).length
      ? await updateHoldGoogleEvents(existingIds, googlePayload, {
          ...deps,
          sendUpdates: op.desired.sendUpdates,
        })
      : await createHoldGoogleEvents(googlePayload, {
          ...deps,
          sendUpdates: op.desired.sendUpdates,
        });
  }

  if (sync.state === 'deferred') {
    // Persist partial eventIds and release the worker lease so a retry can immediately reclaim it
    await client.send(
      new UpdateCommand({
        TableName: TABLE_CALENDAR,
        Key: logKey(eventId, operationKey),
        UpdateExpression:
          'SET partialGoogleEventIds = :ids, lastSyncReason = :reason REMOVE leaseToken, leaseUntil',
        ExpressionAttributeValues: { ':ids': sync.eventIds, ':reason': sync.reason },
      }),
    );
    await client.send(
      new UpdateCommand({
        TableName: TABLE_CALENDAR,
        Key: eventKey(eventId),
        UpdateExpression: 'SET googleEventIds = :ids, googleSync = :gs',
        ExpressionAttributeValues: {
          ':ids': sync.eventIds,
          ':gs': { state: 'deferred', reason: sync.reason },
        },
      }),
    );
    await client.send(
      new UpdateCommand({
        TableName: TABLE_CARDS,
        Key: cardKey(current.cardId),
        UpdateExpression: 'SET eventTime.#sync = :deferred, eventTime.reason = :reason, eventTime.googleEventIds = :ids',
        ExpressionAttributeNames: { '#sync': 'sync' },
        ExpressionAttributeValues: {
          ':deferred': 'deferred',
          ':reason': sync.reason,
          ':ids': sync.eventIds,
        },
      }),
    );
    return { sync, emailReceipts };
  }

  // Reconcile transition emails with receipt durability before send
  for (let index = 0; index < op.desired.emails.length; index++) {
    const templateEmail = op.desired.emails[index];
    if (!templateEmail.to.length) continue;
    const existingReceipt = emailReceipts[index];
    if (existingReceipt?.state === 'sent') continue;
    if (
      (existingReceipt?.state === 'dispatching' || existingReceipt?.state === 'outcome-unknown') &&
      !options.forceEmailRetry
    ) {
      await client.send(
        new UpdateCommand({
          TableName: TABLE_CALENDAR,
          Key: logKey(eventId, operationKey),
          UpdateExpression: 'SET operation.#state = :unknown REMOVE leaseToken, leaseUntil',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: { ':unknown': 'outcome-unknown' },
        }),
      );
      return {
        sync: {
          state: 'deferred',
          reason: existingReceipt.error || 'Email delivery outcome is unknown; verify before forcing retry.',
          eventIds: sync.eventIds,
        },
        emailReceipts,
      };
    }

    const dispatchTime = new Date().toISOString();
    emailReceipts[index] = { state: 'dispatching', at: dispatchTime };
    await client.send(
      new UpdateCommand({
        TableName: TABLE_CALENDAR,
        Key: logKey(eventId, operationKey),
        UpdateExpression: 'SET emailReceipts = :receipts',
        ExpressionAttributeValues: { ':receipts': emailReceipts },
      }),
    );

    try {
      const sent = await sendTransitionEmail(templateEmail);
      emailReceipts[index] = { state: 'sent', messageId: sent.messageId, at: new Date().toISOString() };
      await client.send(
        new UpdateCommand({
          TableName: TABLE_CALENDAR,
          Key: logKey(eventId, operationKey),
          UpdateExpression: 'SET emailReceipts = :receipts',
          ExpressionAttributeValues: { ':receipts': emailReceipts },
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Transition email failed';
      emailReceipts[index] = { state: 'outcome-unknown', at: new Date().toISOString(), error: message };
      await client.send(
        new UpdateCommand({
          TableName: TABLE_CALENDAR,
          Key: logKey(eventId, operationKey),
          UpdateExpression:
            'SET emailReceipts = :receipts, operation.#state = :unknown REMOVE leaseToken, leaseUntil',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: { ':receipts': emailReceipts, ':unknown': 'outcome-unknown' },
        }),
      );
      return {
        sync: { state: 'deferred', reason: message, eventIds: sync.eventIds },
        emailReceipts,
      };
    }
  }

  const finalEventIds = op.transition === 'release' ? {} : sync.eventIds;
  const completeTime = new Date().toISOString();
  await completeEventOperation(client, current, operationKey, lease, finalEventIds, completeTime);

  // Record acceptance baseline on proposed holds and clear stale decline markers on new proposal/reschedule
  if (op.transition === 'propose' || op.transition === 'reschedule') {
    await client.send(
      new UpdateCommand({
        TableName: TABLE_CALENDAR,
        Key: eventKey(eventId),
        UpdateExpression:
          'SET acceptanceBaseline = :baseline, googleSync = :gs REMOVE attendeeResponses, declinedBy',
        ExpressionAttributeValues: {
          ':baseline': {
            generation: current.generation,
            organizerEventId: finalEventIds[HOLD_ORGANIZER] || '',
            startIso: op.desired.startIso,
            endIso: op.desired.endIso,
            guestEmails: current.guestEmails,
            recordedAt: completeTime,
          },
          ':gs': { state: 'synced' },
        },
      }),
    );
  } else {
    await client.send(
      new UpdateCommand({
        TableName: TABLE_CALENDAR,
        Key: eventKey(eventId),
        UpdateExpression: 'SET googleSync = :gs',
        ExpressionAttributeValues: { ':gs': { state: 'synced' } },
      }),
    );
  }

  // Update Card calendarInvites & guestEmails and close invite tasks when approved
  const card = await getCardConsistent(client, current.cardId);
  if (card) {
    const updatedCard = await updateCardAdditive(client, card, (latestCard) => {
      if (op.transition === 'release') {
        return { calendarInvites: [] };
      }
      const invites = [...(latestCard.calendarInvites || [])];
      for (const [calendar, gEventId] of Object.entries(finalEventIds)) {
        const idx = invites.findIndex((i) => i.calendar === calendar && i.eventId === gEventId);
        const entry = {
          calendar,
          eventId: gEventId,
          url: calendarInviteUrl(calendar, gEventId),
          label: current!.status === 'approved' ? op.desired.summary : `${op.desired.summary}`,
          createdAt: completeTime,
          createdBy: actor,
        };
        if (idx < 0) invites.push(entry);
        else invites[idx] = { ...invites[idx], url: entry.url, label: entry.label };
      }
      return {
        calendarInvites: invites,
        ...(current!.guestEmails.length ? { guestEmails: current!.guestEmails } : {}),
      };
    });
    if (current.status === 'approved') {
      await closeCardInviteTasks(client, updatedCard, actor);
    }
  }

  return { sync: { state: 'synced', eventIds: finalEventIds }, emailReceipts };
}

export interface EventTransitionInput {
  date?: string;
  time?: string;
  timeZone?: string;
  durationMinutes?: number;
  /** Internal explicit manual policy, persisted on the Event rather than its Template. */
  manualPolicy?: EventPolicy;
  window?: string;
  title?: string;
  topic?: string;
  guestNames?: string;
  guestTimezone?: string;
  guestEmails?: string[];
  documentUrl?: string;
  operationKey?: string;
  actor?: string;
  now?: string;
  deps?: HoldGoogleDeps;
  approval?: EventCommand['approval'];
  /** Internal creation orchestration: one skipEmail suppresses both outbound channels. */
  suppressGuestNotifications?: boolean;
  /** Bind an external guest action to the exact proposal they saw. */
  expectedEventVersion?: number;
}

async function runTransition(
  client: DynamoDBDocumentClient,
  transition: EventOperationTransition,
  targetId: string,
  input: EventTransitionInput = {},
): Promise<EventLifecycleResult> {
  const actor = input.actor || 'authenticated-operator';
  const now = input.now || new Date().toISOString();
  const { card, episode, event: current, holdId } = await resolveEventTarget(client, targetId);
  if (input.expectedEventVersion !== undefined && current?.version !== input.expectedEventVersion) throw new EventConflictError('The proposal changed; reload the guest form before accepting a time');
  const deps = input.deps || (await calendarInviteDeps({}, client));

  // If the same operationKey was already committed and is pending/deferred, reconcile it
  const operationKey =
    input.operationKey ||
    `${transition}-${holdId}-v${current?.version ?? 0}-${randomUUID().slice(0, 8)}`;

  if (current) {
    const existingOp = current.operations.find((o) => o.key === operationKey);
    if (existingOp) {
      const reconciled = await reconcileEventOperation(client, current.id, operationKey, deps, actor);
      const task = existingOp.transition === 'reschedule'
        ? await ensureEventRescheduleTask(client, {
          sourceKey: `${current.id}:${operationKey}`,
          title: existingOp.desired.summary,
          date: current.date,
          actorId: actor,
        })
        : null;
      const result = await buildResult(client, current.id, card.id, reconciled.sync, reconciled.emailReceipts);
      return task ? { ...result, rescheduleTaskId: task.id } : result;
    }
  }

  let command: EventCommand;
  if (transition === 'propose' || transition === 'reschedule') {
    const { templateId, templateVersion, policy } = input.manualPolicy
      ? { templateId: card.templateId, templateVersion: card.templateVersion || 1, policy: parseEventPolicy(input.manualPolicy) }
      : await resolveCardEventPolicy(client, card);
    if (input.durationMinutes !== undefined && input.durationMinutes !== policy.durationMinutes) throw new EventInputError('duration conflicts with the configured event policy');
    // Newly proposed events use the current label; existing records keep their saved policy until a transition.
    policy.titles.proposed = '[Proposed] ' + policy.titles.proposed.replace(/^(?:\(Proposal\)|\[Proposed\])\s*/i, '');
    if (input.suppressGuestNotifications) {
      policy.guests.proposal = false;
      policy.calendarAcceptance.enabled = false;
      policy.notifications.propose.calendar = 'none';
      policy.notifications.reschedule.calendar = 'none';
      policy.notifications.propose.emails = [];
      policy.notifications.reschedule.emails = [];
    } else if (input.guestEmails?.length) {
      policy.guests.proposal = true;
      policy.calendarAcceptance.enabled = true;
      policy.notifications.propose.calendar = 'all';
    }
    const guestEmails = await resolveProposalGuests(
      client,
      card,
      episode,
      current,
      input.guestEmails,
      policy,
    );
    const title =
      input.title?.trim() ||
      current?.renderValues?.title ||
      card.title ||
      episode?.title ||
      'DataTalks.Club Event';
    const topic =
      input.topic?.trim() ||
      current?.renderValues?.topic ||
      episode?.title ||
      card.description ||
      title;
    const guestNames =
      input.guestNames?.trim() ||
      (card.people?.length
        ? card.people.join(', ')
        : episode?.guests?.map((g) => g.name).join(', ') || current?.renderValues?.guestNames || '');
    const documentUrl =
      input.documentUrl !== undefined
        ? input.documentUrl
        : current?.renderValues?.documentUrl || cardGuestDocument(card) || '';

    let time = input.time;
    let proposalDate = input.date || current?.date || card.anchorDate;
    if (time && proposalDate && input.timeZone && input.timeZone !== policy.timeZone) {
      let instant: ReturnType<typeof cardEventInterval>;
      try { instant = cardEventInterval(`${proposalDate} ${time}`, policy.durationMinutes, input.timeZone); } catch (error) { throw new EventInputError((error as Error).message); }
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: policy.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant.startIso)).map(p => [p.type,p.value]));
      proposalDate = `${p.year}-${p.month}-${p.day}`; time = `${p.hour}:${p.minute}`;
    }
    const window =
      input.window !== undefined
        ? input.window
        : time === undefined
          ? Object.keys(policy.windows)[0]
          : undefined;

    command = {
      transition,
      operationKey,
      expectedVersion: current?.version ?? 0,
      actor,
      now,
      date: proposalDate,
      ...(time !== undefined ? { time } : {}),
      ...(window !== undefined ? { window } : {}),
      proposal: {
        templateId,
        templateVersion,
        policy,
        title,
        topic,
        guestNames,
        documentUrl,
        guestEmails,
        ...(input.guestTimezone ? { guestTimezone: input.guestTimezone } : {}),
      },
    };
  } else if (transition === 'update') {
    if (!current) {
      throw new EventConflictError('Propose an event before updating its metadata');
    }
    if (
      input.date !== undefined ||
      input.time !== undefined ||
      input.window !== undefined ||
      input.durationMinutes !== undefined ||
      input.timeZone !== undefined ||
      input.guestEmails !== undefined
    ) {
      throw new EventInputError(
        'event update only reconciles metadata (title, topic, guestNames, documentUrl, Zoom); use reschedule to change date, time, or attendees.',
      );
    }
    const title =
      input.title?.trim() ||
      card.title?.trim() ||
      current.renderValues.title ||
      episode?.title ||
      'DataTalks.Club Event';
    const topic =
      input.topic?.trim() ||
      (current.renderValues.topic === current.renderValues.title
        ? title
        : current.renderValues.topic || title);
    const guestNames =
      input.guestNames?.trim() ||
      current.renderValues.guestNames ||
      (card.people?.length
        ? card.people.join(', ')
        : episode?.guests?.map((g) => g.name).join(', ') || '');
    const documentUrl =
      input.documentUrl !== undefined
        ? input.documentUrl
        : current.renderValues.documentUrl || cardGuestDocument(card) || '';
    command = {
      transition: 'update',
      operationKey,
      expectedVersion: current.version,
      actor,
      now,
      metadata: {
        title,
        topic,
        guestNames,
        documentUrl,
      },
    };
  } else {
    if (!current) {
      throw new EventConflictError('Propose an event before approving or releasing it');
    }
    // Allow supplying guestEmails or documentUrl right before approve if not set during propose
    if (transition === 'approve' && (input.guestEmails?.length || input.documentUrl !== undefined)) {
      const updatedGuests = input.guestEmails?.length
        ? parseCardGuests(input.guestEmails)
        : current.guestEmails;
      const updatedDocUrl =
        input.documentUrl !== undefined ? input.documentUrl : current.renderValues.documentUrl;
      current.guestEmails = updatedGuests;
      current.renderValues = { ...current.renderValues, documentUrl: updatedDocUrl };
    }
    command = {
      transition,
      operationKey,
      expectedVersion: current.version,
      actor,
      now,
      ...(input.approval ? { approval: input.approval } : {}),
    };
  }

  let planned: EventRecord;
  try {
    planned = planEventTransition(holdId, card.id, current, command);
  } catch (err) {
    if (err instanceof EventConflictError) throw err;
    throw new EventInputError(err instanceof Error ? err.message : 'Invalid event transition');
  }

  // Idempotent no-op (e.g. already approved or already released, or repeated operationKey)
  if (current && planned.version === current.version) {
    const latestOp = planned.operations.at(-1);
    if (latestOp && latestOp.state !== 'complete') {
      const reconciled = await reconcileEventOperation(client, planned.id, latestOp.key, deps, actor);
      return buildResult(client, planned.id, card.id, reconciled.sync, reconciled.emailReceipts);
    }
    return buildResult(
      client,
      planned.id,
      card.id,
      { state: 'synced', eventIds: planned.googleEventIds },
      {},
    );
  }

  const freshCard = await getCardConsistent(client, card.id);
  if (!freshCard) throw new EventNotFoundError(`Card '${card.id}' not found.`);
  const freshEpisode = episode ? await getPodcastEpisode(client, episode.id) : null;
  const relatedWrites = buildEpisodeTransactionWrite(freshEpisode, planned, now);
  const checklist = transition === 'reschedule'
    ? await loadTaskChecklistDefinition(EVENT_RESCHEDULE_CHECKLIST_ID)
    : undefined;

  await commitEventTransition(client, freshCard, current?.version ?? 0, planned, relatedWrites);

  const rescheduleTask = transition === 'reschedule'
    ? await ensureEventRescheduleTask(client, {
      sourceKey: `${planned.id}:${operationKey}`,
      title: String(planned.renderValues.title || card.title || 'Event'),
      date: planned.date,
      actorId: actor,
      checklist,
    })
    : null;

  const reconciled = await reconcileEventOperation(
    client,
    planned.id,
    planned.operations.at(-1)!.key,
    deps,
    actor,
  );
  const result = await buildResult(client, planned.id, card.id, reconciled.sync, reconciled.emailReceipts);
  return rescheduleTask ? { ...result, rescheduleTaskId: rescheduleTask.id } : result;
}

async function buildResult(
  client: DynamoDBDocumentClient,
  holdId: string,
  cardId: string,
  sync: { state: 'synced' | 'deferred'; reason?: string; eventIds: Record<string, string> },
  emailReceipts: Record<number, EventEmailReceipt>,
): Promise<EventLifecycleResult> {
  const event = (await getEventRecord(client, holdId))!;
  const history = await getEventHistory(client, holdId);
  const card = (await getCardConsistent(client, cardId))!;
  const episode = await findEpisodeForCard(client, cardId);
  const rawHold = (
    await client.send(new GetCommand({ TableName: TABLE_CALENDAR, Key: eventKey(holdId), ConsistentRead: true }))
  ).Item;
  return {
    event: { ...event, history },
    history,
    card,
    episode,
    sync,
    emailReceipts,
    ...(rawHold?.attendeeResponses
      ? { attendeeResponses: rawHold.attendeeResponses as Record<string, string> }
      : {}),
    ...(rawHold?.declinedBy
      ? { declinedBy: rawHold.declinedBy as Array<{ email: string; at: string }> }
      : {}),
  };
}

async function explicitManualTransition(client: DynamoDBDocumentClient, transition: 'propose' | 'reschedule', targetId: string, input: EventTransitionInput) {
  const { card, event: current } = await resolveEventTarget(client, targetId);
  try { await resolveCardEventPolicy(client, card); return runTransition(client, transition, targetId, input); }
  catch (error) {
    if (!(error instanceof EventInputError && error.message.includes('does not declare an eventPolicy'))) throw error;
  }
  if (!current && (!input.date || !input.time || !input.guestEmails?.length)) throw new EventInputError('An unconfigured Card needs --date, --time, --duration and --guest-emails for an explicit Calendar-only blocker');
  let policy: EventPolicy;
  try { policy = current?.policy || manualCalendarPolicy(input.durationMinutes, input.timeZone || 'Europe/Berlin'); }
  catch (error) { throw new EventInputError((error as Error).message); }
  if (input.durationMinutes !== undefined && input.durationMinutes !== policy.durationMinutes) throw new EventInputError('duration conflicts with the saved event policy');
  const date = input.date || current?.date;
  const time = input.time || (input.window ? policy.windows[input.window] : current?.time);
  if (!date || !time) throw new EventInputError('Supply --date and --time for this Calendar-only blocker');
  const owner = `manual-${randomUUID()}`;
  if (!await claimGuestSlotAllocator(client, owner)) throw new EventConflictError('Another event is reserving a time; retry shortly');
  try {
    const check = { cardId: card.id, type: 'manual-calendar-blocker', requestedDate: date, requestedTime: time, timeZone: input.timeZone || policy.timeZone } as GuestIntakeJob;
    const slots = await guestEventSlots(client, check, policy, 1).catch(error => { throw new EventInputError((error as Error).message); });
    if (!slots.length) throw new EventInputError('The requested Calendar interval is unavailable');
    // Normalize the explicit instant to the persisted policy zone without moving it.
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: policy.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(slots[0].startIso)).map(p => [p.type,p.value]));
    return await runTransition(client, transition, targetId, { ...input, date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, window: undefined, timeZone: policy.timeZone, manualPolicy: policy });
  } finally { await releaseAllocator(client, owner); }
}

export async function proposeEvent(
  client: DynamoDBDocumentClient,
  targetId: string,
  input: EventTransitionInput,
): Promise<EventLifecycleResult> {
  const { event: current, card } = await resolveEventTarget(client, targetId);
  // If an active event is in 'proposed' or 'approved' and has a deferred operation, allow retry if same slot; otherwise require reschedule
  if (current && current.status !== 'released') {
    throw new EventConflictError(
      `Card '${card.id}' already has an active event (${current.id}, status=${current.status}). Use reschedule to change its date/time.`,
    );
  }
  return explicitManualTransition(client, 'propose', targetId, input);
}

export async function approveEvent(
  client: DynamoDBDocumentClient,
  targetId: string,
  input: EventTransitionInput = {},
): Promise<EventLifecycleResult> {
  const result = await runTransition(client, 'approve', targetId, input);
  if (result.event.status === 'approved') await resolveGuestAcceptanceTask(client, result.card.id, result.event.id, input.actor || 'authenticated-operator');
  return result;
}

export async function rescheduleEvent(
  client: DynamoDBDocumentClient,
  targetId: string,
  input: EventTransitionInput,
): Promise<EventLifecycleResult> {
  const { event: current } = await resolveEventTarget(client, targetId);
  if (!current || current.status === 'released') {
    return explicitManualTransition(client, 'propose', targetId, input);
  }
  return explicitManualTransition(client, 'reschedule', targetId, input);
}

export async function releaseEvent(
  client: DynamoDBDocumentClient,
  targetId: string,
  input: EventTransitionInput = {},
): Promise<EventLifecycleResult> {
  return runTransition(client, 'release', targetId, input);
}

export async function updateEvent(
  client: DynamoDBDocumentClient,
  targetId: string,
  input: EventTransitionInput = {},
): Promise<EventLifecycleResult> {
  return runTransition(client, 'update', targetId, input);
}

export async function retryEventOperation(
  client: DynamoDBDocumentClient,
  targetId: string,
  input: { operationKey?: string; forceEmailRetry?: boolean; actor?: string; deps?: HoldGoogleDeps } = {},
): Promise<EventLifecycleResult> {
  const { card, event } = await resolveEventTarget(client, targetId);
  if (!event) throw new EventNotFoundError(`No event exists for '${targetId}'.`);
  const opKey = input.operationKey || event.operations.at(-1)?.key;
  if (!opKey) throw new EventInputError(`Event '${event.id}' has no operations to retry.`);
  const op = event.operations.find((operation) => operation.key === opKey);
  if (!op) throw new EventInputError(`Operation '${opKey}' does not exist for event '${event.id}'.`);
  const deps = input.deps || (await calendarInviteDeps({}, client));
  const actor = input.actor || 'authenticated-operator';
  const reconciled = await reconcileEventOperation(client, event.id, opKey, deps, actor, {
    forceEmailRetry: input.forceEmailRetry,
  });
  const task = op.transition === 'reschedule'
    ? await ensureEventRescheduleTask(client, {
      sourceKey: `${event.id}:${opKey}`,
      title: op.desired.summary,
      date: event.date,
      actorId: actor,
    })
    : null;
  const result = await buildResult(client, event.id, card.id, reconciled.sync, reconciled.emailReceipts);
  return task ? { ...result, rescheduleTaskId: task.id } : result;
}

export async function getEventDetail(
  client: DynamoDBDocumentClient,
  targetId: string,
): Promise<EventLifecycleResult> {
  const { card, event } = await resolveEventTarget(client, targetId);
  if (!event) throw new EventNotFoundError(`No event exists for '${targetId}'.`);
  const latestOp = event.operations.at(-1);
  const rawHold = (
    await client.send(new GetCommand({ TableName: TABLE_CALENDAR, Key: eventKey(event.id), ConsistentRead: true }))
  ).Item;
  const rawOp = latestOp
    ? (
        await client.send(
          new GetCommand({ TableName: TABLE_CALENDAR, Key: logKey(event.id, latestOp.key), ConsistentRead: true }),
        )
      ).Item
    : undefined;
  const gs = (rawHold?.googleSync as { state?: 'synced' | 'deferred'; reason?: string } | undefined) || {
    state: latestOp?.state === 'complete' ? 'synced' : 'deferred',
  };
  return buildResult(
    client,
    event.id,
    card.id,
    {
      state: gs.state === 'deferred' ? 'deferred' : 'synced',
      ...(gs.reason ? { reason: gs.reason } : {}),
      eventIds: event.googleEventIds,
    },
    (rawOp?.emailReceipts as Record<number, EventEmailReceipt>) || {},
  );
}

export interface CalendarAcceptancePollOutcome {
  holdId: string;
  cardId: string;
  status: EventRecord['status'];
  action: 'approved' | 'declined' | 'pending' | 'noop' | 'deferred';
  acceptedEmails?: string[];
  declinedEmails?: string[];
  reason?: string;
}

/**
 * Poll Google Calendar organizer events for proposed holds with calendarAcceptance.enabled.
 * Automatically approves when guest acceptance quorum is met (idempotent) and records declines without releasing.
 */
export async function pollEventCalendarAcceptances(
  client: DynamoDBDocumentClient,
  options: { targetId?: string; deps?: HoldGoogleDeps; now?: string; automaticOnly?: boolean } = {},
): Promise<{ checked: number; outcomes: CalendarAcceptancePollOutcome[] }> {
  const deps = options.deps || (await calendarInviteDeps({}, client));
  const now = options.now || new Date().toISOString();
  const candidates: EventRecord[] = [];

  if (options.targetId) {
    const { event } = await resolveEventTarget(client, options.targetId);
    if (!event) throw new EventNotFoundError(`No event exists for '${options.targetId}'.`);
    candidates.push(event);
  } else {
    const scan = await client.send(
      new ScanCommand({
        TableName: TABLE_CALENDAR,
        FilterExpression: 'begins_with(PK, :prefix) AND #status = :proposed',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':prefix': 'CALHOLD#', ':proposed': 'proposed' },
        ConsistentRead: true,
      }),
    );
    for (const item of scan.Items || []) {
      if (typeof item.id === 'string' && Number.isInteger(item.generation)) {
        const record = await getEventRecord(client, item.id);
        if (record) candidates.push(record);
      }
    }
  }

  const outcomes: CalendarAcceptancePollOutcome[] = [];
  for (const record of candidates) {
    if (options.automaticOnly && record.autoAcceptancePoll !== true) continue;
    if (record.status !== 'proposed') {
      outcomes.push({
        holdId: record.id,
        cardId: record.cardId,
        status: record.status,
        action: 'noop',
      });
      continue;
    }
    if (!record.policy.calendarAcceptance.enabled) {
      outcomes.push({
        holdId: record.id,
        cardId: record.cardId,
        status: record.status,
        action: 'noop',
        reason: 'calendarAcceptance is disabled on this Template',
      });
      continue;
    }
    if (record.operations.some((o) => o.state !== 'complete')) {
      outcomes.push({
        holdId: record.id,
        cardId: record.cardId,
        status: record.status,
        action: 'deferred',
        reason: 'Event operation is still pending reconciliation',
      });
      continue;
    }
    const organizerEventId = record.googleEventIds[HOLD_ORGANIZER];
    if (!organizerEventId) {
      outcomes.push({
        holdId: record.id,
        cardId: record.cardId,
        status: record.status,
        action: 'deferred',
        reason: 'No organizer Google Calendar event id recorded yet',
      });
      continue;
    }

    const fetched = await fetchGoogleEvent(organizerEventId, HOLD_ORGANIZER, deps);
    if (fetched.state === 'deferred') {
      outcomes.push({
        holdId: record.id,
        cardId: record.cardId,
        status: record.status,
        action: 'deferred',
        reason: fetched.reason,
      });
      continue;
    }
    if (fetched.state === 'gone') {
      outcomes.push({
        holdId: record.id,
        cardId: record.cardId,
        status: record.status,
        action: 'deferred',
        reason: 'Organizer Google Calendar event is cancelled or gone',
      });
      continue;
    }

    const live = fetched.event;

    const priv = live.extendedProperties?.private;
    if (priv) {
      if (priv.dataopsHoldId && priv.dataopsHoldId !== record.id) {
        outcomes.push({
          holdId: record.id,
          cardId: record.cardId,
          status: record.status,
          action: 'noop',
          reason: 'Organizer event hold identity mismatch',
        });
        continue;
      }
      if (priv.dataopsGeneration && Number(priv.dataopsGeneration) !== record.generation) {
        outcomes.push({
          holdId: record.id,
          cardId: record.cardId,
          status: record.status,
          action: 'noop',
          reason: `Stale organizer event generation (${priv.dataopsGeneration} !== ${record.generation})`,
        });
        continue;
      }
    }

    const desiredInterval = record.operations.at(-1)?.desired;
    if ((live.start?.dateTime && Date.parse(live.start.dateTime) !== Date.parse(desiredInterval?.startIso || record.startIso))
      || (live.end?.dateTime && Date.parse(live.end.dateTime) !== Date.parse(desiredInterval?.endIso || record.endIso))) {
      outcomes.push({
        holdId: record.id,
        cardId: record.cardId,
        status: record.status,
        action: 'noop',
        reason: 'Organizer event start time does not match current proposal interval',
      });
      continue;
    }

    const responseMap: Record<string, string> = {};
    for (const attendee of live.attendees || []) {
      if (attendee.email && attendee.responseStatus) {
        responseMap[attendee.email.trim().toLowerCase()] = attendee.responseStatus;
      }
    }

    const acceptedEmails = record.guestEmails.filter((g) => responseMap[g] === 'accepted');
    const declinedEmails = record.guestEmails.filter((g) => responseMap[g] === 'declined');

    // Record attendeeResponses and any declines without releasing
    if (declinedEmails.length > 0) {
      const declinedEntries = declinedEmails.map((email) => ({ email, at: now }));
      await client.send(
        new UpdateCommand({
          TableName: TABLE_CALENDAR,
          Key: eventKey(record.id),
          UpdateExpression: 'SET attendeeResponses = :responses, declinedBy = :declined',
          ExpressionAttributeValues: {
            ':responses': responseMap,
            ':declined': declinedEntries,
          },
        }),
      );
    } else if (Object.keys(responseMap).length > 0) {
      await client.send(
        new UpdateCommand({
          TableName: TABLE_CALENDAR,
          Key: eventKey(record.id),
          UpdateExpression: 'SET attendeeResponses = :responses',
          ExpressionAttributeValues: { ':responses': responseMap },
        }),
      );
    }

    const quorumMet =
      record.policy.calendarAcceptance.quorum === 'all'
        ? record.guestEmails.length > 0 && record.guestEmails.every((g) => acceptedEmails.includes(g))
        : record.guestEmails.some((g) => acceptedEmails.includes(g));

    if (quorumMet) {
      const primaryAttendee = acceptedEmails[0];
      const opKey = `calendar-accept-${record.id}-gen-${record.generation}`;
      const approved = await approveEvent(client, record.cardId, {
        operationKey: opKey,
        actor: `calendar-accept:${primaryAttendee}`,
        now,
        deps,
        approval: {
          via: 'calendar-accept',
          attendeeEmail: primaryAttendee,
          acceptedEmails,
          generation: record.generation,
        },
      });
      outcomes.push({
        holdId: record.id,
        cardId: record.cardId,
        status: approved.event.status,
        action: 'approved',
        acceptedEmails,
      });
      continue;
    }

    if (declinedEmails.length > 0) {
      outcomes.push({
        holdId: record.id,
        cardId: record.cardId,
        status: record.status,
        action: 'declined',
        declinedEmails,
      });
      continue;
    }

    outcomes.push({
      holdId: record.id,
      cardId: record.cardId,
      status: record.status,
      action: 'pending',
    });
  }

  return { checked: outcomes.length, outcomes };
}

/** Format an EventLifecycleResult into a legacy-compatible CalendarHold view for existing callers. */
export function toCalendarHoldView(result: EventLifecycleResult) {
  const { event, sync } = result;
  const legacyStatus =
    event.status === 'approved' ? 'confirmed' : event.status === 'proposed' ? 'tentative' : 'released';
  const windowName =
    Object.entries(event.policy.windows).find(([, t]) => t === event.time)?.[0] || 'midday';
  const latestOp = event.operations.at(-1);
  return {
    id: event.id,
    status: legacyStatus,
    lifecycleStatus: event.status,
    generation: event.generation,
    identityGeneration: event.identityGeneration,
    date: event.date,
    time: event.time,
    window: windowName,
    startIso: event.startIso,
    endIso: event.endIso,
    durationMinutes: event.durationMinutes,
    timeZone: event.timeZone,
    title: event.renderValues.title,
    topic: event.renderValues.topic,
    googleTitle: latestOp?.desired.summary || event.renderValues.title,
    cardId: event.cardId,
    guestRef: event.guestEmails[0],
    guestEmails: event.guestEmails,
    documentUrl: event.renderValues.documentUrl || undefined,
    expiresAt: event.expiresAt,
    googleEventIds: event.googleEventIds,
    googleSync:
      sync.state === 'synced'
        ? { state: 'synced' as const }
        : { state: 'deferred' as const, reason: sync.reason || 'Deferred' },
    history: result.history,
    attendeeResponses: result.attendeeResponses,
    declinedBy: result.declinedBy,
    version: event.version,
  };
}
