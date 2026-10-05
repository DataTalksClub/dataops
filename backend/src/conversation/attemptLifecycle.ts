import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import { TABLE_CONVERSATIONAL_STATE, TABLE_USERS } from '../db/tableNames';
import {
  expiryFrom,
  validateConversationalRecord,
  validateSafeExecutionReceipt,
  type ExecutionAttempt,
  type JsonValue,
  type SafeExecutionReceipt,
} from './types';
import { type AttemptStatus, clean, versionSk } from './executionState';

interface DispatchStateGuard {
  kind: 'typefully_public_source';
  conversationId: string;
  actorId: string;
  draftId: string;
  draftRevision: number;
  draftData: JsonValue;
  pluginBuild: string;
  payloads: Array<{ id: string; content: JsonValue }>;
}

async function claimQueuedAttempt(
  client: DynamoDBDocumentClient,
  attemptId: string,
  leaseOwner: string,
  now: string,
  leaseExpiresAt: string
): Promise<ExecutionAttempt | null> {
  try {
    const result = await client.send(new UpdateCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `ATTEMPT#${attemptId}`, SK: 'META' },
      UpdateExpression: 'SET #status = :executing, leaseOwner = :owner, leaseExpiresAt = :leaseExpiresAt, leaseGeneration = if_not_exists(leaseGeneration, :zero) + :one, attemptNumber = attemptNumber + :one, revision = revision + :one, updatedAt = :now, readyAt = :leaseExpiresAt, GSI2PK = :state, GSI2SK = :recoverySort REMOVE dispatchStartedAt',
      ConditionExpression: '#status = :queued AND readyAt <= :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':queued': 'queued', ':executing': 'executing', ':owner': leaseOwner,
        ':leaseExpiresAt': leaseExpiresAt, ':zero': 0, ':one': 1, ':now': now,
        ':state': 'ATTEMPT_STATE#executing',
        ':recoverySort': `READY#${leaseExpiresAt}#LEASE#${leaseExpiresAt}#${attemptId}`,
      },
      ReturnValues: 'ALL_NEW',
    }));
    return clean<ExecutionAttempt>(result.Attributes as Record<string, unknown>);
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return null;
    throw error;
  }
}

async function reclaimDispatchedAttempt(
  client: DynamoDBDocumentClient,
  attemptId: string,
  expectedRevision: number,
  leaseOwner: string,
  now: string,
  leaseExpiresAt: string
): Promise<ExecutionAttempt | null> {
  try {
    const result = await client.send(new UpdateCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `ATTEMPT#${attemptId}`, SK: 'META' },
      UpdateExpression: 'SET leaseOwner = :owner, leaseExpiresAt = :leaseExpiresAt, leaseGeneration = if_not_exists(leaseGeneration, :zero) + :one, attemptNumber = attemptNumber + :one, revision = revision + :one, updatedAt = :now, readyAt = :leaseExpiresAt, GSI2SK = :recoverySort',
      ConditionExpression: '#status = :executing AND revision = :revision AND leaseExpiresAt <= :now AND attribute_exists(dispatchStartedAt)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':executing': 'executing', ':revision': expectedRevision, ':owner': leaseOwner,
        ':leaseExpiresAt': leaseExpiresAt, ':zero': 0, ':one': 1, ':now': now,
        ':recoverySort': `READY#${leaseExpiresAt}#LEASE#${leaseExpiresAt}#${attemptId}`,
      },
      ReturnValues: 'ALL_NEW',
    }));
    return clean<ExecutionAttempt>(result.Attributes as Record<string, unknown>);
  } catch (error) {
    if (
      ['ConditionalCheckFailedException', 'TransactionCanceledException']
        .includes((error as { name?: string }).name || '')
    ) return null;
    throw error;
  }
}

async function markDispatchStarted(
  client: DynamoDBDocumentClient,
  attempt: ExecutionAttempt,
  now: string,
  dispatchGuard?: DispatchStateGuard
): Promise<ExecutionAttempt | null> {
  const update = {
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `ATTEMPT#${attempt.id}`, SK: 'META' },
    UpdateExpression: 'SET dispatchStartedAt = :now, updatedAt = :now, revision = revision + :one',
    ConditionExpression: '#status = :executing AND leaseOwner = :owner AND leaseGeneration = :generation AND leaseExpiresAt > :now AND attribute_not_exists(dispatchStartedAt)',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':executing': 'executing', ':owner': attempt.leaseOwner,
      ':generation': attempt.leaseGeneration, ':now': now, ':one': 1,
    },
  };
  try {
    const typefullyAttempt = attempt.permissionRef === 'typefully:create-saved-draft';
    if (
      typefullyAttempt
      && (
        !attempt.permissionRevision
        || !attempt.resourceKey
        || !attempt.accountConfigDigest
        || !attempt.accountScopeDigest
        || !attempt.deliveryModeDigest
        || !attempt.draftRef
        || !attempt.actorId
        || !attempt.identityChannel
        || !attempt.identityChannelUserId
        || !attempt.identityBindingId
        || !attempt.identityBindingRevision
        || !attempt.channelBindingId
        || !attempt.channelConversationKey
        || !dispatchGuard
      )
    ) return null;
    if (
      process.env.NODE_ENV !== 'test'
      && attempt.permissionRef
      && attempt.permissionRevision
      && attempt.resourceKey
      && attempt.accountConfigDigest
      && attempt.accountScopeDigest
      && attempt.deliveryModeDigest
    ) {
      if (
        typefullyAttempt
        && (
          !dispatchGuard
          || dispatchGuard.kind !== 'typefully_public_source'
          || dispatchGuard.conversationId !== attempt.conversationId
          || dispatchGuard.actorId !== attempt.actorId
          || dispatchGuard.draftId !== attempt.draftRef
        )
      ) return null;
      const payloadChecks: NonNullable<
        ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
      > = dispatchGuard
        ? dispatchGuard.payloads.map((payload) => ({
          ConditionCheck: {
            TableName: TABLE_CONVERSATIONAL_STATE,
            Key: { PK: `PRIVATE_PAYLOAD#${payload.id}`, SK: 'META' },
            ConditionExpression: 'conversationId = :conversationId AND classification = :private AND #content = :content AND expiresAt > :now',
            ExpressionAttributeNames: { '#content': 'content' },
            ExpressionAttributeValues: {
              ':conversationId': dispatchGuard.conversationId,
              ':private': 'private',
              ':content': payload.content,
              ':now': now,
            },
          },
        }))
        : [];
      const sourceChecks: NonNullable<
        ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
      > = dispatchGuard ? [
        {
          ConditionCheck: {
            TableName: TABLE_CONVERSATIONAL_STATE,
            Key: {
              PK: `CONVERSATION#${dispatchGuard.conversationId}`,
              SK: `DRAFT#${dispatchGuard.draftId}`,
            },
            ConditionExpression: 'revision = :revision AND pluginId = :pluginId AND pluginBuild = :pluginBuild AND #data = :data AND expiresAt > :now',
            ExpressionAttributeNames: { '#data': 'data' },
            ExpressionAttributeValues: {
              ':revision': dispatchGuard.draftRevision,
              ':pluginId': 'typefully',
              ':pluginBuild': dispatchGuard.pluginBuild,
              ':data': dispatchGuard.draftData,
              ':now': now,
            },
          },
        },
        ...payloadChecks,
        {
          ConditionCheck: {
            TableName: TABLE_CONVERSATIONAL_STATE,
            Key: { PK: `CONVERSATION#${dispatchGuard.conversationId}`, SK: 'META' },
            ConditionExpression: 'ownerUserId = :actor AND #status = :active AND expiresAt > :now',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':actor': dispatchGuard.actorId,
              ':active': 'active',
              ':now': now,
            },
          },
        },
      ] : [];
      await client.send(new TransactWriteCommand({
        TransactItems: [
          { Update: update },
          {
            ConditionCheck: {
              TableName: TABLE_CONVERSATIONAL_STATE,
              Key: {
                PK: `AUTHZ#${attempt.actorId}#${attempt.permissionRef}`,
                SK: 'STATE',
              },
              ConditionExpression: 'enabled = :true AND revision = :revision AND contains(allowedResourceKeys, :resourceKey) AND accountConfigDigest = :accountConfigDigest AND accountScopeDigest = :accountScopeDigest AND deliveryModeDigest = :deliveryModeDigest',
              ExpressionAttributeValues: {
                ':true': true,
                ':revision': attempt.permissionRevision,
                ':resourceKey': attempt.resourceKey,
                ':accountConfigDigest': attempt.accountConfigDigest,
                ':accountScopeDigest': attempt.accountScopeDigest,
                ':deliveryModeDigest': attempt.deliveryModeDigest,
              },
            },
          },
          {
            ConditionCheck: {
              TableName: TABLE_CONVERSATIONAL_STATE,
              Key: {
                PK: `PROPOSAL#${attempt.proposalId}`,
                SK: versionSk(attempt.proposalVersion),
              },
              ConditionExpression: 'canonicalPayloadHash = :payloadHash AND renderedViewHash = :viewHash AND actorId = :actor AND conversationId = :conversationId AND draftId = :draftRef AND spec.actorId = :actor AND spec.conversationId = :conversationId AND spec.draftRef = :draftRef AND spec.proposalId = :proposalId AND spec.proposalVersion = :proposalVersion AND spec.#expiresAt > :now',
              ExpressionAttributeNames: { '#expiresAt': 'expiresAt' },
              ExpressionAttributeValues: {
                ':payloadHash': attempt.canonicalPayloadHash,
                ':viewHash': attempt.renderedViewHash,
                ':actor': attempt.actorId,
                ':conversationId': attempt.conversationId,
                ':draftRef': attempt.draftRef,
                ':proposalId': attempt.proposalId,
                ':proposalVersion': attempt.proposalVersion,
                ':now': now,
              },
            },
          },
          {
            ConditionCheck: {
              TableName: TABLE_USERS,
              Key: { PK: `USER#${attempt.actorId}`, SK: `USER#${attempt.actorId}` },
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
                PK: `IDENTITY#${attempt.identityChannel}#${attempt.identityChannelUserId}`,
                SK: 'META',
              },
              ConditionExpression: '#status = :active AND userId = :actor AND revision = :identityRevision AND id = :identityId',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':active': 'active',
                ':actor': attempt.actorId,
                ':identityRevision': attempt.identityBindingRevision,
                ':identityId': attempt.identityBindingId,
              },
            },
          },
          {
            ConditionCheck: {
              TableName: TABLE_CONVERSATIONAL_STATE,
              Key: {
                PK: `CHANNEL#${attempt.identityChannel}#${attempt.channelConversationKey}`,
                SK: 'BINDING',
              },
              ConditionExpression: 'id = :channelBindingId AND conversationId = :conversationId AND ownerUserId = :actor',
              ExpressionAttributeValues: {
                ':channelBindingId': attempt.channelBindingId,
                ':conversationId': attempt.conversationId,
                ':actor': attempt.actorId,
              },
            },
          },
          ...sourceChecks,
        ],
      }));
      const stored = await client.send(new GetCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Key: { PK: `ATTEMPT#${attempt.id}`, SK: 'META' },
        ConsistentRead: true,
      }));
      return clean<ExecutionAttempt>(stored.Item as Record<string, unknown> | undefined);
    }
    const result = await client.send(new UpdateCommand({ ...update, ReturnValues: 'ALL_NEW' }));
    return clean<ExecutionAttempt>(result.Attributes as Record<string, unknown>);
  } catch (error) {
    if (
      ['ConditionalCheckFailedException', 'TransactionCanceledException']
        .includes((error as { name?: string }).name || '')
    ) return null;
    throw error;
  }
}

async function finalizeAttempt(
  client: DynamoDBDocumentClient,
  attempt: ExecutionAttempt,
  status: Extract<AttemptStatus, 'succeeded' | 'failed_safe' | 'outcome_unknown'>,
  now: string,
  values: {
    errorCode?: string;
    receipt?: SafeExecutionReceipt;
    resultNotification?: { privateResult?: JsonValue };
  } = {}
): Promise<ExecutionAttempt | null> {
  const names: Record<string, string> = { '#status': 'status' };
  const expressionValues: Record<string, unknown> = {
    ':executing': 'executing', ':status': status, ':owner': attempt.leaseOwner,
    ':generation': attempt.leaseGeneration, ':revision': attempt.revision, ':now': now, ':one': 1,
    ':blocked': status === 'outcome_unknown',
    ':state': `ATTEMPT_STATE#${status}`,
    ':recoverySort': `READY#${now}#LEASE#-#${attempt.id}`,
  };
  const sets = [
    '#status = :status', 'updatedAt = :now', 'revision = revision + :one',
    'recoveryBlocked = :blocked', 'GSI2PK = :state', 'GSI2SK = :recoverySort',
  ];
  if (values.errorCode) {
    sets.push('errorCode = :errorCode');
    expressionValues[':errorCode'] = values.errorCode;
  }
  if (values.receipt) {
    validateSafeExecutionReceipt(values.receipt);
    sets.push('resultReceipt = :receipt', 'resultReceiptRef = :receiptRef');
    expressionValues[':receipt'] = values.receipt;
    expressionValues[':receiptRef'] = values.receipt.receiptId;
  }
  const update = {
    TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `ATTEMPT#${attempt.id}`, SK: 'META' },
      UpdateExpression: `SET ${sets.join(', ')} REMOVE leaseOwner, leaseExpiresAt`,
      ConditionExpression: '#status = :executing AND revision = :revision AND leaseOwner = :owner AND leaseGeneration = :generation AND leaseExpiresAt > :now',
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: expressionValues,
      ReturnValues: 'ALL_NEW',
  } as const;
  try {
    if (values.resultNotification) {
      if (
        !attempt.actorId
        || !attempt.identityChannel
        || !attempt.identityChannelUserId
        || !attempt.identityBindingId
        || !attempt.identityBindingRevision
        || !attempt.channelBindingId
        || !attempt.channelConversationKey
      ) throw new Error('Result notification identity is unavailable');
      const retention = expiryFrom(now, 30);
      const payloadId = `execution-result-${attempt.id}`;
      const notificationId = `result-notification-${attempt.id}`;
      const payload = {
        id: payloadId,
        recordType: 'conversational_private_payload' as const,
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
        ...retention,
        conversationId: attempt.conversationId,
        classification: 'private' as const,
        content: {
          kind: 'execution_result',
          executionAttemptId: attempt.id,
          status,
          ...(values.resultNotification.privateResult !== undefined
            ? { result: values.resultNotification.privateResult }
            : {}),
        },
      };
      const notification = {
        id: notificationId,
        recordType: 'result_notification' as const,
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
        ...retention,
        conversationId: attempt.conversationId,
        executionAttemptId: attempt.id,
        actorId: attempt.actorId,
        channel: attempt.identityChannel,
        channelConversationKey: attempt.channelConversationKey,
        identityChannelUserId: attempt.identityChannelUserId,
        identityBindingId: attempt.identityBindingId,
        identityBindingRevision: attempt.identityBindingRevision,
        channelBindingId: attempt.channelBindingId,
        privatePayloadRef: payloadId,
        status: 'pending' as const,
        readyAt: now,
        revision: 1,
      };
      validateConversationalRecord(payload);
      validateConversationalRecord(notification);
      const payloadItem = {
        ...payload,
        PK: `PRIVATE_PAYLOAD#${payloadId}`,
        SK: 'META',
        GSI1PK: `CONVERSATION#${attempt.conversationId}`,
        GSI1SK: `PRIVATE_PAYLOAD#${payloadId}`,
      };
      const notificationItem = {
        ...notification,
        PK: `RESULT_NOTIFICATION#${notificationId}`,
        SK: 'META',
        GSI1PK: `CONVERSATION#${attempt.conversationId}`,
        GSI1SK: `RESULT_NOTIFICATION#${now}#${notificationId}`,
        GSI2PK: 'RESULT_NOTIFICATION_STATE#pending',
        GSI2SK: `READY#${now}#${notificationId}`,
      };
      if (process.env.NODE_ENV !== 'test') {
        const { ReturnValues: _returnValues, ...transactionUpdate } = update;
        await client.send(new TransactWriteCommand({
          TransactItems: [
            { Update: transactionUpdate },
            {
              Put: {
                TableName: TABLE_CONVERSATIONAL_STATE,
                Item: payloadItem,
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Put: {
                TableName: TABLE_CONVERSATIONAL_STATE,
                Item: notificationItem,
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        }));
        const stored = await client.send(new GetCommand({
          TableName: TABLE_CONVERSATIONAL_STATE,
          Key: { PK: `ATTEMPT#${attempt.id}`, SK: 'META' },
          ConsistentRead: true,
        }));
        return clean<ExecutionAttempt>(stored.Item as Record<string, unknown> | undefined);
      }
      const result = await client.send(new UpdateCommand(update));
      await client.send(new PutCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Item: payloadItem,
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
      await client.send(new PutCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Item: notificationItem,
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
      return clean<ExecutionAttempt>(result.Attributes as Record<string, unknown>);
    }
    const result = await client.send(new UpdateCommand(update));
    return clean<ExecutionAttempt>(result.Attributes as Record<string, unknown>);
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return null;
    throw error;
  }
}

async function requeueUndispatchedAttempt(
  client: DynamoDBDocumentClient,
  attempt: ExecutionAttempt,
  now: string,
  readyAt = now
): Promise<ExecutionAttempt | null> {
  try {
    const result = await client.send(new UpdateCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `ATTEMPT#${attempt.id}`, SK: 'META' },
      UpdateExpression: 'SET #status = :queued, readyAt = :readyAt, updatedAt = :now, revision = revision + :one, GSI2PK = :state, GSI2SK = :recoverySort REMOVE leaseOwner, leaseExpiresAt',
      ConditionExpression: '#status = :executing AND revision = :revision AND leaseExpiresAt <= :now AND attribute_not_exists(dispatchStartedAt)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':queued': 'queued', ':executing': 'executing', ':revision': attempt.revision,
        ':now': now, ':one': 1, ':state': 'ATTEMPT_STATE#queued',
        ':recoverySort': `READY#${readyAt}#LEASE#-#${attempt.id}`,
        ':readyAt': readyAt,
      },
      ReturnValues: 'ALL_NEW',
    }));
    return clean<ExecutionAttempt>(result.Attributes as Record<string, unknown>);
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return null;
    throw error;
  }
}

async function releaseUndispatchedAttempt(
  client: DynamoDBDocumentClient,
  attempt: ExecutionAttempt,
  now: string,
  readyAt: string
): Promise<ExecutionAttempt | null> {
  if (!attempt.leaseOwner) return null;
  try {
    const result = await client.send(new UpdateCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `ATTEMPT#${attempt.id}`, SK: 'META' },
      UpdateExpression: 'SET #status = :queued, readyAt = :readyAt, updatedAt = :now, revision = revision + :one, GSI2PK = :state, GSI2SK = :recoverySort REMOVE leaseOwner, leaseExpiresAt',
      ConditionExpression: '#status = :executing AND revision = :revision AND leaseOwner = :owner AND attribute_not_exists(dispatchStartedAt)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':queued': 'queued', ':executing': 'executing', ':revision': attempt.revision,
        ':owner': attempt.leaseOwner, ':now': now, ':one': 1,
        ':state': 'ATTEMPT_STATE#queued',
        ':recoverySort': `READY#${readyAt}#LEASE#-#${attempt.id}`,
        ':readyAt': readyAt,
      },
      ReturnValues: 'ALL_NEW',
    }));
    return clean<ExecutionAttempt>(result.Attributes as Record<string, unknown>);
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return null;
    throw error;
  }
}

async function reconcileUnknownAttempt(
  client: DynamoDBDocumentClient,
  attemptId: string,
  expectedRevision: number,
  status: Extract<AttemptStatus, 'succeeded' | 'failed_safe' | 'outcome_unknown'>,
  now: string,
  receipt?: SafeExecutionReceipt
): Promise<ExecutionAttempt | null> {
  const values: Record<string, unknown> = {
    ':unknown': 'outcome_unknown', ':status': status, ':revision': expectedRevision,
    ':now': now, ':one': 1, ':blocked': status === 'outcome_unknown',
    ':state': `ATTEMPT_STATE#${status}`,
    ':sort': `READY#${now}#LEASE#-#${attemptId}`,
  };
  const sets = [
    '#status = :status', 'updatedAt = :now', 'revision = revision + :one',
    'recoveryBlocked = :blocked', 'GSI2PK = :state', 'GSI2SK = :sort',
  ];
  if (receipt) {
    validateSafeExecutionReceipt(receipt);
    sets.push('resultReceipt = :receipt', 'resultReceiptRef = :receiptRef');
    values[':receipt'] = receipt;
    values[':receiptRef'] = receipt.receiptId;
  }
  try {
    const result = await client.send(new UpdateCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `ATTEMPT#${attemptId}`, SK: 'META' },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: '#status = :unknown AND revision = :revision',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    }));
    return clean<ExecutionAttempt>(result.Attributes as Record<string, unknown>);
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return null;
    throw error;
  }
}

async function manuallyResolveAttempt(
  client: DynamoDBDocumentClient,
  attemptId: string,
  expectedRevision: number,
  resolution: NonNullable<ExecutionAttempt['manualResolution']>,
  privateResult?: JsonValue,
  receipt?: SafeExecutionReceipt
): Promise<ExecutionAttempt | null> {
  if (receipt) validateSafeExecutionReceipt(receipt);
  const existing = privateResult === undefined
    ? null
    : clean<ExecutionAttempt>((await client.send(new GetCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `ATTEMPT#${attemptId}`, SK: 'META' },
      ConsistentRead: true,
    }))).Item as Record<string, unknown> | undefined);
  const sets = [
    '#status = :resolved',
    'manualResolution = :resolution',
    'updatedAt = :now',
    'revision = revision + :one',
    'recoveryBlocked = :true',
    'GSI2PK = :state',
    'GSI2SK = :sort',
  ];
  const values: Record<string, unknown> = {
    ':resolved': 'manually_resolved', ':unknown': 'outcome_unknown',
    ':resolution': resolution, ':now': resolution.resolvedAt, ':one': 1,
    ':revision': expectedRevision, ':true': true,
    ':state': 'ATTEMPT_STATE#manually_resolved',
    ':sort': `READY#${resolution.resolvedAt}#LEASE#-#${attemptId}`,
  };
  if (receipt) {
    sets.push('resultReceipt = :receipt', 'resultReceiptRef = :receiptRef');
    values[':receipt'] = receipt;
    values[':receiptRef'] = receipt.receiptId;
  }
  const update = {
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `ATTEMPT#${attemptId}`, SK: 'META' },
    UpdateExpression: `SET ${sets.join(', ')}`,
    ConditionExpression: '#status = :unknown AND revision = :revision',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: values,
    ReturnValues: 'ALL_NEW',
  } as const;
  try {
    if (privateResult !== undefined) {
      if (
        !existing
        || existing.status !== 'outcome_unknown'
        || existing.revision !== expectedRevision
        || !existing.actorId
        || !existing.identityChannel
        || !existing.identityChannelUserId
        || !existing.identityBindingId
        || !existing.identityBindingRevision
        || !existing.channelBindingId
        || !existing.channelConversationKey
      ) return null;
      const retention = expiryFrom(resolution.resolvedAt, 30);
      const payloadId = `execution-manual-result-${attemptId}`;
      const notificationId = `result-notification-manual-${attemptId}`;
      const payload = {
        id: payloadId,
        recordType: 'conversational_private_payload' as const,
        schemaVersion: 1,
        createdAt: resolution.resolvedAt,
        updatedAt: resolution.resolvedAt,
        ...retention,
        conversationId: existing.conversationId,
        classification: 'private' as const,
        content: {
          kind: 'execution_result',
          executionAttemptId: attemptId,
          status: 'manually_resolved',
          result: privateResult,
        },
      };
      const notification = {
        id: notificationId,
        recordType: 'result_notification' as const,
        schemaVersion: 1,
        createdAt: resolution.resolvedAt,
        updatedAt: resolution.resolvedAt,
        ...retention,
        conversationId: existing.conversationId,
        executionAttemptId: attemptId,
        actorId: existing.actorId,
        channel: existing.identityChannel,
        channelConversationKey: existing.channelConversationKey,
        identityChannelUserId: existing.identityChannelUserId,
        identityBindingId: existing.identityBindingId,
        identityBindingRevision: existing.identityBindingRevision,
        channelBindingId: existing.channelBindingId,
        privatePayloadRef: payloadId,
        status: 'pending' as const,
        readyAt: resolution.resolvedAt,
        revision: 1,
      };
      validateConversationalRecord(payload);
      validateConversationalRecord(notification);
      const payloadItem = {
        ...payload,
        PK: `PRIVATE_PAYLOAD#${payloadId}`,
        SK: 'META',
        GSI1PK: `CONVERSATION#${existing.conversationId}`,
        GSI1SK: `PRIVATE_PAYLOAD#${payloadId}`,
      };
      const notificationItem = {
        ...notification,
        PK: `RESULT_NOTIFICATION#${notificationId}`,
        SK: 'META',
        GSI1PK: `CONVERSATION#${existing.conversationId}`,
        GSI1SK: `RESULT_NOTIFICATION#${resolution.resolvedAt}#${notificationId}`,
        GSI2PK: 'RESULT_NOTIFICATION_STATE#pending',
        GSI2SK: `READY#${resolution.resolvedAt}#${notificationId}`,
      };
      if (process.env.NODE_ENV !== 'test') {
        const { ReturnValues: _returnValues, ...transactionUpdate } = update;
        await client.send(new TransactWriteCommand({
          TransactItems: [
            { Update: transactionUpdate },
            {
              Put: {
                TableName: TABLE_CONVERSATIONAL_STATE,
                Item: payloadItem,
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Put: {
                TableName: TABLE_CONVERSATIONAL_STATE,
                Item: notificationItem,
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        }));
        const stored = await client.send(new GetCommand({
          TableName: TABLE_CONVERSATIONAL_STATE,
          Key: { PK: `ATTEMPT#${attemptId}`, SK: 'META' },
          ConsistentRead: true,
        }));
        return clean<ExecutionAttempt>(stored.Item as Record<string, unknown> | undefined);
      }
      const result = await client.send(new UpdateCommand(update));
      await client.send(new PutCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Item: payloadItem,
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
      await client.send(new PutCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Item: notificationItem,
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
      return clean<ExecutionAttempt>(result.Attributes as Record<string, unknown>);
    }
    const result = await client.send(new UpdateCommand(update));
    return clean<ExecutionAttempt>(result.Attributes as Record<string, unknown>);
  } catch (error) {
    if (
      ['ConditionalCheckFailedException', 'TransactionCanceledException']
        .includes((error as { name?: string }).name || '')
    ) return null;
    throw error;
  }
}

async function queryDueAttempts(
  client: DynamoDBDocumentClient,
  status: 'queued' | 'executing',
  through: string,
  limit = 50
): Promise<ExecutionAttempt[]> {
  const result = await client.send(new QueryCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    IndexName: 'GSI2',
    KeyConditionExpression: 'GSI2PK = :state AND GSI2SK <= :through',
    ExpressionAttributeValues: {
      ':state': `ATTEMPT_STATE#${status}`,
      ':through': `READY#${through}#\uffff`,
    },
    Limit: Math.min(Math.max(limit, 1), 100),
  }));
  return ((result.Items || []) as Record<string, unknown>[]).map((item) => clean<ExecutionAttempt>(item)!);
}

export type { DispatchStateGuard };
export {
  claimQueuedAttempt,
  finalizeAttempt,
  manuallyResolveAttempt,
  markDispatchStarted,
  queryDueAttempts,
  reclaimDispatchedAttempt,
  reconcileUnknownAttempt,
  releaseUndispatchedAttempt,
  requeueUndispatchedAttempt,
};
