/**
 * Workspace settings: one record in the Users table, next to the accounts it
 * refers to. Today it holds the default assignee: the team member new work
 * goes to when nothing more specific names a person (a Template Task with
 * its own assignee, a recurring schedule with one, or a name in an imported
 * title). People change, so no person is ever hardcoded; an admin sets it.
 */

import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_USERS } from './tableNames';
import { getFormerUser, getUser } from './users';

const SETTINGS_KEY = { PK: 'SETTINGS#workspace', SK: 'SETTINGS#workspace' } as const;

export interface WorkspaceSettings {
  /** Team member who receives new work no one else is named for; null when unset. */
  defaultAssigneeId: string | null;
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
  if (!item) return { defaultAssigneeId: null, version: 0 };
  return {
    defaultAssigneeId: typeof item.defaultAssigneeId === 'string' && item.defaultAssigneeId ? item.defaultAssigneeId : null,
    version: Number(item.version) || 0,
    ...(typeof item.updatedAt === 'string' ? { updatedAt: item.updatedAt } : {}),
    ...(typeof item.updatedBy === 'string' ? { updatedBy: item.updatedBy } : {}),
  };
}

export async function setDefaultAssignee(
  client: DynamoDBDocumentClient,
  input: { defaultAssigneeId: string | null; expectedVersion: number; actorId?: string },
): Promise<WorkspaceSettings> {
  const next: WorkspaceSettings = {
    defaultAssigneeId: input.defaultAssigneeId,
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
