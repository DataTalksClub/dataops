import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import { TABLE_CONVERSATIONAL_STATE } from '../db/tableNames';
import {
  expiryFrom,
  isExpired,
  validateConversationalRecord,
  type ConversationEvent,
  type ConversationalPrivatePayload,
  type JsonValue,
} from './types';
import { clean, conditionalFailure, storageItem, type Key } from './conversationStorage';
import { getRawConversation, requireOwner } from './conversations';
import {
  getConversationalPrivatePayload,
  type StagedMediaControlLink,
} from './privatePayloads';
import { appendConversationEvent, getConversationEventByIdempotency } from './conversationEvents';

interface ConsumeActionInput {
  actionId: string;
  siblingActionIds?: string[];
  conversationId: string;
  ownerUserId: string;
  actorId: string;
  identityBindingId: string;
  channelBindingId: string;
  channelConversationKey: string;
  expectedConversationRevision: number;
  consumedAt: string;
}
interface TransitionStagedMediaInput extends ConsumeActionInput {
  mediaPayloadId: string;
  expectedMediaRevision: number;
  terminalStatus: 'used' | 'discarded' | 'corrected';
  correctionPayload?: ConversationalPrivatePayload;
}

const testActionLocks = new Map<string, Promise<void>>();

async function transitionStagedMediaAndAppend(
  client: DynamoDBDocumentClient,
  input: TransitionStagedMediaInput,
  event: ConversationEvent
): Promise<{
  media: ConversationalPrivatePayload;
  event: ConversationEvent;
  duplicate: boolean;
} | null> {
  validateConversationalRecord(event);
  if (input.correctionPayload) validateConversationalRecord(input.correctionPayload);
  const actionIds = [input.actionId, ...(input.siblingActionIds || [])];
  if (
    event.conversationId !== input.conversationId
    || event.sequence < 1
    || event.direction !== 'inbound'
    || actionIds.length < 1
    || actionIds.length > 8
    || new Set(actionIds).size !== actionIds.length
    || (input.terminalStatus === 'corrected') !== Boolean(input.correctionPayload)
    || (
      input.correctionPayload
      && (
        input.correctionPayload.conversationId !== input.conversationId
        || event.payloadRef !== input.correctionPayload.id
      )
    )
  ) throw new Error('staged media transition binding is invalid');

  const [mediaResult, actionResults] = await Promise.all([
    client.send(new GetCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `PRIVATE_PAYLOAD#${input.mediaPayloadId}`, SK: 'META' },
    })),
    Promise.all(actionIds.map((id) => client.send(new GetCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `PRIVATE_PAYLOAD#${id}`, SK: 'META' },
    })))),
  ]);
  const media = clean<ConversationalPrivatePayload>(
    mediaResult.Item as Record<string, unknown> | undefined
  );
  const mediaContent = media?.content && typeof media.content === 'object' && !Array.isArray(media.content)
    ? media.content as Record<string, JsonValue>
    : null;
  const actions = actionResults.map((result) => clean<ConversationalPrivatePayload>(
    result.Item as Record<string, unknown> | undefined
  ));
  const actionContents = actions.map((action) => (
    action?.content && typeof action.content === 'object' && !Array.isArray(action.content)
      ? action.content as Record<string, JsonValue>
      : null
  ));
  const mediaControlActionIds = Array.isArray(mediaContent?.controlActionIds)
    ? mediaContent.controlActionIds.filter((value): value is string => typeof value === 'string')
    : [];
  const baseActionBindingMatches = actionContents.every((content, index) => (
    actions[index]?.conversationId === input.conversationId
    && content?.kind === 'telegram_action'
    && content.actorId === input.actorId
    && content.identityBindingId === input.identityBindingId
    && content.channelBindingId === input.channelBindingId
    && content.channelConversationKey === input.channelConversationKey
    && content.expectedConversationRevision === input.expectedConversationRevision
    && (
      content.action && typeof content.action === 'object' && !Array.isArray(content.action)
      && (content.action as Record<string, JsonValue>).payloadRef === input.mediaPayloadId
    )
  ));
  const mediaBindingMatches = Boolean(
    media
    && media.conversationId === input.conversationId
    && (
      mediaContent?.revision === input.expectedMediaRevision
      || mediaContent?.revision === input.expectedMediaRevision + 1
    )
    && mediaControlActionIds.length === actionIds.length
    && actionIds.every((id) => mediaControlActionIds.includes(id))
  );
  if (!media || !baseActionBindingMatches || !mediaBindingMatches) return null;

  const duplicate = await getConversationEventByIdempotency(
    client, event.channel, event.idempotencyKey, event.conversationId
  );
  if (duplicate && mediaContent?.status === input.terminalStatus) {
    return { media, event: duplicate, duplicate: true };
  }
  if (
    duplicate
    || mediaContent?.status !== 'staged'
    || actionContents.some((content) => content?.status !== 'active')
    || isExpired(media, new Date(input.consumedAt))
    || actions.some((action) => !action || isExpired(action, new Date(input.consumedAt)))
  ) return null;

  const retention = expiryFrom(input.consumedAt, 30);
  const mediaKey = { PK: `PRIVATE_PAYLOAD#${input.mediaPayloadId}`, SK: 'META' };
  const actionBindingValues = {
    ':active': 'active',
    ':now': input.consumedAt,
    ':conversationId': input.conversationId,
    ':actorId': input.actorId,
    ':identityBindingId': input.identityBindingId,
    ':channelBindingId': input.channelBindingId,
    ':channelConversationKey': input.channelConversationKey,
    ':expectedConversationRevision': input.expectedConversationRevision,
    ':mediaPayloadId': input.mediaPayloadId,
  };
  const actionUpdate = (id: string, status: 'consumed' | 'revoked') => ({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `PRIVATE_PAYLOAD#${id}`, SK: 'META' },
    UpdateExpression: status === 'consumed'
      ? 'SET #content.#status = :consumed, #content.consumedAt = :now, updatedAt = :now'
      : 'SET #content.#status = :revoked, #content.revokedAt = :now, updatedAt = :now',
    ConditionExpression: 'conversationId = :conversationId AND #content.#status = :active AND #content.actorId = :actorId AND #content.identityBindingId = :identityBindingId AND #content.channelBindingId = :channelBindingId AND #content.channelConversationKey = :channelConversationKey AND #content.expectedConversationRevision = :expectedConversationRevision AND #content.#action.payloadRef = :mediaPayloadId',
    ExpressionAttributeNames: { '#content': 'content', '#status': 'status', '#action': 'action' },
    ExpressionAttributeValues: {
      ...actionBindingValues,
      ...(status === 'consumed' ? { ':consumed': 'consumed' } : { ':revoked': 'revoked' }),
    },
  });
  const mediaUpdate = {
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: mediaKey,
    UpdateExpression: input.terminalStatus === 'used'
      ? 'SET #content.#status = :terminal, #content.terminalAt = :now, #content.revision = :nextMediaRevision, updatedAt = :now, expiresAt = :expiresAt, #ttl = :ttl'
      : 'SET #content.#status = :terminal, #content.terminalAt = :now, #content.revision = :nextMediaRevision, updatedAt = :now, expiresAt = :expiresAt, #ttl = :ttl REMOVE #content.#text, #content.caption',
    ConditionExpression: 'conversationId = :conversationId AND #content.#status = :staged AND #content.revision = :mediaRevision AND expiresAt > :now',
    ExpressionAttributeNames: {
      '#content': 'content',
      '#status': 'status',
      '#ttl': 'ttl',
      ...(input.terminalStatus === 'used' ? {} : { '#text': 'text' }),
    },
    ExpressionAttributeValues: {
      ':conversationId': input.conversationId,
      ':staged': 'staged',
      ':terminal': input.terminalStatus,
      ':mediaRevision': input.expectedMediaRevision,
      ':nextMediaRevision': input.expectedMediaRevision + 1,
      ':now': input.consumedAt,
      ':expiresAt': retention.expiresAt,
      ':ttl': retention.ttl,
    },
  };
  const eventItem = storageItem(event);
  const markerKey = { PK: `IDEMPOTENCY#${event.channel}#${event.idempotencyKey}`, SK: 'MARKER' };
  const marker = {
    ...markerKey,
    recordType: 'event_idempotency_marker',
    eventId: event.id,
    conversationId: event.conversationId,
    sequence: event.sequence,
    eventPK: eventItem.PK,
    eventSK: eventItem.SK,
    expiresAt: event.expiresAt,
    ttl: event.ttl,
    GSI1PK: `CONVERSATION#${event.conversationId}`,
    GSI1SK: `IDEMPOTENCY#${event.channel}#${event.idempotencyKey}`,
  };
  const conversationExpiry = expiryFrom(event.createdAt, 30);
  const conversationUpdate = {
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `CONVERSATION#${input.conversationId}`, SK: 'META' },
    UpdateExpression: 'SET nextEventSequence = :next, revision = revision + :one, updatedAt = :now, expiresAt = :expiresAt, #ttl = :ttl, GSI1SK = :ownerSort',
    ConditionExpression: 'ownerUserId = :owner AND revision = :revision AND nextEventSequence = :sequence AND #status = :active',
    ExpressionAttributeNames: { '#status': 'status', '#ttl': 'ttl' },
    ExpressionAttributeValues: {
      ':owner': input.ownerUserId,
      ':revision': input.expectedConversationRevision,
      ':sequence': event.sequence,
      ':active': 'active',
      ':next': event.sequence + 1,
      ':one': 1,
      ':now': event.createdAt,
      ':expiresAt': conversationExpiry.expiresAt,
      ':ttl': conversationExpiry.ttl,
      ':ownerSort': `CONVERSATION#${event.createdAt}#${event.conversationId}`,
    },
  };
  const chosenStatus = input.terminalStatus === 'corrected' ? 'revoked' : 'consumed';

  if (process.env.NODE_ENV !== 'test') {
    try {
      await client.send(new TransactWriteCommand({
        TransactItems: [
          { Update: mediaUpdate },
          ...actionIds.map((id, index) => ({
            Update: actionUpdate(id, index === 0 ? chosenStatus : 'revoked'),
          })),
          ...(input.correctionPayload ? [{
            Put: {
              TableName: TABLE_CONVERSATIONAL_STATE,
              Item: storageItem(input.correctionPayload),
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          }] : []),
          {
            Put: {
              TableName: TABLE_CONVERSATIONAL_STATE,
              Item: marker,
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Put: {
              TableName: TABLE_CONVERSATIONAL_STATE,
              Item: eventItem,
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          { Update: conversationUpdate },
        ],
      }));
      const terminalContent: Record<string, JsonValue> = {
        ...mediaContent,
        status: input.terminalStatus,
        terminalAt: input.consumedAt,
        revision: input.expectedMediaRevision + 1,
      };
      if (input.terminalStatus !== 'used') {
        delete terminalContent.text;
        delete terminalContent.caption;
      }
      return {
        media: {
          ...media,
          updatedAt: input.consumedAt,
          ...retention,
          content: terminalContent,
        },
        event,
        duplicate: false,
      };
    } catch (error) {
      if (!conditionalFailure(error)) throw error;
      const resolved = await getConversationEventByIdempotency(
        client, event.channel, event.idempotencyKey, event.conversationId
      );
      if (!resolved) return null;
      const currentMedia = await getConversationalPrivatePayload(
        client, input.conversationId, input.mediaPayloadId, input.ownerUserId,
        new Date(input.consumedAt)
      );
      return currentMedia && objectContentStatus(currentMedia) === input.terminalStatus
        ? { media: currentMedia, event: resolved, duplicate: true }
        : null;
    }
  }

  const lockKey = [input.mediaPayloadId, ...actionIds].sort().join('|');
  const prior = testActionLocks.get(lockKey) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const chain = prior.then(() => current);
  testActionLocks.set(lockKey, chain);
  await prior;
  try {
    const currentMediaResult = await client.send(new GetCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: mediaKey,
    }));
    const currentMedia = clean<ConversationalPrivatePayload>(
      currentMediaResult.Item as Record<string, unknown> | undefined
    );
    if (objectContentStatus(currentMedia) !== 'staged') return null;
    const currentConversation = await getRawConversation(client, input.conversationId);
    if (
      !currentConversation
      || currentConversation.ownerUserId !== input.ownerUserId
      || currentConversation.revision !== input.expectedConversationRevision
      || currentConversation.nextEventSequence !== event.sequence
      || currentConversation.status !== 'active'
    ) return null;
    const currentActionResults = await Promise.all(actionIds.map((id) => client.send(new GetCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: `PRIVATE_PAYLOAD#${id}`, SK: 'META' },
    }))));
    if (currentActionResults.some((result) => (
      objectContentStatus(clean<ConversationalPrivatePayload>(
        result.Item as Record<string, unknown> | undefined
      )) !== 'active'
    ))) return null;

    const updatedMedia: ConversationalPrivatePayload = {
      ...currentMedia!,
      updatedAt: input.consumedAt,
      ...retention,
      content: {
        ...(currentMedia!.content as Record<string, JsonValue>),
        status: input.terminalStatus,
        terminalAt: input.consumedAt,
        revision: input.expectedMediaRevision + 1,
      },
    };
    if (input.terminalStatus !== 'used') {
      delete (updatedMedia.content as Record<string, JsonValue>).text;
      delete (updatedMedia.content as Record<string, JsonValue>).caption;
    }
    await client.send(new UpdateCommand(mediaUpdate));
    const updatedActionIds: string[] = [];
    try {
      for (const [index, id] of actionIds.entries()) {
        await client.send(new UpdateCommand(actionUpdate(
          id, index === 0 ? chosenStatus : 'revoked'
        )));
        updatedActionIds.push(id);
      }
      if (input.correctionPayload) {
        await client.send(new PutCommand({
          TableName: TABLE_CONVERSATIONAL_STATE,
          Item: storageItem(input.correctionPayload),
          ConditionExpression: 'attribute_not_exists(PK)',
        }));
      }
      const appended = await appendConversationEvent(
        client, event, input.expectedConversationRevision
      );
      return { media: updatedMedia, event: appended.event, duplicate: appended.duplicate };
    } catch (error) {
      if (input.correctionPayload) {
        await client.send(new DeleteCommand({
          TableName: TABLE_CONVERSATIONAL_STATE,
          Key: { PK: `PRIVATE_PAYLOAD#${input.correctionPayload.id}`, SK: 'META' },
        })).catch(() => undefined);
      }
      for (const id of updatedActionIds) {
        const original = actions[actionIds.indexOf(id)];
        if (original) {
          await client.send(new PutCommand({
            TableName: TABLE_CONVERSATIONAL_STATE,
            Item: storageItem(original),
          })).catch(() => undefined);
        }
      }
      await client.send(new PutCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Item: storageItem(currentMedia!),
      })).catch(() => undefined);
      throw error;
    }
  } finally {
    release();
    if (testActionLocks.get(lockKey) === chain) testActionLocks.delete(lockKey);
  }
}

function objectContentStatus(payload: ConversationalPrivatePayload | null): JsonValue | undefined {
  return payload?.content && typeof payload.content === 'object' && !Array.isArray(payload.content)
    ? (payload.content as Record<string, JsonValue>).status
    : undefined;
}

async function consumeConversationalAction(
  client: DynamoDBDocumentClient,
  input: ConsumeActionInput
): Promise<ConversationalPrivatePayload | null> {
  await requireOwner(client, input.conversationId, input.ownerUserId, new Date(input.consumedAt));
  const key = { PK: `PRIVATE_PAYLOAD#${input.actionId}`, SK: 'META' };
  const existingResult = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: key,
  }));
  const existing = clean<ConversationalPrivatePayload>(
    existingResult.Item as Record<string, unknown> | undefined
  );
  const content = existing?.content && typeof existing.content === 'object' && !Array.isArray(existing.content)
    ? existing.content as Record<string, JsonValue>
    : null;
  if (
    !existing
    || existing.conversationId !== input.conversationId
    || isExpired(existing, new Date(input.consumedAt))
    || content?.kind !== 'telegram_action'
    || content.status !== 'active'
    || content.actorId !== input.actorId
    || content.identityBindingId !== input.identityBindingId
    || content.channelBindingId !== input.channelBindingId
    || content.channelConversationKey !== input.channelConversationKey
    || content.expectedConversationRevision !== input.expectedConversationRevision
  ) return null;

  const names = { '#content': 'content', '#status': 'status' };
  const bindingValues = {
    ':active': 'active',
    ':now': input.consumedAt,
    ':conversationId': input.conversationId,
    ':actorId': input.actorId,
    ':identityBindingId': input.identityBindingId,
    ':channelBindingId': input.channelBindingId,
    ':channelConversationKey': input.channelConversationKey,
    ':expectedConversationRevision': input.expectedConversationRevision,
  };
  const actionUpdate = {
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: key,
    UpdateExpression: 'SET #content.#status = :consumed, #content.consumedAt = :now, updatedAt = :now',
    ConditionExpression: 'conversationId = :conversationId AND #content.#status = :active AND #content.actorId = :actorId AND #content.identityBindingId = :identityBindingId AND #content.channelBindingId = :channelBindingId AND #content.channelConversationKey = :channelConversationKey AND #content.expectedConversationRevision = :expectedConversationRevision',
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: { ...bindingValues, ':consumed': 'consumed' },
  };
  const siblingUpdates = (input.siblingActionIds || []).map((siblingActionId) => ({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `PRIVATE_PAYLOAD#${siblingActionId}`, SK: 'META' },
    UpdateExpression: 'SET #content.#status = :revoked, updatedAt = :now',
    ConditionExpression: 'conversationId = :conversationId AND #content.#status = :active AND #content.actorId = :actorId AND #content.identityBindingId = :identityBindingId AND #content.channelBindingId = :channelBindingId AND #content.channelConversationKey = :channelConversationKey AND #content.expectedConversationRevision = :expectedConversationRevision',
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: { ...bindingValues, ':revoked': 'revoked' },
  }));
  const conversationCheck = {
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `CONVERSATION#${input.conversationId}`, SK: 'META' },
    ConditionExpression: 'ownerUserId = :owner AND revision = :revision AND #status = :active',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':owner': input.ownerUserId,
      ':revision': input.expectedConversationRevision,
      ':active': 'active',
    },
  };
  try {
    if (process.env.NODE_ENV !== 'test') {
      await client.send(new TransactWriteCommand({
        TransactItems: [
          { ConditionCheck: conversationCheck },
          { Update: actionUpdate },
          ...siblingUpdates.map((update) => ({ Update: update })),
        ],
      }));
    } else {
      const conversation = await getRawConversation(client, input.conversationId);
      if (
        !conversation
        || conversation.ownerUserId !== input.ownerUserId
        || conversation.status !== 'active'
        || conversation.revision !== input.expectedConversationRevision
      ) return null;
      await client.send(new UpdateCommand(actionUpdate));
      const revokedSiblingKeys: Key[] = [];
      for (const siblingUpdate of siblingUpdates) {
        try {
          await client.send(new UpdateCommand(siblingUpdate));
          revokedSiblingKeys.push(siblingUpdate.Key);
        } catch (error) {
          await client.send(new UpdateCommand({
            TableName: TABLE_CONVERSATIONAL_STATE,
            Key: key,
            UpdateExpression: 'SET #content.#status = :active REMOVE #content.consumedAt',
            ConditionExpression: '#content.#status = :consumed AND #content.consumedAt = :now',
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: {
              ':active': 'active', ':consumed': 'consumed', ':now': input.consumedAt,
            },
          }));
          for (const siblingKey of revokedSiblingKeys) {
            await client.send(new UpdateCommand({
              TableName: TABLE_CONVERSATIONAL_STATE,
              Key: siblingKey,
              UpdateExpression: 'SET #content.#status = :active',
              ConditionExpression: '#content.#status = :revoked AND updatedAt = :now',
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: {
                ':active': 'active', ':revoked': 'revoked', ':now': input.consumedAt,
              },
            })).catch(() => undefined);
          }
          throw error;
        }
      }
    }
  } catch (error) {
    if (conditionalFailure(error)) return null;
    throw error;
  }
  return {
    ...existing,
    updatedAt: input.consumedAt,
    content: { ...content, status: 'consumed', consumedAt: input.consumedAt },
  };
}

async function consumeConversationalActionAndAppend(
  client: DynamoDBDocumentClient,
  input: ConsumeActionInput,
  event: ConversationEvent
): Promise<{ action: ConversationalPrivatePayload; event: ConversationEvent; duplicate: boolean } | null> {
  validateConversationalRecord(event);
  if (
    event.conversationId !== input.conversationId
    || event.sequence < 1
    || event.direction !== 'inbound'
  ) throw new Error('action event binding is invalid');
  const duplicate = await getConversationEventByIdempotency(
    client, event.channel, event.idempotencyKey, event.conversationId
  );
  const actionResult = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `PRIVATE_PAYLOAD#${input.actionId}`, SK: 'META' },
  }));
  const action = clean<ConversationalPrivatePayload>(
    actionResult.Item as Record<string, unknown> | undefined
  );
  const content = action?.content && typeof action.content === 'object' && !Array.isArray(action.content)
    ? action.content as Record<string, JsonValue>
    : null;
  const bindingMatches = Boolean(
    action
    && action.conversationId === input.conversationId
    && !isExpired(action, new Date(input.consumedAt))
    && content?.kind === 'telegram_action'
    && content.actorId === input.actorId
    && content.identityBindingId === input.identityBindingId
    && content.channelBindingId === input.channelBindingId
    && content.channelConversationKey === input.channelConversationKey
    && content.expectedConversationRevision === input.expectedConversationRevision
  );
  if (!bindingMatches || !action) return null;
  if (duplicate) return { action, event: duplicate, duplicate: true };
  if (content?.status !== 'active') return null;

  if (process.env.NODE_ENV === 'test') {
    const lockKey = [input.actionId, ...(input.siblingActionIds || [])].sort().join('|');
    const prior = testActionLocks.get(lockKey) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const chain = prior.then(() => current);
    testActionLocks.set(lockKey, chain);
    await prior;
    try {
      const consumed = await consumeConversationalAction(client, input);
      if (!consumed) return null;
      try {
        const appended = await appendConversationEvent(client, event, input.expectedConversationRevision);
        return { action: consumed, event: appended.event, duplicate: appended.duplicate };
      } catch (error) {
        const actionIds = [input.actionId, ...(input.siblingActionIds || [])];
        for (const actionId of actionIds) {
          await client.send(new UpdateCommand({
            TableName: TABLE_CONVERSATIONAL_STATE,
            Key: { PK: `PRIVATE_PAYLOAD#${actionId}`, SK: 'META' },
            UpdateExpression: 'SET #content.#status = :active REMOVE #content.consumedAt',
            ConditionExpression: '#content.#status IN (:consumed, :revoked) AND updatedAt = :now',
            ExpressionAttributeNames: { '#content': 'content', '#status': 'status' },
            ExpressionAttributeValues: {
              ':active': 'active', ':consumed': 'consumed', ':revoked': 'revoked', ':now': input.consumedAt,
            },
          })).catch(() => undefined);
        }
        throw error;
      }
    } finally {
      release();
      if (testActionLocks.get(lockKey) === chain) testActionLocks.delete(lockKey);
    }
  }

  const eventItem = storageItem(event);
  const markerKey = { PK: `IDEMPOTENCY#${event.channel}#${event.idempotencyKey}`, SK: 'MARKER' };
  const marker = {
    ...markerKey,
    recordType: 'event_idempotency_marker',
    eventId: event.id,
    conversationId: event.conversationId,
    sequence: event.sequence,
    eventPK: eventItem.PK,
    eventSK: eventItem.SK,
    expiresAt: event.expiresAt,
    ttl: event.ttl,
    GSI1PK: `CONVERSATION#${event.conversationId}`,
    GSI1SK: `IDEMPOTENCY#${event.channel}#${event.idempotencyKey}`,
  };
  const names = { '#content': 'content', '#status': 'status' };
  const bindingValues = {
    ':active': 'active',
    ':now': input.consumedAt,
    ':conversationId': input.conversationId,
    ':actorId': input.actorId,
    ':identityBindingId': input.identityBindingId,
    ':channelBindingId': input.channelBindingId,
    ':channelConversationKey': input.channelConversationKey,
    ':expectedConversationRevision': input.expectedConversationRevision,
  };
  const actionUpdate = (actionId: string, status: 'consumed' | 'revoked') => ({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `PRIVATE_PAYLOAD#${actionId}`, SK: 'META' },
    UpdateExpression: status === 'consumed'
      ? 'SET #content.#status = :consumed, #content.consumedAt = :now, updatedAt = :now'
      : 'SET #content.#status = :revoked, updatedAt = :now',
    ConditionExpression: 'conversationId = :conversationId AND #content.#status = :active AND #content.actorId = :actorId AND #content.identityBindingId = :identityBindingId AND #content.channelBindingId = :channelBindingId AND #content.channelConversationKey = :channelConversationKey AND #content.expectedConversationRevision = :expectedConversationRevision',
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: {
      ...bindingValues,
      ...(status === 'consumed' ? { ':consumed': 'consumed' } : { ':revoked': 'revoked' }),
    },
  });
  const conversationExpiry = expiryFrom(event.createdAt, 30);
  try {
    await client.send(new TransactWriteCommand({
      TransactItems: [
        { Update: actionUpdate(input.actionId, 'consumed') },
        ...(input.siblingActionIds || []).map((id) => ({ Update: actionUpdate(id, 'revoked') })),
        {
          Put: {
            TableName: TABLE_CONVERSATIONAL_STATE,
            Item: marker,
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        {
          Put: {
            TableName: TABLE_CONVERSATIONAL_STATE,
            Item: eventItem,
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
        {
          Update: {
            TableName: TABLE_CONVERSATIONAL_STATE,
            Key: { PK: `CONVERSATION#${input.conversationId}`, SK: 'META' },
            UpdateExpression: 'SET nextEventSequence = :next, revision = revision + :one, updatedAt = :now, expiresAt = :expiresAt, #ttl = :ttl, GSI1SK = :ownerSort',
            ConditionExpression: 'ownerUserId = :owner AND revision = :revision AND nextEventSequence = :sequence AND #status = :active',
            ExpressionAttributeNames: { '#status': 'status', '#ttl': 'ttl' },
            ExpressionAttributeValues: {
              ':owner': input.ownerUserId,
              ':revision': input.expectedConversationRevision,
              ':sequence': event.sequence,
              ':active': 'active',
              ':next': event.sequence + 1,
              ':one': 1,
              ':now': event.createdAt,
              ':expiresAt': conversationExpiry.expiresAt,
              ':ttl': conversationExpiry.ttl,
              ':ownerSort': `CONVERSATION#${event.createdAt}#${event.conversationId}`,
            },
          },
        },
      ],
    }));
    return {
      action: {
        ...action,
        updatedAt: input.consumedAt,
        content: { ...content, status: 'consumed', consumedAt: input.consumedAt },
      },
      event,
      duplicate: false,
    };
  } catch (error) {
    if (!conditionalFailure(error)) throw error;
    const resolved = await getConversationEventByIdempotency(
      client, event.channel, event.idempotencyKey, event.conversationId
    );
    return resolved ? { action, event: resolved, duplicate: true } : null;
  }
}

export type { ConsumeActionInput, TransitionStagedMediaInput };
export {
  consumeConversationalAction,
  consumeConversationalActionAndAppend,
  transitionStagedMediaAndAppend,
};
