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
  type ConversationAuditEvent,
  type ConversationEvent,
  type ConversationalPrivatePayload,
  type PluginDraft,
  type SummaryCheckpoint,
} from './types';
import {
  clean,
  conditionalFailure,
  namedError,
  putAbsent,
  queryPage,
  storageItem,
  type Key,
  type Page,
} from './conversationStorage';
import { getRawConversation, requireConversation, requireOwner } from './conversations';
import {
  getConversationalPrivatePayload,
  type StagedMediaControlLink,
} from './privatePayloads';

interface AppendEventResult { event: ConversationEvent; duplicate: boolean }
interface AppendOutboundResult extends AppendEventResult {
  payload: ConversationalPrivatePayload;
}

async function appendConversationEvent(
  client: DynamoDBDocumentClient,
  event: ConversationEvent,
  expectedConversationRevision: number
): Promise<AppendEventResult> {
  validateConversationalRecord(event);
  const markerKey = {
    PK: `IDEMPOTENCY#${event.channel}#${event.idempotencyKey}`,
    SK: 'MARKER',
  };
  const eventItem = storageItem(event);
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
  if (process.env.NODE_ENV === 'test') {
    const existingMarker = await client.send(new GetCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: markerKey,
    }));
    if (existingMarker.Item) {
      const existing = await client.send(new GetCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Key: {
          PK: (existingMarker.Item as Record<string, unknown>).eventPK,
          SK: (existingMarker.Item as Record<string, unknown>).eventSK,
        },
      }));
      return { event: clean<ConversationEvent>(existing.Item as Record<string, unknown>)!, duplicate: true };
    }
    const owner = await getRawConversation(client, event.conversationId);
    if (
      !owner
      || owner.status === 'deleted'
      || isExpired(owner, new Date(event.createdAt))
      || owner.revision !== expectedConversationRevision
      || owner.nextEventSequence !== event.sequence
    ) {
      throw namedError('TransactionCanceledException', 'conversation revision or sequence changed');
    }
    let markerWritten = false;
    let eventWritten = false;
    try {
      const conversationExpiry = expiryFrom(event.createdAt, 30);
      await client.send(new PutCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Item: marker,
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
      markerWritten = true;
      await client.send(new PutCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Item: eventItem,
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
      eventWritten = true;
      await client.send(new UpdateCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Key: { PK: `CONVERSATION#${event.conversationId}`, SK: 'META' },
        UpdateExpression: 'SET nextEventSequence = :next, revision = revision + :one, updatedAt = :now, expiresAt = :expiresAt, #ttl = :ttl, GSI1SK = :ownerSort',
        ConditionExpression: 'revision = :revision AND nextEventSequence = :sequence',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':next': event.sequence + 1,
          ':one': 1,
          ':now': event.createdAt,
          ':revision': expectedConversationRevision,
          ':sequence': event.sequence,
          ':expiresAt': conversationExpiry.expiresAt,
          ':ttl': conversationExpiry.ttl,
          ':ownerSort': `CONVERSATION#${event.createdAt}#${event.conversationId}`,
        },
      }));
      return { event, duplicate: false };
    } catch (error) {
      if (markerWritten) {
        await client.send(new DeleteCommand({ TableName: TABLE_CONVERSATIONAL_STATE, Key: markerKey }));
      }
      if (eventWritten) {
        await client.send(new DeleteCommand({
          TableName: TABLE_CONVERSATIONAL_STATE,
          Key: { PK: eventItem.PK, SK: eventItem.SK },
        }));
      }
      if (conditionalFailure(error)) {
        if (!markerWritten) {
          const duplicate = await resolveDuplicateEvent(client, markerKey, event.conversationId);
          if (duplicate) return { event: duplicate, duplicate: true };
        }
        throw namedError('TransactionCanceledException', 'event append condition changed');
      }
      throw error;
    }
  }
  try {
    const conversationExpiry = expiryFrom(event.createdAt, 30);
    await client.send(new TransactWriteCommand({
      TransactItems: [
        {
          ConditionCheck: {
            TableName: TABLE_CONVERSATIONAL_STATE,
            Key: { PK: `CONVERSATION#${event.conversationId}`, SK: 'META' },
            ConditionExpression: 'revision = :revision AND nextEventSequence = :sequence AND #status <> :deleted AND (attribute_not_exists(expiresAt) OR expiresAt > :now)',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':revision': expectedConversationRevision,
              ':sequence': event.sequence,
              ':deleted': 'deleted',
              ':now': event.createdAt,
            },
          },
        },
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
            Key: { PK: `CONVERSATION#${event.conversationId}`, SK: 'META' },
            UpdateExpression: 'SET nextEventSequence = :next, revision = revision + :one, updatedAt = :now, expiresAt = :expiresAt, #ttl = :ttl, GSI1SK = :ownerSort',
            ExpressionAttributeNames: { '#ttl': 'ttl' },
            ExpressionAttributeValues: {
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
    return { event, duplicate: false };
  } catch (error) {
    if (!conditionalFailure(error)) throw error;
    const existingMarker = await client.send(new GetCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: markerKey,
    }));
    const markerItem = existingMarker.Item as Record<string, unknown> | undefined;
    if (!markerItem || markerItem.conversationId !== event.conversationId) throw error;
    const existing = await client.send(new GetCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: markerItem.eventPK, SK: markerItem.eventSK },
    }));
    const existingEvent = clean<ConversationEvent>(existing.Item as Record<string, unknown> | undefined);
    if (!existingEvent) throw error;
    return { event: existingEvent, duplicate: true };
  }
}

async function appendConversationOutbound(
  client: DynamoDBDocumentClient,
  event: ConversationEvent,
  expectedConversationRevision: number,
  ownerUserId: string,
  payload: ConversationalPrivatePayload,
  actions: ConversationalPrivatePayload[],
  stagedMediaControlLink?: StagedMediaControlLink
): Promise<AppendOutboundResult> {
  validateConversationalRecord(event);
  validateConversationalRecord(payload);
  actions.forEach((action) => validateConversationalRecord(action));
  if (
    event.direction !== 'outbound'
    || event.payloadRef !== payload.id
    || payload.conversationId !== event.conversationId
    || actions.length > 8
    || actions.some((action) => action.conversationId !== event.conversationId)
    || new Set([payload.id, ...actions.map((action) => action.id)]).size !== actions.length + 1
    || (
      stagedMediaControlLink !== undefined
      && (
        stagedMediaControlLink.actionIds.length !== actions.length
        || stagedMediaControlLink.actionIds.some((id, index) => id !== actions[index]?.id)
        || stagedMediaControlLink.payloadId === payload.id
        || stagedMediaControlLink.expectedPayloadRevision < 1
      )
    )
  ) throw new Error('outbound transaction records are not consistently bound');

  const markerKey = {
    PK: `IDEMPOTENCY#${event.channel}#${event.idempotencyKey}`,
    SK: 'MARKER',
  };
  const eventItem = storageItem(event);
  const payloadItem = storageItem(payload);
  const actionItems = actions.map(storageItem);
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
  if (process.env.NODE_ENV !== 'test') {
    try {
      await client.send(new TransactWriteCommand({
        TransactItems: [
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
            Put: {
              TableName: TABLE_CONVERSATIONAL_STATE,
              Item: payloadItem,
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          ...actionItems.map((item) => ({
            Put: {
              TableName: TABLE_CONVERSATIONAL_STATE,
              Item: item,
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          })),
          ...(stagedMediaControlLink ? [{
            Update: {
              TableName: TABLE_CONVERSATIONAL_STATE,
              Key: {
                PK: `PRIVATE_PAYLOAD#${stagedMediaControlLink.payloadId}`,
                SK: 'META',
              },
              UpdateExpression: 'SET #content.controlActionIds = :actionIds, updatedAt = :now',
              ConditionExpression: 'conversationId = :conversationId AND #content.#status = :staged AND #content.revision = :payloadRevision',
              ExpressionAttributeNames: { '#content': 'content', '#status': 'status' },
              ExpressionAttributeValues: {
                ':conversationId': event.conversationId,
                ':staged': 'staged',
                ':payloadRevision': stagedMediaControlLink.expectedPayloadRevision,
                ':actionIds': stagedMediaControlLink.actionIds,
                ':now': event.createdAt,
              },
            },
          }] : []),
          {
            Update: {
              TableName: TABLE_CONVERSATIONAL_STATE,
              Key: { PK: `CONVERSATION#${event.conversationId}`, SK: 'META' },
              UpdateExpression: 'SET nextEventSequence = :next, revision = revision + :one, updatedAt = :now, expiresAt = :expiresAt, #ttl = :ttl, GSI1SK = :ownerSort',
              ConditionExpression: 'ownerUserId = :owner AND revision = :revision AND nextEventSequence = :sequence AND #status = :active AND (attribute_not_exists(expiresAt) OR expiresAt > :now)',
              ExpressionAttributeNames: { '#status': 'status', '#ttl': 'ttl' },
              ExpressionAttributeValues: {
                ':owner': ownerUserId,
                ':revision': expectedConversationRevision,
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
      return { event, payload, duplicate: false };
    } catch (error) {
      if (!conditionalFailure(error)) throw error;
      const duplicate = await resolveDuplicateEvent(client, markerKey, event.conversationId);
      if (!duplicate?.payloadRef) throw error;
      const existingPayload = await getConversationalPrivatePayload(
        client, event.conversationId, duplicate.payloadRef, ownerUserId
      );
      if (!existingPayload) throw error;
      return { event: duplicate, payload: existingPayload, duplicate: true };
    }
  }

  const written: Key[] = [];
  let linkedMediaUpdated = false;
  try {
    for (const item of [payloadItem, ...actionItems]) {
      await client.send(new PutCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Item: item,
        ConditionExpression: 'attribute_not_exists(PK)',
      }));
      written.push({ PK: item.PK, SK: item.SK });
    }
    if (stagedMediaControlLink) {
      await client.send(new UpdateCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Key: {
          PK: `PRIVATE_PAYLOAD#${stagedMediaControlLink.payloadId}`,
          SK: 'META',
        },
        UpdateExpression: 'SET #content.controlActionIds = :actionIds, updatedAt = :now',
        ConditionExpression: 'conversationId = :conversationId AND #content.#status = :staged AND #content.revision = :payloadRevision',
        ExpressionAttributeNames: { '#content': 'content', '#status': 'status' },
        ExpressionAttributeValues: {
          ':conversationId': event.conversationId,
          ':staged': 'staged',
          ':payloadRevision': stagedMediaControlLink.expectedPayloadRevision,
          ':actionIds': stagedMediaControlLink.actionIds,
          ':now': event.createdAt,
        },
      }));
      linkedMediaUpdated = true;
    }
    const appended = await appendConversationEvent(client, event, expectedConversationRevision);
    return { event: appended.event, payload, duplicate: appended.duplicate };
  } catch (error) {
    const duplicate = await resolveDuplicateEvent(client, markerKey, event.conversationId);
    if (duplicate?.payloadRef) {
      const existingPayload = await getConversationalPrivatePayload(
        client, event.conversationId, duplicate.payloadRef, ownerUserId
      );
      if (existingPayload) return { event: duplicate, payload: existingPayload, duplicate: true };
    }
    for (const key of written.reverse()) {
      await client.send(new DeleteCommand({ TableName: TABLE_CONVERSATIONAL_STATE, Key: key }))
        .catch(() => undefined);
    }
    if (stagedMediaControlLink && linkedMediaUpdated) {
      await client.send(new UpdateCommand({
        TableName: TABLE_CONVERSATIONAL_STATE,
        Key: {
          PK: `PRIVATE_PAYLOAD#${stagedMediaControlLink.payloadId}`,
          SK: 'META',
        },
        UpdateExpression: 'REMOVE #content.controlActionIds',
        ConditionExpression: '#content.#status = :staged AND #content.revision = :payloadRevision AND updatedAt = :now',
        ExpressionAttributeNames: { '#content': 'content', '#status': 'status' },
        ExpressionAttributeValues: {
          ':staged': 'staged',
          ':payloadRevision': stagedMediaControlLink.expectedPayloadRevision,
          ':now': event.createdAt,
        },
      })).catch(() => undefined);
    }
    throw error;
  }
}

async function resolveDuplicateEvent(
  client: DynamoDBDocumentClient,
  markerKey: Key,
  conversationId: string
): Promise<ConversationEvent | null> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const markerResult = await client.send(new GetCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: markerKey,
    }));
    const marker = markerResult.Item as Record<string, unknown> | undefined;
    if (!marker || marker.conversationId !== conversationId) return null;
    const result = await client.send(new GetCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      Key: { PK: marker.eventPK, SK: marker.eventSK },
    }));
    const event = clean<ConversationEvent>(result.Item as Record<string, unknown> | undefined);
    if (event) return event;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return null;
}

async function listConversationEvents(
  client: DynamoDBDocumentClient,
  conversationId: string,
  ownerUserId: string,
  cursor?: Key,
  limit = 50,
  now = new Date()
): Promise<Page<ConversationEvent>> {
  await requireOwner(client, conversationId, ownerUserId, now);
  const page = await queryPage<ConversationEvent>(client, {
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `CONVERSATION#${conversationId}`, ':prefix': 'EVENT#' },
  }, cursor, limit);
  page.items = page.items.filter((item) => !isExpired(item, now));
  return page;
}

async function saveCheckpoint(
  client: DynamoDBDocumentClient,
  checkpoint: SummaryCheckpoint,
  expectedRevision: number | null
): Promise<void> {
  validateConversationalRecord(checkpoint);
  await requireConversation(client, checkpoint.conversationId);
  await client.send(new PutCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Item: storageItem(checkpoint),
    ConditionExpression: expectedRevision === null ? 'attribute_not_exists(PK)' : 'revision = :expected',
    ...(expectedRevision === null ? {} : { ExpressionAttributeValues: { ':expected': expectedRevision } }),
  }));
}

async function getCheckpoint(
  client: DynamoDBDocumentClient,
  conversationId: string,
  ownerUserId: string,
  now = new Date()
): Promise<SummaryCheckpoint | null> {
  await requireOwner(client, conversationId, ownerUserId, now);
  const result = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `CONVERSATION#${conversationId}`, SK: 'SUMMARY#CURRENT' },
  }));
  const checkpoint = clean<SummaryCheckpoint>(result.Item as Record<string, unknown> | undefined);
  return !checkpoint || isExpired(checkpoint, now) ? null : checkpoint;
}

async function savePluginDraft(
  client: DynamoDBDocumentClient,
  draft: PluginDraft,
  expectedRevision: number | null
): Promise<void> {
  validateConversationalRecord(draft);
  await requireConversation(client, draft.conversationId);
  await client.send(new PutCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Item: storageItem(draft),
    ConditionExpression: expectedRevision === null ? 'attribute_not_exists(PK)' : 'revision = :expected',
    ...(expectedRevision === null ? {} : { ExpressionAttributeValues: { ':expected': expectedRevision } }),
  }));
}

async function getPluginDraft(
  client: DynamoDBDocumentClient,
  conversationId: string,
  draftId: string,
  ownerUserId: string,
  now = new Date()
): Promise<PluginDraft | null> {
  await requireOwner(client, conversationId, ownerUserId, now);
  const result = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `CONVERSATION#${conversationId}`, SK: `DRAFT#${draftId}` },
  }));
  const draft = clean<PluginDraft>(result.Item as Record<string, unknown> | undefined);
  return !draft || isExpired(draft, now) ? null : draft;
}

async function appendConversationAuditEvent(
  client: DynamoDBDocumentClient,
  auditEvent: ConversationAuditEvent
): Promise<void> {
  validateConversationalRecord(auditEvent);
  await requireConversation(client, auditEvent.conversationId);
  await putAbsent(client, auditEvent);
}

async function getConversationEventByIdempotency(
  client: DynamoDBDocumentClient,
  channel: string,
  idempotencyKey: string,
  conversationId: string
): Promise<ConversationEvent | null> {
  const markerResult = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: `IDEMPOTENCY#${channel}#${idempotencyKey}`, SK: 'MARKER' },
  }));
  const marker = markerResult.Item as Record<string, unknown> | undefined;
  if (!marker || marker.conversationId !== conversationId) return null;
  const result = await client.send(new GetCommand({
    TableName: TABLE_CONVERSATIONAL_STATE,
    Key: { PK: marker.eventPK, SK: marker.eventSK },
  }));
  return clean<ConversationEvent>(result.Item as Record<string, unknown> | undefined);
}

export type { AppendEventResult, Key, Page };
export {
  appendConversationAuditEvent,
  appendConversationEvent,
  appendConversationOutbound,
  getCheckpoint,
  getConversationEventByIdempotency,
  getPluginDraft,
  listConversationEvents,
  saveCheckpoint,
  savePluginDraft,
};
