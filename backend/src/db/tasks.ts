import {
  PutCommand,
  GetCommand,
  DeleteCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_TASKS } from './tableNames';
import type { Task, TaskHistoryEvent } from '../types';
import {
  CardLifecycleConflictError,
  TaskCardTransactionConflictError,
  executeTaskCardTransaction,
  isOpenStatus,
} from './taskCardLifecycle';

type TaskMutableField = Exclude<
  keyof Task,
  'id' | 'version' | 'taskHistory' | 'createdAt' | 'updatedAt'
>;

type TaskPatch = {
  [Field in TaskMutableField]?: Task[Field] | null;
};

interface TaskMutation {
  expectedVersion: number;
  patch: TaskPatch;
  historyEvents?: Task['taskHistory'];
  actorId?: string;
  triggerKind?: string;
  /** Strong snapshot already validated by the direct API caller. */
  currentTask?: Task;
}

type AdditiveTaskPatch = (currentTask: Task) => TaskPatch;

class TaskVersionConflictError extends Error {
  readonly taskId: string;
  readonly expectedVersion: number;

  constructor(taskId: string, expectedVersion: number) {
    super(`Task ${taskId} changed from expected version ${expectedVersion}`);
    this.name = 'TaskVersionConflictError';
    this.taskId = taskId;
    this.expectedVersion = expectedVersion;
  }
}

/**
 * Strip DynamoDB key attributes (PK, SK) from an item, returning a clean object.
 */
function cleanItem(item: Record<string, unknown> | undefined): Task | null {
  if (!item) return null;
  const { PK, SK, ...rest } = item;
  if (!Number.isInteger(rest.version) || Number(rest.version) < 1 || !Array.isArray(rest.taskHistory)) {
    throw new Error(`Task ${String(rest.id || PK || 'unknown')} is not in the canonical versioned shape`);
  }
  return rest as unknown as Task;
}

/**
 * Create a new task. Generates a UUID, sets createdAt/updatedAt, and writes to DynamoDB.
 * Returns the clean task object (without PK/SK).
 */
interface TaskCreationOptions {
  historyEvents?: TaskHistoryEvent[];
  actorId?: string;
  triggerKind?: string;
}

async function createTask(
  client: DynamoDBDocumentClient,
  taskData: Record<string, unknown>,
  options: TaskCreationOptions = {},
): Promise<Task> {
  const id = typeof taskData.id === 'string' && taskData.id.trim().length > 0 ? taskData.id : crypto.randomUUID();
  const now = new Date().toISOString();

  const item: Record<string, unknown> = {
    PK: `TASK#${id}`,
    SK: `TASK#${id}`,
    id,
    createdAt: now,
    updatedAt: now,
    status: 'todo',
    ...taskData,
    version: 1,
    taskHistory: options.historyEvents || [],
  };

  if (options.historyEvents === undefined && taskData.status === 'waiting') {
    item.taskHistory = [{
      id: crypto.randomUUID(),
      taskId: id,
      ...(typeof taskData.cardId === 'string' ? { cardId: taskData.cardId } : {}),
      action: 'waiting-started',
      ...(options.actorId || taskData.createdBy ? { actorId: options.actorId || taskData.createdBy } : {}),
      ...(typeof taskData.followUpChannel === 'string' ? { channel: taskData.followUpChannel } : {}),
      ...(typeof taskData.waitingFor === 'string' ? { waitingFor: taskData.waitingFor } : {}),
      ...(typeof taskData.followUpAt === 'string' ? { followUpAt: taskData.followUpAt } : {}),
      ...(typeof taskData.comment === 'string' ? { note: taskData.comment } : {}),
      createdAt: now,
    }];
  } else if (options.historyEvents === undefined && taskData.status === 'done') {
    item.completedAt = typeof taskData.completedAt === 'string' ? taskData.completedAt : now;
    const completedBy = options.actorId || taskData.completedBy || taskData.createdBy || 'system:task-lifecycle';
    item.completedBy = completedBy;
    item.taskHistory = [{
      id: crypto.randomUUID(),
      taskId: id,
      ...(typeof taskData.cardId === 'string' ? { cardId: taskData.cardId } : {}),
      action: 'completed',
      ...(completedBy ? { actorId: completedBy } : {}),
      ...(typeof taskData.comment === 'string' ? { note: taskData.comment } : {}),
      createdAt: String(item.completedAt),
    }];
  }

  const task = cleanItem(item) as Task;
  if (typeof task.cardId === 'string' && task.cardId.length > 0) {
    try {
      await executeTaskCardTransaction(client, {
        kind: 'create',
        afterTask: task,
        actorId: options.actorId || (typeof task.createdBy === 'string' ? task.createdBy : undefined),
        triggerKind: options.triggerKind || 'task-created',
      });
      return task;
    } catch (error) {
      if (error instanceof TaskCardTransactionConflictError) {
        if (error.reason === 'task') throw new Error(`Task ${id} already exists`);
        throw new CardLifecycleConflictError(id, error.cardIds, true);
      }
      throw error;
    }
  }

  await client.send(new PutCommand({
    TableName: TABLE_TASKS,
    Item: item,
    ConditionExpression: 'attribute_not_exists(PK)',
  }));

  return task;
}

/**
 * Get a task by id. Returns the clean object or null if not found.
 */
async function getTask(client: DynamoDBDocumentClient, id: string): Promise<Task | null> {
  return getTaskWithConsistency(client, id, false);
}

/**
 * Read the canonical Task after a failed condition so an API conflict response
 * never returns a stale pre-write snapshot.
 */
async function getTaskConsistent(client: DynamoDBDocumentClient, id: string): Promise<Task | null> {
  return getTaskWithConsistency(client, id, true);
}

async function getTaskWithConsistency(
  client: DynamoDBDocumentClient,
  id: string,
  consistentRead: boolean,
): Promise<Task | null> {
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_TASKS,
      Key: { PK: `TASK#${id}`, SK: `TASK#${id}` },
      ...(consistentRead ? { ConsistentRead: true } : {}),
    })
  );

  return result.Item ? cleanItem(result.Item as Record<string, unknown>) : null;
}

/**
 * Conditionally mutate one canonical Task row. Task fields, timestamp, version,
 * and history events are applied by one DynamoDB write.
 */
async function updateTask(
  client: DynamoDBDocumentClient,
  id: string,
  mutation: TaskMutation,
): Promise<Task> {
  if (!Number.isInteger(mutation.expectedVersion) || mutation.expectedVersion < 1) {
    throw new TypeError('expectedVersion must be an integer greater than or equal to 1');
  }
  const now = new Date().toISOString();
  const fields: Record<string, unknown> = { ...mutation.patch, updatedAt: now };
  const forbiddenFields = ['PK', 'SK', 'id', 'version', 'taskHistory', 'createdAt', 'updatedAt', 'expectedVersion'];
  const suppliedForbiddenField = forbiddenFields.find((field) => Object.hasOwn(mutation.patch, field));
  if (suppliedForbiddenField) throw new TypeError(`${suppliedForbiddenField} is not an allowed Task patch field`);

  if (mutation.patch.status !== undefined || Object.hasOwn(mutation.patch, 'cardId')) {
    const beforeTask = mutation.currentTask || await getTaskConsistent(client, id);
    if (!beforeTask || beforeTask.version !== mutation.expectedVersion) {
      throw new TaskVersionConflictError(id, mutation.expectedVersion);
    }
    const historyEvents = mutation.historyEvents || [];
    const afterTask = {
      ...beforeTask,
      ...mutation.patch,
      version: mutation.expectedVersion + 1,
      updatedAt: now,
      taskHistory: [...beforeTask.taskHistory, ...historyEvents],
    } as Task;
    if (mutation.patch.cardId === null) delete afterTask.cardId;
    if (mutation.patch.completedAt === null) delete afterTask.completedAt;
    if (mutation.patch.completedBy === null) delete afterTask.completedBy;
    const beforeCardId = typeof beforeTask.cardId === 'string' && beforeTask.cardId.length > 0
      ? beforeTask.cardId
      : null;
    const afterCardId = typeof afterTask.cardId === 'string' && afterTask.cardId.length > 0
      ? afterTask.cardId
      : null;
    const aggregateChanged = beforeCardId !== afterCardId
      || (beforeCardId !== null && isOpenStatus(beforeTask.status) !== isOpenStatus(afterTask.status));
    if (aggregateChanged) {
      try {
        const result = await executeTaskCardTransaction(client, {
          kind: 'update',
          beforeTask,
          afterTask,
          expectedVersion: mutation.expectedVersion,
          patch: mutation.patch as Record<string, unknown>,
          historyEvents,
          actorId: mutation.actorId,
          triggerKind: mutation.triggerKind || 'task-updated',
        });
        return result.task as Task;
      } catch (error) {
        if (error instanceof TaskCardTransactionConflictError) {
          if (error.reason === 'task') throw new TaskVersionConflictError(id, mutation.expectedVersion);
          throw new CardLifecycleConflictError(id, error.cardIds);
        }
        throw error;
      }
    }
  }

  const expressionParts: string[] = [];
  const expressionAttrNames: Record<string, string> = {};
  const expressionAttrValues: Record<string, unknown> = {};

  let i = 0;
  for (const [key, value] of Object.entries(fields)) {
    const nameToken = `#f${i}`;
    const valueToken = `:v${i}`;
    expressionParts.push(`${nameToken} = ${valueToken}`);
    expressionAttrNames[nameToken] = key;
    expressionAttrValues[valueToken] = value;
    i++;
  }
  expressionParts.push('#version = :nextVersion');
  expressionAttrNames['#version'] = 'version';
  expressionAttrValues[':expectedVersion'] = mutation.expectedVersion;
  expressionAttrValues[':nextVersion'] = mutation.expectedVersion + 1;

  if (mutation.historyEvents?.length) {
    expressionParts.push('#taskHistory = list_append(#taskHistory, :historyEvents)');
    expressionAttrNames['#taskHistory'] = 'taskHistory';
    expressionAttrValues[':historyEvents'] = mutation.historyEvents;
  }

  try {
    const result = await client.send(new UpdateCommand({
      TableName: TABLE_TASKS,
      Key: { PK: `TASK#${id}`, SK: `TASK#${id}` },
      UpdateExpression: `SET ${expressionParts.join(', ')}`,
      ConditionExpression: 'attribute_exists(PK) AND #version = :expectedVersion',
      ExpressionAttributeNames: expressionAttrNames,
      ExpressionAttributeValues: expressionAttrValues,
      ReturnValues: 'ALL_NEW',
    }));

    return cleanItem(result.Attributes as Record<string, unknown>) as Task;
  } catch (error) {
    if ((error as { name?: string })?.name === 'ConditionalCheckFailedException') {
      throw new TaskVersionConflictError(id, mutation.expectedVersion);
    }
    throw error;
  }
}

/**
 * Add one caller-owned reference without replaying a stale Task snapshot.
 * The initial conditional attempt may be followed by one strongly-consistent
 * refetch/remerge attempt; a second conflict is surfaced to the caller.
 */
async function updateTaskAdditive(
  client: DynamoDBDocumentClient,
  initialTask: Task,
  buildPatch: AdditiveTaskPatch,
): Promise<Task> {
  let currentTask = initialTask;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await updateTask(client, currentTask.id, {
        expectedVersion: currentTask.version,
        patch: buildPatch(currentTask),
      });
    } catch (error) {
      if (!(error instanceof TaskVersionConflictError) || attempt === 1) throw error;
      const refreshed = await getTaskConsistent(client, currentTask.id);
      if (!refreshed) throw error;
      currentTask = refreshed;
    }
  }
  throw new Error('Unreachable additive Task mutation state');
}

/**
 * Delete a task by id.
 */
async function deleteTask(
  client: DynamoDBDocumentClient,
  id: string,
  expectedVersion: number,
  actorId?: string,
): Promise<void> {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new TypeError('expectedVersion must be an integer greater than or equal to 1');
  }
  const beforeTask = await getTaskConsistent(client, id);
  if (!beforeTask || beforeTask.version !== expectedVersion) {
    throw new TaskVersionConflictError(id, expectedVersion);
  }
  if (typeof beforeTask.cardId === 'string' && beforeTask.cardId.length > 0) {
    try {
      await executeTaskCardTransaction(client, {
        kind: 'delete',
        beforeTask,
        expectedVersion,
        actorId,
        triggerKind: 'task-deleted',
      });
      return;
    } catch (error) {
      if (error instanceof TaskCardTransactionConflictError) {
        if (error.reason === 'task') throw new TaskVersionConflictError(id, expectedVersion);
        throw new CardLifecycleConflictError(id, error.cardIds);
      }
      throw error;
    }
  }
  try {
    await client.send(new DeleteCommand({
      TableName: TABLE_TASKS,
      Key: { PK: `TASK#${id}`, SK: `TASK#${id}` },
      ConditionExpression: 'attribute_exists(PK) AND #version = :expectedVersion',
      ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: { ':expectedVersion': expectedVersion },
    }));
  } catch (error) {
    if ((error as { name?: string })?.name === 'ConditionalCheckFailedException') {
      throw new TaskVersionConflictError(id, expectedVersion);
    }
    throw error;
  }
}

/**
 * List tasks for a specific date using GSI-Date.
 */
async function listTasksByDate(client: DynamoDBDocumentClient, date: string): Promise<Task[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: TABLE_TASKS,
      IndexName: 'GSI-Date',
      KeyConditionExpression: '#d = :date',
      ExpressionAttributeNames: { '#d': 'date' },
      ExpressionAttributeValues: { ':date': date },
    })
  );

  return (result.Items || []).map((item) => cleanItem(item as Record<string, unknown>) as Task);
}

/**
 * List tasks within a date range. Uses a Scan with a FilterExpression since
 * date is the partition key on GSI-Date and range queries require sort key.
 */
async function listTasksByDateRange(client: DynamoDBDocumentClient, startDate: string, endDate: string): Promise<Task[]> {
  const result = await client.send(
    new ScanCommand({
      TableName: TABLE_TASKS,
      FilterExpression:
        '#d BETWEEN :start AND :end AND begins_with(PK, :prefix)',
      ExpressionAttributeNames: { '#d': 'date' },
      ExpressionAttributeValues: {
        ':start': startDate,
        ':end': endDate,
        ':prefix': 'TASK#',
      },
    })
  );

  return (result.Items || []).map((item) => cleanItem(item as Record<string, unknown>) as Task);
}

/**
 * List tasks for a specific card using GSI-Card.
 */
async function listTasksByCard(client: DynamoDBDocumentClient, cardId: string): Promise<Task[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: TABLE_TASKS,
      IndexName: 'GSI-Card',
      KeyConditionExpression: 'cardId = :bid',
      ExpressionAttributeValues: { ':bid': cardId },
    })
  );

  return (result.Items || []).map((item) => cleanItem(item as Record<string, unknown>) as Task);
}

const MAX_TASK_SCAN_PAGES = 200;

async function scanTasks(
  client: DynamoDBDocumentClient,
  filterParts: string[],
  values: Record<string, unknown>,
): Promise<Task[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let pages = 0;
  do {
    const result = await client.send(new ScanCommand({
      TableName: TABLE_TASKS,
      FilterExpression: filterParts.join(' AND '),
      ExpressionAttributeValues: values,
      ExclusiveStartKey: exclusiveStartKey,
    }));
    items.push(...((result.Items || []) as Record<string, unknown>[]));
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    pages += 1;
    if (pages >= MAX_TASK_SCAN_PAGES && exclusiveStartKey) {
      throw new Error('Task listing exceeded its bounded page limit');
    }
  } while (exclusiveStartKey);

  return items.map((item) => cleanItem(item) as Task);
}

/**
 * List every canonical Task with bounded pagination. Collection projections
 * use this one read instead of issuing a Task query for each Card.
 */
function listAllTasks(client: DynamoDBDocumentClient): Promise<Task[]> {
  return scanTasks(client, ['begins_with(PK, :prefix)'], { ':prefix': 'TASK#' });
}

/**
 * List Tasks by owner reference when `owner` is the only supplied filter.
 *
 * There is no assignee index, and this change may not add one: DynamoDB index
 * changes are an offline infrastructure operation, not part of an application
 * feature. Owner-only listings therefore share the bounded, filtered Scan;
 * every other owner query is applied to the result of an existing indexed
 * filter instead of scanning.
 */
async function listTasksByOwner(
  client: DynamoDBDocumentClient,
  owner: { kind: 'user'; userId: string } | { kind: 'unassigned' } | { kind: 'any' },
): Promise<Task[]> {
  const filterParts = ['begins_with(PK, :prefix)'];
  const values: Record<string, unknown> = { ':prefix': 'TASK#' };
  if (owner.kind === 'user') {
    filterParts.push('assigneeId = :assigneeId');
    values[':assigneeId'] = owner.userId;
  } else if (owner.kind === 'unassigned') {
    filterParts.push('(attribute_not_exists(assigneeId) OR assigneeId = :emptyAssignee)');
    values[':emptyAssignee'] = '';
  }

  return scanTasks(client, filterParts, values);
}

/**
 * List tasks by status using GSI-Status.
 */
async function listTasksByStatus(client: DynamoDBDocumentClient, status: string): Promise<Task[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: TABLE_TASKS,
      IndexName: 'GSI-Status',
      KeyConditionExpression: '#s = :status',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':status': status },
    })
  );

  return (result.Items || []).map((item) => cleanItem(item as Record<string, unknown>) as Task);
}

export {
  createTask,
  getTask,
  getTaskConsistent,
  updateTask,
  updateTaskAdditive,
  deleteTask,
  listTasksByDate,
  listTasksByDateRange,
  listTasksByCard,
  listAllTasks,
  listTasksByStatus,
  listTasksByOwner,
  TaskVersionConflictError,
  CardLifecycleConflictError,
};
export type { AdditiveTaskPatch, TaskCreationOptions, TaskMutation, TaskPatch };
