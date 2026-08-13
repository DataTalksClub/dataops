import { createHash } from 'crypto';
import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import {
  TABLE_CONVERSATIONAL_STATE,
  TABLE_TASKS,
  TABLE_USERS,
} from '../db/tableNames';
import type { Task } from '../types';
import {
  type CapabilityExecutor,
  type ExecutorRequest,
  type ExecutorResult,
  type ReconciliationResult,
} from './execution';
import { getExecutionAttempt } from './repository';
import type { ProposalSpec, SafeExecutionReceipt } from './types';
import {
  TODO_ACTION,
  TODO_EFFECT,
  TODO_PERMISSION,
  TODO_POLICY_DIGEST,
  TODO_PLUGIN_ID,
  TODO_TIME_ZONE,
  normalizedDescription,
  todoMetadata,
  validGregorianDate,
} from './todoPlugin';

interface AssistantExecutionRef {
  executionAttemptId: string;
  proposalId: string;
  proposalVersion: number;
  canonicalPayloadHash: string;
}

interface ActorTodoWrite {
  attemptId: string;
  leaseOwner: string;
  leaseGeneration: number;
  proposalId: string;
  proposalVersion: number;
  canonicalPayloadHash: string;
  actorId: string;
  conversationId: string;
  permissionRef: typeof TODO_PERMISSION;
  permissionRevision: number;
  identityChannel: 'telegram';
  identityChannelUserId: string;
  identityBindingId: string;
  identityBindingRevision: number;
  channelBindingId: string;
  channelConversationKey: string;
  description: string;
  date: string;
}

type ActorTodoWriteResult =
  | { outcome: 'succeeded'; task: Task }
  | { outcome: 'failed_safe'; reasonCode: string };

interface ActorTodoWriterHooks {
  beforeTransaction?: () => Promise<void> | void;
  afterTransaction?: () => Promise<void> | void;
}

function deterministicTodoTaskId(input: Pick<ActorTodoWrite, 'attemptId' | 'proposalId' | 'proposalVersion'>): string {
  return `assistant-todo-${createHash('sha256')
    .update(`${input.attemptId}\0${input.proposalId}\0${input.proposalVersion}`)
    .digest('hex')}`;
}

function cleanTask(item: Record<string, unknown> | undefined): Task | null {
  if (!item) return null;
  const { PK: _pk, SK: _sk, ...task } = item;
  if (
    !Number.isInteger(task.version)
    || Number(task.version) < 1
    || !Array.isArray(task.taskHistory)
  ) {
    return null;
  }
  return task as unknown as Task;
}

function matchingTask(task: Task, input: ActorTodoWrite): boolean {
  const reference = task.assistantExecutionRef;
  return task.id === deterministicTodoTaskId(input)
    && task.description === input.description
    && task.date === input.date
    && task.status === 'todo'
    && task.source === 'conversational-agent'
    && task.assigneeId === input.actorId
    && task.createdBy === input.actorId
    && reference?.executionAttemptId === input.attemptId
    && reference.proposalId === input.proposalId
    && reference.proposalVersion === input.proposalVersion
    && reference.canonicalPayloadHash === input.canonicalPayloadHash;
}

class ActorTodoWriter {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly now: () => Date = () => new Date(),
    private readonly hooks: ActorTodoWriterHooks = {}
  ) {}

  async write(input: ActorTodoWrite): Promise<ActorTodoWriteResult> {
    const taskId = deterministicTodoTaskId(input);
    const nowIso = this.now().toISOString();
    const reference: AssistantExecutionRef = {
      executionAttemptId: input.attemptId,
      proposalId: input.proposalId,
      proposalVersion: input.proposalVersion,
      canonicalPayloadHash: input.canonicalPayloadHash,
    };
    const task: Task = {
      id: taskId,
      version: 1,
      taskHistory: [],
      description: input.description,
      date: input.date,
      status: 'todo',
      source: 'conversational-agent',
      assigneeId: input.actorId,
      createdBy: input.actorId,
      assistantExecutionRef: reference,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await this.hooks.beforeTransaction?.();
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: TABLE_CONVERSATIONAL_STATE,
              Key: { PK: `ATTEMPT#${input.attemptId}`, SK: 'META' },
              ConditionExpression: [
                '#status = :executing',
                'leaseOwner = :leaseOwner',
                'leaseGeneration = :leaseGeneration',
                'leaseExpiresAt > :now',
                'proposalId = :proposalId',
                'proposalVersion = :proposalVersion',
                'actorId = :actorId',
                'canonicalPayloadHash = :payloadHash',
              ].join(' AND '),
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':executing': 'executing',
                ':leaseOwner': input.leaseOwner,
                ':leaseGeneration': input.leaseGeneration,
                ':now': nowIso,
                ':proposalId': input.proposalId,
                ':proposalVersion': input.proposalVersion,
                ':actorId': input.actorId,
                ':payloadHash': input.canonicalPayloadHash,
              },
            },
          },
          {
            ConditionCheck: {
              TableName: TABLE_USERS,
              Key: { PK: `USER#${input.actorId}`, SK: `USER#${input.actorId}` },
              ConditionExpression: 'attribute_exists(PK) AND (attribute_not_exists(disabled) OR disabled = :false) AND #role IN (:admin, :operator)',
              ExpressionAttributeNames: { '#role': 'role' },
              ExpressionAttributeValues: {
                ':false': false,
                ':admin': 'admin',
                ':operator': 'operator',
              },
            },
          },
          {
            ConditionCheck: {
              TableName: TABLE_CONVERSATIONAL_STATE,
              Key: {
                PK: `AUTHZ#${input.actorId}#${input.permissionRef}`,
                SK: 'STATE',
              },
              ConditionExpression: 'enabled = :true AND revision = :revision',
              ExpressionAttributeValues: {
                ':true': true,
                ':revision': input.permissionRevision,
              },
            },
          },
          {
            ConditionCheck: {
              TableName: TABLE_CONVERSATIONAL_STATE,
              Key: {
                PK: `IDENTITY#${input.identityChannel}#${input.identityChannelUserId}`,
                SK: 'META',
              },
              ConditionExpression: '#status = :active AND id = :id AND userId = :actor AND revision = :revision',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':active': 'active',
                ':id': input.identityBindingId,
                ':actor': input.actorId,
                ':revision': input.identityBindingRevision,
              },
            },
          },
          {
            ConditionCheck: {
              TableName: TABLE_CONVERSATIONAL_STATE,
              Key: {
                PK: `CHANNEL#${input.identityChannel}#${input.channelConversationKey}`,
                SK: 'BINDING',
              },
              ConditionExpression: 'id = :id AND conversationId = :conversationId AND ownerUserId = :actor AND expiresAt > :now',
              ExpressionAttributeValues: {
                ':id': input.channelBindingId,
                ':conversationId': input.conversationId,
                ':actor': input.actorId,
                ':now': nowIso,
              },
            },
          },
          {
            ConditionCheck: {
              TableName: TABLE_CONVERSATIONAL_STATE,
              Key: {
                PK: `CONVERSATION#${input.conversationId}`,
                SK: 'META',
              },
              ConditionExpression: '#status = :active AND ownerUserId = :actor',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':active': 'active',
                ':actor': input.actorId,
              },
            },
          },
          {
            Put: {
              TableName: TABLE_TASKS,
              Item: { PK: `TASK#${taskId}`, SK: `TASK#${taskId}`, ...task },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
        ],
      }));
      await this.hooks.afterTransaction?.();
      return { outcome: 'succeeded', task };
    } catch (error) {
      // Every collision and lost transaction response is reconciled from the
      // deterministic key. A nonmatching row is never overwritten.
      const existing = await this.get(taskId);
      if (existing && matchingTask(existing, input)) {
        return { outcome: 'succeeded', task: existing };
      }
      const name = (error as { name?: string }).name;
      if (name === 'TransactionCanceledException' || name === 'ConditionalCheckFailedException') {
        return { outcome: 'failed_safe', reasonCode: existing ? 'todo_idempotency_conflict' : 'todo_write_condition_failed' };
      }
      throw error;
    }
  }

  async reconcile(input: ActorTodoWrite): Promise<ActorTodoWriteResult> {
    const task = await this.get(deterministicTodoTaskId(input));
    if (!task) return { outcome: 'failed_safe', reasonCode: 'todo_not_applied' };
    return matchingTask(task, input)
      ? { outcome: 'succeeded', task }
      : { outcome: 'failed_safe', reasonCode: 'todo_idempotency_conflict' };
  }

  private async get(taskId: string): Promise<Task | null> {
    const result = await this.client.send(new GetCommand({
      TableName: TABLE_TASKS,
      Key: { PK: `TASK#${taskId}`, SK: `TASK#${taskId}` },
      ConsistentRead: true,
    }));
    return cleanTask(result.Item as Record<string, unknown> | undefined);
  }
}

interface TodoSpecContent {
  description: string;
  date: string;
  status: 'todo';
  source: 'conversational-agent';
  timeZone: 'Europe/Berlin';
  actorId: string;
  ownerId: string;
  assigneeId: string;
}

function todoContentFromSpec(spec: ProposalSpec): TodoSpecContent | null {
  if (
    spec.pluginId !== TODO_PLUGIN_ID
    || spec.pluginBuildDigest !== todoMetadata.buildDigest
    || spec.schemaDigest !== todoMetadata.schemaDigest
    || spec.policyDigest !== TODO_POLICY_DIGEST
    || spec.action !== TODO_ACTION
    || spec.operation !== 'create'
    || spec.effect !== TODO_EFFECT
    || spec.destinationRef !== 'dataops.tasks'
    || spec.permissionRef !== TODO_PERMISSION
    || !Number.isSafeInteger(spec.permissionRevision)
    || Number(spec.permissionRevision) < 1
    || spec.sourceRefs.length !== 2
    || !spec.sourceRefs.some((reference) => (
      /^plugin-draft:todo-draft-[a-f0-9]{64}$/.test(reference.ref)
      && /^\d+$/.test(reference.revision || '')
      && reference.classification === 'private'
    ))
    || !spec.sourceRefs.some((reference) => (
      /^todo-source-proof:sha256:[a-f0-9]{64}$/.test(reference.ref)
      && ['date-only-confirmed', 'no-time-requested'].includes(reference.revision || '')
      && reference.classification === 'internal'
    ))
    || spec.targetRef !== undefined
    || spec.baseRevision !== undefined
    || !spec.proposedContent
    || typeof spec.proposedContent !== 'object'
    || Array.isArray(spec.proposedContent)
  ) return null;
  const content = spec.proposedContent as Record<string, unknown>;
  if (
    Object.keys(content).sort().join(',') !== [
      'actorId', 'assigneeId', 'date', 'description', 'ownerId', 'source', 'status', 'timeZone',
    ].sort().join(',')
    || typeof content.description !== 'string'
    || [...content.description].length < 1
    || [...content.description].length > 500
    || normalizedDescription(content.description) !== content.description
    || !validGregorianDate(content.date)
    || content.status !== 'todo'
    || content.source !== 'conversational-agent'
    || content.timeZone !== TODO_TIME_ZONE
    || typeof content.actorId !== 'string'
    || content.actorId.length < 1
    || content.ownerId !== content.actorId
    || content.assigneeId !== content.actorId
  ) return null;
  return content as unknown as TodoSpecContent;
}

function todoReceipt(task: Task, input: ActorTodoWrite): SafeExecutionReceipt {
  return {
    receiptId: `todo-receipt-${task.id}`,
    effectHash: input.canonicalPayloadHash,
    recordedAt: task.updatedAt,
    metadata: {
      taskId: task.id,
      actorId: input.actorId,
      proposalId: input.proposalId,
      proposalVersion: input.proposalVersion,
      executionAttemptId: input.attemptId,
      canonicalPayloadHash: input.canonicalPayloadHash,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    },
  };
}

class ActorTodoExecutor implements CapabilityExecutor {
  readonly effect = TODO_EFFECT;
  readonly buildDigest = todoMetadata.buildDigest;
  readonly permissionRef = TODO_PERMISSION;
  readonly deliveryMode = 'provider_idempotency' as const;

  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly writer = new ActorTodoWriter(client),
    private readonly now: () => Date = () => new Date()
  ) {}

  render(spec: ProposalSpec): unknown {
    const content = todoContentFromSpec(spec);
    if (!content) throw new Error('Todo proposal spec is invalid');
    return {
      title: 'Todo',
      task: content.description,
      date: content.date,
      timeZone: content.timeZone,
      dateOnly: true,
      assignee: 'You',
      assigneeId: content.assigneeId,
      status: 'Todo',
    };
  }

  async execute(request: ExecutorRequest): Promise<ExecutorResult> {
    if (request.signal.aborted) return { outcome: 'failed_safe', reasonCode: 'todo_execution_aborted' };
    const resolved = await this.resolveWrite(request);
    if (!resolved) return { outcome: 'failed_safe', reasonCode: 'todo_execution_envelope_invalid' };
    const result = await this.writer.write(resolved);
    return result.outcome === 'succeeded'
      ? {
        outcome: 'succeeded',
        receipt: todoReceipt(result.task, resolved),
        privateResult: {
          message: [
            'Todo created.',
            `Task: ${result.task.description}`,
            `Date: ${result.task.date} (${TODO_TIME_ZONE}, date only)`,
            `Task ID: ${result.task.id}`,
          ].join('\n'),
          resourceId: result.task.id,
        },
      }
      : result;
  }

  async reconcile(request: Omit<ExecutorRequest, 'signal'>): Promise<ReconciliationResult> {
    const resolved = await this.resolveWrite(request);
    if (!resolved) return { outcome: 'not_applied', reasonCode: 'todo_execution_envelope_invalid' };
    const result = await this.writer.reconcile(resolved);
    return result.outcome === 'succeeded'
      ? {
        outcome: 'applied',
        receipt: todoReceipt(result.task, resolved),
        privateResult: {
          message: [
            'Todo created.',
            `Task: ${result.task.description}`,
            `Date: ${result.task.date} (${TODO_TIME_ZONE}, date only)`,
            `Task ID: ${result.task.id}`,
          ].join('\n'),
          resourceId: result.task.id,
        },
      }
      : { outcome: 'not_applied', reasonCode: result.reasonCode };
  }

  private async resolveWrite(request: Omit<ExecutorRequest, 'signal'>): Promise<ActorTodoWrite | null> {
    const content = todoContentFromSpec(request.spec);
    if (!content) return null;
    const attempt = await getExecutionAttempt(this.client, request.attemptId, this.now());
    if (
      !attempt
      || attempt.status !== 'executing'
      || !attempt.leaseOwner
      || !attempt.leaseGeneration
      || !attempt.leaseExpiresAt
      || Date.parse(attempt.leaseExpiresAt) <= this.now().getTime()
      || attempt.actorId !== content.actorId
      || attempt.permissionRef !== TODO_PERMISSION
      || !attempt.permissionRevision
      || attempt.permissionRevision !== request.spec.permissionRevision
      || attempt.identityChannel !== 'telegram'
      || !attempt.identityChannelUserId
      || !attempt.identityBindingId
      || !attempt.identityBindingRevision
      || !attempt.channelBindingId
      || !attempt.channelConversationKey
      || !attempt.canonicalPayloadHash
      || attempt.executorBuildDigest !== todoMetadata.buildDigest
    ) return null;
    return {
      attemptId: attempt.id,
      leaseOwner: attempt.leaseOwner,
      leaseGeneration: attempt.leaseGeneration,
      proposalId: attempt.proposalId,
      proposalVersion: attempt.proposalVersion,
      canonicalPayloadHash: attempt.canonicalPayloadHash,
      actorId: content.actorId,
      conversationId: attempt.conversationId,
      permissionRef: TODO_PERMISSION,
      permissionRevision: attempt.permissionRevision,
      identityChannel: 'telegram',
      identityChannelUserId: attempt.identityChannelUserId,
      identityBindingId: attempt.identityBindingId,
      identityBindingRevision: attempt.identityBindingRevision,
      channelBindingId: attempt.channelBindingId,
      channelConversationKey: attempt.channelConversationKey,
      description: content.description,
      date: content.date,
    };
  }
}

export {
  ActorTodoExecutor,
  ActorTodoWriter,
  deterministicTodoTaskId,
  matchingTask,
  todoContentFromSpec,
};
export type {
  ActorTodoWrite,
  ActorTodoWriteResult,
  ActorTodoWriterHooks,
  AssistantExecutionRef,
  TodoSpecContent,
};
