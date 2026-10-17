/**
 * Workspace settings: one record in the Users table, next to the accounts it
 * refers to. An admin sets them; nothing here is hardcoded in the code that
 * reads them.
 *
 * - `defaultAssigneeId`: the team member new work goes to when nothing more
 *   specific names a person (a Template Task with its own assignee, a
 *   recurring schedule with one, or a name in an imported title).
 * - `newsletterCardLeadDays`: how many days before a newsletter issue goes
 *   out the daily run creates its Card (earlier when the Template has a Task
 *   due further ahead, so no Task is born overdue).
 * - `sponsorMaterialsReminderDays`: the days before a sponsor publication on
 *   which the daily run alerts about missing materials and drafts a reminder.
 * - `sponsorFollowUpDays`: days after publication when the performance
 *   follow-up becomes due.
 * - `sponsorColdContactDays`: days without inbound or outbound contact after
 *   which an organization or contact of each relationship stage (`talking`,
 *   `customer`, `prospect`, `dormant`) counts as going cold.
 * - `podcastReleaseCadence`: the weekly podcast release moment (weekday, wall
 *   time, timezone). Friday 19:00 Europe/Berlin until an admin changes it.
 * - `podcastEpisodesPerSeason`: episodes in a season before the number rolls
 *   to episode 1 of the next season. 9 until an admin changes it.
 */

import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_USERS } from './tableNames';
import { getFormerUser, getUser } from './users';
import {
  DEFAULT_PODCAST_EPISODES_PER_SEASON,
  DEFAULT_PODCAST_RELEASE_CADENCE,
  MAX_PODCAST_EPISODES_PER_SEASON,
  normalizeCadence,
  normalizeEpisodesPerSeason,
  type PodcastReleaseCadence,
} from '../podcast/releaseSlots';

const SETTINGS_KEY = { PK: 'SETTINGS#workspace', SK: 'SETTINGS#workspace' } as const;

/** `newsletterCardLeadDays` until an admin sets it. */
export const DEFAULT_NEWSLETTER_CARD_LEAD_DAYS = 21;
export const MAX_NEWSLETTER_CARD_LEAD_DAYS = 365;
/** `sponsorMaterialsReminderDays` until an admin sets it. */
export const DEFAULT_SPONSOR_MATERIALS_REMINDER_DAYS: readonly number[] = Object.freeze([14, 10, 3]);
export const MAX_SPONSOR_MATERIALS_REMINDERS = 10;
/** `sponsorFollowUpDays` until an admin sets it. */
export const DEFAULT_SPONSOR_FOLLOW_UP_DAYS = 7;
/** `sponsorColdContactDays` until an admin sets it: active talks go cold fast, past ties slowly. */
export const DEFAULT_SPONSOR_COLD_CONTACT_DAYS = Object.freeze({ talking: 14, customer: 30, prospect: 30, dormant: 90 });
/** Bound on every day count the sponsor settings hold. */
export const MAX_SPONSOR_SETTING_DAYS = 365;

export interface WorkspaceSettings {
  /** Team member who receives new work no one else is named for; null when unset. */
  defaultAssigneeId: string | null;
  /** Days before an issue's date that the daily run creates its Card. */
  newsletterCardLeadDays: number;
  /** Days before a sponsor publication that missing materials are chased, largest first. */
  sponsorMaterialsReminderDays: number[];
  /** Days after publication that the performance follow-up is due. */
  sponsorFollowUpDays: number;
  /** Quiet days after which each relationship stage counts as going cold. */
  sponsorColdContactDays: { talking: number; customer: number; prospect: number; dormant: number };
  /** Weekly podcast release moment; Friday 19:00 Europe/Berlin until set. */
  podcastReleaseCadence: PodcastReleaseCadence;
  /** Episodes per season before the number rolls to the next season. */
  podcastEpisodesPerSeason: number;
  /** 0 until the record is first written. */
  version: number;
  updatedAt?: string;
  updatedBy?: string;
}

export class WorkspaceSettingsConflictError extends Error {
  constructor(readonly expectedVersion: number) {
    super(`Workspace settings changed since version ${expectedVersion}`);
    this.name = 'WorkspaceSettingsConflictError';
  }
}

export async function getWorkspaceSettings(client: DynamoDBDocumentClient): Promise<WorkspaceSettings> {
  const result = await client.send(new GetCommand({
    TableName: TABLE_USERS,
    Key: SETTINGS_KEY,
    ConsistentRead: true,
  }));
  const item = result.Item as Record<string, unknown> | undefined;
  if (!item) {
    return {
      defaultAssigneeId: null,
      newsletterCardLeadDays: DEFAULT_NEWSLETTER_CARD_LEAD_DAYS,
      sponsorMaterialsReminderDays: [...DEFAULT_SPONSOR_MATERIALS_REMINDER_DAYS],
      sponsorFollowUpDays: DEFAULT_SPONSOR_FOLLOW_UP_DAYS,
      sponsorColdContactDays: { ...DEFAULT_SPONSOR_COLD_CONTACT_DAYS },
      podcastReleaseCadence: { ...DEFAULT_PODCAST_RELEASE_CADENCE },
      podcastEpisodesPerSeason: DEFAULT_PODCAST_EPISODES_PER_SEASON,
      version: 0,
    };
  }
  return {
    defaultAssigneeId: typeof item.defaultAssigneeId === 'string' && item.defaultAssigneeId ? item.defaultAssigneeId : null,
    newsletterCardLeadDays: Number.isInteger(item.newsletterCardLeadDays)
      ? Number(item.newsletterCardLeadDays)
      : DEFAULT_NEWSLETTER_CARD_LEAD_DAYS,
    sponsorMaterialsReminderDays: Array.isArray(item.sponsorMaterialsReminderDays)
      ? item.sponsorMaterialsReminderDays.map(Number)
      : [...DEFAULT_SPONSOR_MATERIALS_REMINDER_DAYS],
    sponsorFollowUpDays: Number.isInteger(item.sponsorFollowUpDays)
      ? Number(item.sponsorFollowUpDays)
      : DEFAULT_SPONSOR_FOLLOW_UP_DAYS,
    sponsorColdContactDays: normalizeColdContactDays(item.sponsorColdContactDays),
    podcastReleaseCadence: normalizeCadence(item.podcastReleaseCadence),
    podcastEpisodesPerSeason: normalizeEpisodesPerSeason(item.podcastEpisodesPerSeason),
    version: Number(item.version) || 0,
    ...(typeof item.updatedAt === 'string' ? { updatedAt: item.updatedAt } : {}),
    ...(typeof item.updatedBy === 'string' ? { updatedBy: item.updatedBy } : {}),
  };
}

/** Stored day counts win per stage; anything else falls back to the default stage value. */
function normalizeColdContactDays(value: unknown): { talking: number; customer: number; prospect: number; dormant: number } {
  const record = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const pick = (name: keyof typeof DEFAULT_SPONSOR_COLD_CONTACT_DAYS) =>
    Number.isInteger(record[name]) && Number(record[name]) >= 1 && Number(record[name]) <= MAX_SPONSOR_SETTING_DAYS
      ? Number(record[name])
      : DEFAULT_SPONSOR_COLD_CONTACT_DAYS[name];
  return { talking: pick('talking'), customer: pick('customer'), prospect: pick('prospect'), dormant: pick('dormant') };
}

export type WorkspaceSettingsChanges = Partial<Pick<WorkspaceSettings,
  'defaultAssigneeId' | 'newsletterCardLeadDays' | 'sponsorMaterialsReminderDays' | 'sponsorFollowUpDays' | 'sponsorColdContactDays' | 'podcastReleaseCadence' | 'podcastEpisodesPerSeason'>>;

/** Write `changes` over the current settings, if they are still at `expectedVersion`. */
export async function updateWorkspaceSettings(
  client: DynamoDBDocumentClient,
  input: { changes: WorkspaceSettingsChanges; expectedVersion: number; actorId?: string },
): Promise<WorkspaceSettings> {
  const current = await getWorkspaceSettings(client);
  if (current.version !== input.expectedVersion) throw new WorkspaceSettingsConflictError(input.expectedVersion);
  const next: WorkspaceSettings = {
    defaultAssigneeId: current.defaultAssigneeId,
    newsletterCardLeadDays: current.newsletterCardLeadDays,
    sponsorMaterialsReminderDays: current.sponsorMaterialsReminderDays,
    sponsorFollowUpDays: current.sponsorFollowUpDays,
    sponsorColdContactDays: current.sponsorColdContactDays,
    podcastReleaseCadence: current.podcastReleaseCadence,
    podcastEpisodesPerSeason: current.podcastEpisodesPerSeason,
    ...input.changes,
    version: input.expectedVersion + 1,
    updatedAt: new Date().toISOString(),
    ...(input.actorId ? { updatedBy: input.actorId } : {}),
  };
  try {
    await client.send(new PutCommand({
      TableName: TABLE_USERS,
      Item: { ...SETTINGS_KEY, ...next },
      ConditionExpression: input.expectedVersion === 0
        ? 'attribute_not_exists(PK)'
        : '#version = :expectedVersion',
      ...(input.expectedVersion === 0 ? {} : {
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':expectedVersion': input.expectedVersion },
      }),
    }));
  } catch (error) {
    if ((error as { name?: string })?.name === 'ConditionalCheckFailedException') {
      throw new WorkspaceSettingsConflictError(input.expectedVersion);
    }
    throw error;
  }
  return next;
}

export async function setDefaultAssignee(
  client: DynamoDBDocumentClient,
  input: { defaultAssigneeId: string | null; expectedVersion: number; actorId?: string },
): Promise<WorkspaceSettings> {
  return updateWorkspaceSettings(client, {
    changes: { defaultAssigneeId: input.defaultAssigneeId },
    expectedVersion: input.expectedVersion,
    actorId: input.actorId,
  });
}

/**
 * The default assignee to put on new work, or null. A default who has since
 * been disabled or removed is not assignable, so new work stays unassigned
 * (and visible as such) until an admin picks someone else.
 */
export async function resolveDefaultAssigneeId(client: DynamoDBDocumentClient): Promise<string | null> {
  const { defaultAssigneeId } = await getWorkspaceSettings(client);
  if (!defaultAssigneeId) return null;
  const user = await getUser(client, defaultAssigneeId);
  return user && !user.disabled ? user.id : null;
}

/**
 * Who new work goes to. A person a Template Task or recurring schedule names
 * keeps it, unless they have left: a disabled or deleted person never sees
 * new work, so it goes to the default assignee instead.
 */
export interface AssignmentPolicy {
  defaultAssigneeId: string | null;
  assigneeFor(namedId?: string | null): string | null;
}

/** `namedIds`: the people the work about to be created names. */
export async function loadAssignmentPolicy(
  client: DynamoDBDocumentClient,
  namedIds: Iterable<string | null | undefined>,
): Promise<AssignmentPolicy> {
  const defaultAssigneeId = await resolveDefaultAssigneeId(client);
  const gone = new Set<string>();
  for (const id of new Set([...namedIds].filter((value): value is string => Boolean(value)))) {
    const user = await getUser(client, id);
    if (user ? user.disabled === true : Boolean(await getFormerUser(client, id))) gone.add(id);
  }
  return {
    defaultAssigneeId,
    assigneeFor: (namedId) => (namedId && !gone.has(namedId) ? namedId : defaultAssigneeId),
  };
}
