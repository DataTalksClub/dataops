import { randomBytes, randomUUID } from 'crypto';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  createChannelBinding,
  createConversation,
  getChannelBinding,
  getConversation,
  replaceChannelBinding,
} from './conversations';
import {
  appendConversationEvent,
  listConversationEvents,
} from './conversationEvents';
import {
  getConversationalPrivatePayload,
  putConversationalPrivatePayload,
  replaceConversationalPrivatePayloadConditionally,
} from './privatePayloads';
import {
  expiryFrom,
  type Conversation,
  type ConversationEvent,
  type ConversationalPrivatePayload,
  type JsonValue,
} from './types';
import {
  actionId,
  boundedText,
  object,
  stableId,
  type ActionContext,
  type NormalizedKind,
} from './telegramProtocol';

function newRecordBase(id: string, recordType: string, now: string, days = 30) {
  return { id, recordType, schemaVersion: 1, createdAt: now, updatedAt: now, ...expiryFrom(now, days) };
}

async function ensureConversation(
  client: DynamoDBDocumentClient,
  userId: string,
  chatId: string,
  now: Date
): Promise<{ conversation: Conversation; bindingId: string }> {
  const existingBinding = await getChannelBinding(client, 'telegram', chatId, now);
  if (existingBinding?.ownerUserId === userId) {
    const conversation = await getConversation(client, existingBinding.conversationId, now);
    if (conversation?.status === 'active') return { conversation, bindingId: existingBinding.id };
  }
  const nowIso = now.toISOString();
  const conversation: Conversation = {
    ...newRecordBase(randomUUID(), 'conversation', nowIso),
    recordType: 'conversation',
    ownerUserId: userId,
    audience: 'private',
    status: 'active',
    nextEventSequence: 1,
    revision: 1,
  };
  await createConversation(client, conversation);
  const channelBinding = {
    ...newRecordBase(randomUUID(), 'channel_binding', nowIso),
    recordType: 'channel_binding' as const,
    conversationId: conversation.id,
    ownerUserId: userId,
    channel: 'telegram',
    channelConversationKey: chatId,
  };
  try {
    if (existingBinding) {
      await replaceChannelBinding(client, channelBinding, existingBinding.conversationId);
    } else {
      await createChannelBinding(client, channelBinding);
    }
    return { conversation, bindingId: channelBinding.id };
  } catch (error) {
    const winner = await getChannelBinding(client, 'telegram', chatId, now);
    const winnerConversation = winner && winner.ownerUserId === userId
      ? await getConversation(client, winner.conversationId, now)
      : null;
    if (winner && winnerConversation?.status === 'active') {
      return { conversation: winnerConversation, bindingId: winner.id };
    }
    throw error;
  }
}

async function privatePayload(
  client: DynamoDBDocumentClient,
  conversationId: string,
  ownerUserId: string,
  content: JsonValue,
  now: string,
  id: string = randomUUID()
): Promise<ConversationalPrivatePayload> {
  const payload = buildPrivatePayload(conversationId, content, now, id);
  try {
    await putConversationalPrivatePayload(client, payload);
  } catch (error) {
    if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
    const existing = await getConversationalPrivatePayload(client, conversationId, id, ownerUserId);
    if (existing) return existing;
    throw error;
  }
  return payload;
}

function buildPrivatePayload(
  conversationId: string,
  content: JsonValue,
  now: string,
  id: string = randomUUID()
): ConversationalPrivatePayload {
  return {
    ...newRecordBase(id, 'conversational_private_payload', now),
    recordType: 'conversational_private_payload',
    conversationId,
    classification: 'private',
    content,
  };
}

function inputEvent(
  conversation: Conversation,
  actorId: string,
  updateId: string,
  kind: NormalizedKind,
  now: string,
  payloadRef?: string,
  payload?: JsonValue
): ConversationEvent {
  return {
    ...newRecordBase(randomUUID(), 'conversation_event', now),
    recordType: 'conversation_event',
    conversationId: conversation.id,
    sequence: conversation.nextEventSequence,
    channel: 'telegram',
    idempotencyKey: `telegram:${updateId}:${kind}`,
    eventType: kind,
    direction: 'inbound',
    actorId,
    provenance: `telegram-update:${updateId}`,
    classification: 'private',
    ...(payloadRef ? { payloadRef } : {}),
    ...(payload !== undefined ? { payload } : {}),
  };
}

async function appendInput(
  client: DynamoDBDocumentClient,
  conversation: Conversation,
  actorId: string,
  updateId: string,
  kind: NormalizedKind,
  now: string,
  payloadRef?: string,
  payload?: JsonValue
) {
  return appendConversationEvent(
    client,
    inputEvent(conversation, actorId, updateId, kind, now, payloadRef, payload),
    conversation.revision
  );
}

async function activeMediaPayload(
  client: DynamoDBDocumentClient,
  conversation: Conversation
): Promise<ConversationalPrivatePayload | null> {
  const events = await listConversationEvents(client, conversation.id, conversation.ownerUserId, undefined, 50);
  for (const event of events.items.filter((item) => (
    item.eventType === 'voice_note' || item.eventType === 'photo'
  )).reverse()) {
    if (!event.payloadRef) continue;
    const payload = await getConversationalPrivatePayload(
      client, conversation.id, event.payloadRef, conversation.ownerUserId
    );
    if (payload && object(payload.content)?.status === 'staged') return payload;
  }
  return null;
}

async function markPayload(
  client: DynamoDBDocumentClient,
  payload: ConversationalPrivatePayload,
  nextContent: Record<string, JsonValue>,
  expectedStatus: string,
  expectedRevision: number,
  now: string
): Promise<ConversationalPrivatePayload> {
  const updated = {
    ...payload,
    updatedAt: now,
    ...expiryFrom(now, 30),
    content: { ...nextContent, revision: expectedRevision + 1 },
  };
  await replaceConversationalPrivatePayloadConditionally(
    client, updated, expectedStatus, expectedRevision
  );
  return updated;
}

function createOpaqueActions(
  context: ActionContext,
  specs: Array<{ text: string; action: JsonValue }>,
  now: string
): {
  records: ConversationalPrivatePayload[];
  buttons: Array<{ text: string; data: string }>;
} {
  const created = specs.slice(0, 8).map((spec) => {
    const token = randomBytes(24).toString('base64url');
    return { ...spec, token, id: actionId(token) };
  });
  const records = created.map((candidate): ConversationalPrivatePayload => ({
    ...newRecordBase(candidate.id, 'conversational_private_payload', now),
    recordType: 'conversational_private_payload',
    conversationId: context.conversationId,
    classification: 'private',
    content: {
      kind: 'telegram_action',
      status: 'active',
      revision: 1,
      actorId: context.actorId,
      identityBindingId: context.identityBindingId,
      channelBindingId: context.channelBindingId,
      channelConversationKey: context.chatId,
      expectedConversationRevision: context.expectedConversationRevision,
      sourceUpdateId: context.updateId,
      action: candidate.action,
      siblingActionIds: created.filter((item) => item.id !== candidate.id).map((item) => item.id),
    },
  }));
  return {
    records,
    buttons: created.map((candidate) => ({
      text: boundedText(candidate.text, 200),
      data: `a.${candidate.token}`,
    })),
  };
}

function outboundIdempotency(updateId: string): string {
  return `telegram:${updateId}:outbound`;
}

export {
  activeMediaPayload,
  appendInput,
  buildPrivatePayload,
  createOpaqueActions,
  ensureConversation,
  inputEvent,
  markPayload,
  newRecordBase,
  outboundIdempotency,
  privatePayload,
};
