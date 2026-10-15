/**
 * A person leaving the team: hand over their open work, disable the account,
 * and later delete it.
 *
 * The lifecycle is two steps. Disabling hands the person's open work to
 * someone else, stops them signing in and revokes every credential they hold;
 * nothing new can be assigned to a disabled account. Deleting is only for an
 * account that is already disabled. It removes the account and leaves behind
 * a former-user record that keeps only the id and the display name, so the
 * history that cites the person (who completed a Task, who moved a deal)
 * still reads as a name.
 *
 * "Open work" is everything that would otherwise wait on the person: Tasks in
 * todo or waiting, Cards they own that are not archived, recurring schedules
 * that name them, and sponsor CRM organizations and live deals they own or
 * hold the next action on. Done Tasks, history events and audit rows are the
 * record of what happened and are never rewritten.
 */

import { randomUUID } from 'node:crypto';

import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import type { Card, RecurringConfig, Task, User } from '../types';
import { CardVersionConflictError, getCardConsistent, updateCard } from './cards';
import { usesLocalTransactionEmulation } from './client';
import { readAllPages } from './readAllPages';
import { listRecurringConfigs, updateRecurringConfig } from './recurring';
import {
  getCrmRecord,
  listCrmRecords,
  updateDealAtomic,
  updateOrganizationAtomic,
  type CrmRecord,
} from './sponsorCrm';
import { TABLE_AUDIT_EVENTS, TABLE_CARDS, TABLE_SESSIONS, TABLE_USERS } from './tableNames';
import { getTaskConsistent, listTasksByOwner, TaskVersionConflictError, updateTask } from './tasks';
import { formerUserKey, getUser, listUsers, updateUser } from './users';
import {
  getWorkspaceSettings,
  setDefaultAssignee,
} from './workspaceSettings';

type Dict = Record<string, unknown>;

export interface OpenWork {
  tasks: number;
  cards: number;
  schedules: number;
  sponsorRecords: number;
}

export interface HandoverSummary {
  user: { id: string; name: string; role: User['role'] | null; disabled: boolean };
  openWork: OpenWork;
  /** Sum of `openWork`; zero means nothing has to be handed over. */
  openTotal: number;
  isDefaultAssignee: boolean;
  defaultAssigneeId: string | null;
  /** Settings version, for picking a new default in the same request. */
  defaultAssigneeVersion: number;
}

/** A refused lifecycle step. `code` is stable; the message is for people. */
export class UserLifecycleError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string, readonly details: Dict = {}) {
    super(message);
    this.name = 'UserLifecycleError';
  }
}

const OPEN_TASK_STATUSES = new Set(['todo', 'waiting']);
const LIVE_DEAL_STATUSES = new Set(['open', 'agreed']);

function displayName(user: Pick<User, 'id' | 'name' | 'email'>): string {
  return user.name || user.email || user.id;
}

function isActiveMember(user: User | null): user is User {
  return Boolean(user && !user.disabled && (user.role === 'admin' || user.role === 'operator'));
}

// --- what the person holds -------------------------------------------------

async function openTasksOf(client: DynamoDBDocumentClient, userId: string): Promise<Task[]> {
  return (await listTasksByOwner(client, { kind: 'user', userId }))
    .filter((task) => OPEN_TASK_STATUSES.has(task.status));
}

async function openCardsOf(client: DynamoDBDocumentClient, userId: string): Promise<Card[]> {
  const items = await readAllPages(client, (exclusiveStartKey) => new ScanCommand({
    TableName: TABLE_CARDS,
    FilterExpression: 'begins_with(PK, :prefix) AND ownerId = :ownerId',
    ExpressionAttributeValues: { ':prefix': 'CARD#', ':ownerId': userId },
    ExclusiveStartKey: exclusiveStartKey,
  }));
  return items
    .map(({ PK: _pk, SK: _sk, ...card }) => card as unknown as Card)
    .filter((card) => card.status !== 'archived');
}

async function schedulesOf(client: DynamoDBDocumentClient, userId: string): Promise<RecurringConfig[]> {
  return (await listRecurringConfigs(client)).filter((config) => config.assigneeId === userId);
}

function dealHeldBy(deal: CrmRecord, userId: string): boolean {
  if (!LIVE_DEAL_STATUSES.has(String(deal.status || ''))) return false;
  const nextAction = deal.nextAction as { owner?: unknown } | null | undefined;
  return deal.owner === userId || nextAction?.owner === userId;
}

async function sponsorRecordsOf(client: DynamoDBDocumentClient, userId: string) {
  const [organizations, deals] = await Promise.all([
    listCrmRecords(client, 'organization'),
    listCrmRecords(client, 'deal'),
  ]);
  return {
    organizations: organizations.filter((organization) => organization.owner === userId),
    deals: deals.filter((deal) => dealHeldBy(deal, userId)),
  };
}

async function openWorkOf(client: DynamoDBDocumentClient, userId: string): Promise<OpenWork> {
  const [tasks, cards, schedules, sponsor] = await Promise.all([
    openTasksOf(client, userId),
    openCardsOf(client, userId),
    schedulesOf(client, userId),
    sponsorRecordsOf(client, userId),
  ]);
  return {
    tasks: tasks.length,
    cards: cards.length,
    schedules: schedules.length,
    sponsorRecords: sponsor.organizations.length + sponsor.deals.length,
  };
}

function total(work: OpenWork): number {
  return work.tasks + work.cards + work.schedules + work.sponsorRecords;
}

async function requireUser(client: DynamoDBDocumentClient, userId: string): Promise<User> {
  const user = await getUser(client, userId);
  if (!user) throw new UserLifecycleError(404, 'user_not_found', 'User not found');
  return user;
}

export async function summarizeHandover(client: DynamoDBDocumentClient, userId: string): Promise<HandoverSummary> {
  const user = await requireUser(client, userId);
  const [openWork, settings] = await Promise.all([openWorkOf(client, userId), getWorkspaceSettings(client)]);
  return {
    user: { id: user.id, name: displayName(user), role: user.role || null, disabled: user.disabled === true },
    openWork,
    openTotal: total(openWork),
    isDefaultAssignee: settings.defaultAssigneeId === userId,
    defaultAssigneeId: settings.defaultAssigneeId,
    defaultAssigneeVersion: settings.version,
  };
}

// --- handing it over -------------------------------------------------------

async function requireRecipient(client: DynamoDBDocumentClient, fromId: string, toId: unknown, field: string): Promise<User> {
  if (typeof toId !== 'string' || !toId.trim()) {
    throw new UserLifecycleError(400, 'recipient_required', `${field} must name the active team member who takes over`);
  }
  if (toId.trim() === fromId) {
    throw new UserLifecycleError(400, 'recipient_is_same_user', `${field} must be someone else`);
  }
  const recipient = await getUser(client, toId.trim());
  if (!isActiveMember(recipient)) {
    throw new UserLifecycleError(400, 'recipient_not_active', `${field} must reference an active team member`);
  }
  return recipient;
}

/** Retry a versioned write once against a fresh read; skip a row that moved on. */
async function withFreshRetry<T>(
  write: (current: T) => Promise<unknown>,
  first: T,
  reread: () => Promise<T | null>,
  stillHeld: (current: T) => boolean,
  isConflict: (error: unknown) => boolean,
): Promise<boolean> {
  let current: T | null = first;
  for (let attempt = 0; attempt < 2 && current; attempt += 1) {
    try {
      await write(current);
      return true;
    } catch (error) {
      if (!isConflict(error)) throw error;
      current = await reread();
      if (current && !stillHeld(current)) return false;
    }
  }
  return false;
}

/**
 * Move every piece of the person's open work to `toId`. Each row is its own
 * versioned write (a person can hold more open work than one DynamoDB
 * transaction takes), so the move is idempotent rather than atomic: running
 * it again finishes whatever a concurrent edit or failure left behind, and
 * the counts it returns say what is still open.
 */
export async function reassignOpenWork(
  client: DynamoDBDocumentClient,
  fromId: string,
  toId: unknown,
  actorId: string,
): Promise<{ reassignedTo: string; moved: OpenWork; remaining: OpenWork }> {
  await requireUser(client, fromId);
  const recipient = await requireRecipient(client, fromId, toId, 'reassignTo');
  const to = recipient.id;
  const moved: OpenWork = { tasks: 0, cards: 0, schedules: 0, sponsorRecords: 0 };

  for (const task of await openTasksOf(client, fromId)) {
    const done = await withFreshRetry<Task>(
      (current) => updateTask(client, current.id, {
        expectedVersion: current.version,
        patch: { assigneeId: to },
        actorId,
      }),
      task,
      () => getTaskConsistent(client, task.id),
      (current) => current.assigneeId === fromId && OPEN_TASK_STATUSES.has(current.status),
      (error) => error instanceof TaskVersionConflictError,
    );
    if (done) moved.tasks += 1;
  }

  for (const card of await openCardsOf(client, fromId)) {
    const done = await withFreshRetry<Card>(
      (current) => updateCard(client, current.id, { expectedVersion: current.version, patch: { ownerId: to } }),
      card,
      () => getCardConsistent(client, card.id),
      (current) => current.ownerId === fromId && current.status !== 'archived',
      (error) => error instanceof CardVersionConflictError,
    );
    if (done) moved.cards += 1;
  }

  for (const config of await schedulesOf(client, fromId)) {
    await updateRecurringConfig(client, config.id, { assigneeId: to });
    moved.schedules += 1;
  }

  const sponsor = await sponsorRecordsOf(client, fromId);
  const crmConflict = (error: unknown) => {
    const name = (error as { name?: string })?.name;
    return name === 'ConditionalCheckFailedException' || name === 'TransactionCanceledException';
  };
  for (const organization of sponsor.organizations) {
    const done = await withFreshRetry<CrmRecord>(
      (current) => updateOrganizationAtomic(client, current, { owner: to }, actorId, 'owner-reassigned'),
      organization,
      () => getCrmRecord(client, 'organization', organization.id),
      (current) => current.owner === fromId,
      crmConflict,
    );
    if (done) moved.sponsorRecords += 1;
  }
  for (const deal of sponsor.deals) {
    const done = await withFreshRetry<CrmRecord>(
      (current) => {
        const nextAction = current.nextAction as Dict | null | undefined;
        return updateDealAtomic(client, current, {
          ...(current.owner === fromId ? { owner: to } : {}),
          ...(nextAction?.owner === fromId ? { nextAction: { ...nextAction, owner: to } } : {}),
        }, actorId);
      },
      deal,
      () => getCrmRecord(client, 'deal', deal.id),
      (current) => dealHeldBy(current, fromId),
      crmConflict,
    );
    if (done) moved.sponsorRecords += 1;
  }

  return { reassignedTo: to, moved, remaining: await openWorkOf(client, fromId) };
}

// --- credentials -----------------------------------------------------------

/**
 * Delete every session, API token and device grant the person holds. The
 * Sessions table has no per-user index for sessions, so this is a filtered
 * scan; API tokens also have a per-user listing row, removed with them.
 */
export async function revokeCredentials(client: DynamoDBDocumentClient, userId: string): Promise<number> {
  const owned = await readAllPages(client, (exclusiveStartKey) => new ScanCommand({
    TableName: TABLE_SESSIONS,
    FilterExpression: 'userId = :userId',
    ExpressionAttributeValues: { ':userId': userId },
    ProjectionExpression: 'PK, SK',
    ExclusiveStartKey: exclusiveStartKey,
  }));
  const listing = await readAllPages(client, (exclusiveStartKey) => new QueryCommand({
    TableName: TABLE_SESSIONS,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `USERTOKENS#${userId}` },
    ProjectionExpression: 'PK, SK',
    ExclusiveStartKey: exclusiveStartKey,
  }));
  for (const item of [...owned, ...listing]) {
    await client.send(new DeleteCommand({ TableName: TABLE_SESSIONS, Key: { PK: item.PK, SK: item.SK } }));
  }
  return owned.length;
}

// --- guards ----------------------------------------------------------------

async function requireAnotherActiveAdmin(client: DynamoDBDocumentClient, user: User): Promise<void> {
  if (user.role !== 'admin' || user.disabled) return;
  const others = (await listUsers(client)).filter((candidate) =>
    candidate.id !== user.id && candidate.role === 'admin' && !candidate.disabled);
  if (others.length === 0) {
    throw new UserLifecycleError(409, 'last_admin', `${displayName(user)} is the last active admin; make someone else an admin first`);
  }
}

/**
 * The default assignee has to stay an active person. When `user` is the
 * default, the caller names the new one in the same request, and it is set
 * before anything else changes.
 */
async function replaceDefaultAssigneeIfNeeded(
  client: DynamoDBDocumentClient,
  user: User,
  newDefaultAssigneeId: unknown,
  actorId: string,
): Promise<string | null> {
  const settings = await getWorkspaceSettings(client);
  if (settings.defaultAssigneeId !== user.id) return null;
  if (newDefaultAssigneeId === undefined) {
    throw new UserLifecycleError(409, 'default_assignee', `${displayName(user)} is the default assignee; pick a new default assignee first`, {
      defaultAssigneeId: user.id,
    });
  }
  const next = await requireRecipient(client, user.id, newDefaultAssigneeId, 'newDefaultAssigneeId');
  await setDefaultAssignee(client, { defaultAssigneeId: next.id, expectedVersion: settings.version, actorId });
  return next.id;
}

async function handOverIfNeeded(
  client: DynamoDBDocumentClient,
  user: User,
  reassignTo: unknown,
  actorId: string,
): Promise<{ reassignedTo: string | null; moved: OpenWork | null }> {
  const openWork = await openWorkOf(client, user.id);
  if (total(openWork) === 0) return { reassignedTo: null, moved: null };
  if (reassignTo === undefined || reassignTo === null || reassignTo === '') {
    throw new UserLifecycleError(409, 'handover_required', `${displayName(user)} still has open work; choose who takes it over`, {
      openWork,
    });
  }
  const result = await reassignOpenWork(client, user.id, reassignTo, actorId);
  if (total(result.remaining) > 0) {
    throw new UserLifecycleError(409, 'handover_incomplete', 'Some open work changed while it was being handed over; run the handover again', {
      openWork: result.remaining,
    });
  }
  return { reassignedTo: result.reassignedTo, moved: result.moved };
}

// --- disable / enable --------------------------------------------------------

export interface LifecycleInput {
  actorId: string;
  reassignTo?: unknown;
  newDefaultAssigneeId?: unknown;
}

export async function disableUser(client: DynamoDBDocumentClient, userId: string, input: LifecycleInput) {
  const user = await requireUser(client, userId);
  if (userId === input.actorId) {
    throw new UserLifecycleError(409, 'self', 'You cannot disable your own account');
  }
  if (user.disabled) throw new UserLifecycleError(409, 'already_disabled', `${displayName(user)} is already disabled`);
  await requireAnotherActiveAdmin(client, user);
  // Validate the recipient before anything changes, so a bad choice changes nothing.
  const openWork = await openWorkOf(client, user.id);
  if (total(openWork) > 0) {
    if (input.reassignTo === undefined || input.reassignTo === null || input.reassignTo === '') {
      throw new UserLifecycleError(409, 'handover_required', `${displayName(user)} still has open work; choose who takes it over`, { openWork });
    }
    await requireRecipient(client, user.id, input.reassignTo, 'reassignTo');
  }
  const newDefaultAssigneeId = await replaceDefaultAssigneeIfNeeded(client, user, input.newDefaultAssigneeId, input.actorId);
  // Disable first: from here on nothing new can be assigned to the person,
  // so the handover below cannot race a new assignment.
  const disabled = await updateUser(client, user.id, { disabled: true });
  const handover = await handOverIfNeeded(client, user, input.reassignTo, input.actorId);
  const revokedCredentials = await revokeCredentials(client, user.id);
  return { user: disabled, ...handover, newDefaultAssigneeId, revokedCredentials };
}

export async function enableUser(client: DynamoDBDocumentClient, userId: string) {
  const user = await requireUser(client, userId);
  if (!user.disabled) throw new UserLifecycleError(409, 'already_active', `${displayName(user)} is already active`);
  return { user: await updateUser(client, user.id, { disabled: false }) };
}

// --- delete ----------------------------------------------------------------

interface PlannedWrite {
  tableName: string;
  key: Dict;
  item: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']>[number];
  holds: (current: Dict | undefined) => boolean;
  after: (current: Dict | undefined) => Dict | null | undefined;
}

let testTransactionTail: Promise<void> = Promise.resolve();

/** Dynalite has no TransactWriteItems: apply in order, undo on failure. */
async function emulateTransaction(client: DynamoDBDocumentClient, writes: PlannedWrite[]): Promise<void> {
  const previous = testTransactionTail;
  let release!: () => void;
  testTransactionTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const snapshots: Array<{ write: PlannedWrite; current: Dict | undefined }> = [];
    for (const write of writes) {
      const current = (await client.send(new GetCommand({ TableName: write.tableName, Key: write.key, ConsistentRead: true }))).Item as Dict | undefined;
      if (!write.holds(current)) {
        throw Object.assign(new Error('Emulated transaction condition failed'), { name: 'TransactionCanceledException' });
      }
      snapshots.push({ write, current });
    }
    const applied: typeof snapshots = [];
    try {
      for (const snapshot of snapshots) {
        const next = snapshot.write.after(snapshot.current);
        if (next === undefined) continue;
        if (next) await client.send(new PutCommand({ TableName: snapshot.write.tableName, Item: next }));
        else await client.send(new DeleteCommand({ TableName: snapshot.write.tableName, Key: snapshot.write.key }));
        applied.push(snapshot);
      }
    } catch (error) {
      for (const { write, current } of applied.reverse()) {
        if (current) await client.send(new PutCommand({ TableName: write.tableName, Item: current }));
        else await client.send(new DeleteCommand({ TableName: write.tableName, Key: write.key }));
      }
      throw error;
    }
  } finally {
    release();
  }
}

/**
 * Delete a disabled account. Open work it still holds (assigned after it was
 * disabled, or held since before the handover existed) is handed over first.
 * Then one transaction removes the account, writes the former-user record,
 * checks the person is still disabled and not the default assignee, and
 * records an audit event.
 */
export async function deleteUser(client: DynamoDBDocumentClient, userId: string, input: LifecycleInput) {
  const user = await requireUser(client, userId);
  if (userId === input.actorId) {
    throw new UserLifecycleError(409, 'self', 'You cannot delete your own account');
  }
  if (!user.disabled) {
    throw new UserLifecycleError(409, 'disable_first', `Disable ${displayName(user)} first; only a disabled account can be deleted`);
  }
  if (input.reassignTo !== undefined && input.reassignTo !== null && input.reassignTo !== '') {
    await requireRecipient(client, user.id, input.reassignTo, 'reassignTo');
  }
  await replaceDefaultAssigneeIfNeeded(client, user, input.newDefaultAssigneeId, input.actorId);
  const handover = await handOverIfNeeded(client, user, input.reassignTo, input.actorId);

  const now = new Date().toISOString();
  const userKey = { PK: `USER#${user.id}`, SK: `USER#${user.id}` };
  const formerKey = formerUserKey(user.id);
  const former = { ...formerKey, id: user.id, name: displayName(user), deletedAt: now };
  const settingsKey = { PK: 'SETTINGS#workspace', SK: 'SETTINGS#workspace' };
  const auditEvent = {
    id: randomUUID(),
    action: 'user-deleted',
    actorId: input.actorId,
    userId: user.id,
    name: displayName(user),
    reassignedTo: handover.reassignedTo,
    moved: handover.moved,
    createdAt: now,
  };
  const auditKey = { PK: `AUDIT_EVENT#${auditEvent.id}`, SK: `AUDIT_EVENT#${auditEvent.id}` };
  const writes: PlannedWrite[] = [
    {
      tableName: TABLE_USERS,
      key: userKey,
      item: {
        Delete: {
          TableName: TABLE_USERS,
          Key: userKey,
          ConditionExpression: 'attribute_exists(PK) AND disabled = :disabled',
          ExpressionAttributeValues: { ':disabled': true },
        },
      },
      holds: (current) => Boolean(current && current.disabled === true),
      after: () => null,
    },
    {
      tableName: TABLE_USERS,
      key: formerKey,
      item: { Put: { TableName: TABLE_USERS, Item: former } },
      holds: () => true,
      after: () => former,
    },
    {
      tableName: TABLE_USERS,
      key: settingsKey,
      item: {
        ConditionCheck: {
          TableName: TABLE_USERS,
          Key: settingsKey,
          ConditionExpression: 'attribute_not_exists(PK) OR attribute_not_exists(defaultAssigneeId) OR defaultAssigneeId <> :userId',
          ExpressionAttributeValues: { ':userId': user.id },
        },
      },
      holds: (current) => !current || current.defaultAssigneeId !== user.id,
      after: () => undefined,
    },
    {
      tableName: TABLE_AUDIT_EVENTS,
      key: auditKey,
      item: {
        Put: {
          TableName: TABLE_AUDIT_EVENTS,
          Item: { ...auditKey, ...auditEvent },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
      },
      holds: (current) => !current,
      after: () => ({ ...auditKey, ...auditEvent }),
    },
  ];

  try {
    if (usesLocalTransactionEmulation()) await emulateTransaction(client, writes);
    else await client.send(new TransactWriteCommand({ TransactItems: writes.map(({ item }) => item) }));
  } catch (error) {
    if ((error as { name?: string })?.name === 'TransactionCanceledException') {
      throw new UserLifecycleError(409, 'changed', 'The account or the default assignee changed while deleting; reload and try again');
    }
    throw error;
  }
  const revokedCredentials = await revokeCredentials(client, user.id);
  return { deleted: { id: user.id, name: displayName(user) }, ...handover, revokedCredentials };
}

