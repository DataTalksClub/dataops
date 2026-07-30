import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { open } from 'fs/promises';
import path from 'path';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getUser } from '../db/users';
import {
  appendConversationEvent,
  appendConversationOutbound,
  consumeConversationalActionAndAppend,
  createChannelBinding,
  createConversation,
  getChannelBinding,
  getConversation,
  getConversationEventByIdempotency,
  getConversationalPrivatePayload,
  getIdentityBinding,
  listConversationEvents,
  putConversationalPrivatePayload,
  replaceChannelBinding,
  replaceConversationalPrivatePayloadConditionally,
  transitionStagedMediaAndAppend,
} from './repository';
import {
  expiryFrom,
  type Conversation,
  type ConversationEvent,
  type ConversationalPrivatePayload,
  type JsonValue,
} from './types';
import {
  DEFAULT_TEMP_ROOT,
  GroqWhisperClient,
  TELEGRAM_FILE_PATH,
  ZaiVisionClient,
  createInvocationDirectory,
  mediaLimitsFromEnv,
  reapOrphanMedia,
  removeInvocationDirectory,
  validateDerivedText,
  validateJpeg,
  validateOgg,
  type MediaLimits,
  type PhotoDescriber,
  type TelegramClient,
  type VoiceTranscriber,
} from './telegramMedia';
import type { LambdaEvent, LambdaResponse } from '../types';
import { createTodoConversationalCoreFromEnv, TODO_GUIDANCE } from './todoCore';

type NormalizedKind = 'message' | 'button_action' | 'session_command' | 'voice_note' | 'photo';
type InputTrust = 'operator_authored' | 'untrusted_provider_derived';

interface CoreInput {
  kind: 'message' | 'button_action' | 'session_command';
  conversationId: string;
  conversationRevision: number;
  actor: { id: string; role: 'admin' | 'operator'; channel: 'telegram' };
  text?: string;
  command?: string;
  action?: JsonValue;
  inputTrust: InputTrust;
  source?: { kind: string; payloadRef?: string };
  provenance: { updateId: string; chatId: string; channelUserId: string };
}

interface CoreInteraction {
  kind: 'assistant_message' | 'clarification' | 'error' | 'status_update';
  message: string;
  buttons?: Array<{ text: string; action: JsonValue }>;
}

interface TelegramCoreRuntime {
  handle(input: CoreInput): Promise<CoreInteraction>;
}

interface AdapterConfig {
  botToken: string;
  webhookSecret: string;
  allowedChatIds: Set<string>;
  voiceEnabled: boolean;
  photoEnabled: boolean;
  tempRoot: string;
  hardDeadlineMs: number;
  telegramApiTimeoutMs: number;
  telegramMaximumResponseBytes: number;
}

interface TelegramAdapterDependencies {
  client: DynamoDBDocumentClient;
  telegram: TelegramClient;
  core: TelegramCoreRuntime;
  voice?: VoiceTranscriber;
  photo?: PhotoDescriber;
  now?: () => Date;
  limits?: MediaLimits;
  beforeOutboundSend?: () => Promise<void>;
  afterOutboundPersist?: () => Promise<void>;
  afterOutboundAccepted?: () => Promise<void>;
}

interface ActionContext {
  ownerUserId: string;
  actorId: string;
  identityBindingId: string;
  channelBindingId: string;
  chatId: string;
  conversationId: string;
  expectedConversationRevision: number;
  updateId: string;
}

const MAX_UPDATE_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 16_384;
const MAX_OUTBOUND_TEXT_BYTES = 96_000;
const MAX_CALLBACK_BYTES = 64;
const PRIVATE_REDIRECT = 'Please continue with the DataOps bot in a private chat.';
const LINK_GUIDANCE = 'This Telegram account is not linked. Ask a DataOps administrator to link it.';
const UNSUPPORTED = 'That input is not supported here. Send private text, a voice note, or a photo.';
const TYPEFULLY_GUIDANCE = 'Send a new typed social request in this private chat. I will ask you to confirm that exact text as public source before preparing a Typefully draft preview.';
const TELEGRAM_MESSAGE_CHUNK_BYTES = 3_900;
const GROUP_REDIRECT_INTERVAL_MS = 60_000;
const groupRedirects = new Map<string, number>();

function response(statusCode: number, body: unknown): LambdaResponse {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonicalNumeric(value: unknown): string {
  const text = value === undefined ? '' : String(value);
  return /^[1-9]\d{0,19}$/.test(text) ? text : '';
}

function canonicalChatId(value: unknown): string {
  const text = value === undefined ? '' : String(value);
  return /^-?[1-9]\d{0,19}$/.test(text) ? text : '';
}

function stableId(value: string): string {
  const digest = createHash('sha256').update(value).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function actionId(token: string): string {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

function boundedText(value: unknown, maximum = MAX_TEXT_BYTES): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text && Buffer.byteLength(text, 'utf8') <= maximum ? text : '';
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new Error('telegram_config_error');
  }
  return candidate;
}

function telegramChunks(text: string): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const character of text) {
    if (Buffer.byteLength(current + character, 'utf8') > TELEGRAM_MESSAGE_CHUNK_BYTES - 200) {
      chunks.push(current);
      current = character;
    } else {
      current += character;
    }
  }
  if (current) chunks.push(current);
  return chunks.length <= 1
    ? chunks
    : chunks.map((chunk, index) => `Preview ${index + 1}/${chunks.length}\n${chunk}`);
}

async function sendTelegramText(telegram: TelegramClient, chatId: string, text: string): Promise<void> {
  for (const chunk of telegramChunks(text)) await telegram.sendMessage(chatId, chunk);
}

async function sendTelegramKeyboard(
  telegram: TelegramClient,
  chatId: string,
  text: string,
  buttons: Array<{ text: string; data: string }>
): Promise<void> {
  const chunks = telegramChunks(text);
  for (const chunk of chunks.slice(0, -1)) await telegram.sendMessage(chatId, chunk);
  await telegram.sendKeyboard(chatId, chunks.at(-1) || 'Ready.', buttons);
}

function commandFrom(text: string): { command?: string; argument: string } {
  const match = text.match(/^\/([a-z0-9_-]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
  return match
    ? { command: match[1].toLowerCase(), argument: (match[2] || '').trim() }
    : { argument: text };
}

function newRecordBase(id: string, recordType: string, now: string, days = 30) {
  return { id, recordType, schemaVersion: 1, createdAt: now, updatedAt: now, ...expiryFrom(now, days) };
}

function remainingSignal(deadlineAt: number, configuredMaximumMs: number): AbortSignal {
  const remaining = Math.floor(deadlineAt - Date.now());
  if (remaining <= 0) throw new Error('telegram_deadline_exceeded');
  return AbortSignal.timeout(Math.max(1, Math.min(remaining, configuredMaximumMs)));
}

async function deadlinePromise<T>(promise: Promise<T>, deadlineAt: number): Promise<T> {
  const remaining = Math.floor(deadlineAt - Date.now());
  if (remaining <= 0) throw new Error('telegram_deadline_exceeded');
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('telegram_deadline_exceeded')), remaining);
      timer.unref?.();
    }),
  ]);
}

async function sendBeforeDeadline(
  dependencies: TelegramAdapterDependencies,
  chatId: string,
  text: string,
  deadlineAt: number
): Promise<void> {
  await deadlinePromise(dependencies.telegram.sendMessage(chatId, text), deadlineAt);
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

class TelegramNotSentError extends Error {
  constructor(message = 'telegram request was not sent') {
    super(message);
    this.name = 'TelegramNotSentError';
  }
}

async function deliverOutbound(
  dependencies: TelegramAdapterDependencies,
  payload: ConversationalPrivatePayload,
  chatId: string,
  deadlineAt: number
): Promise<boolean> {
  let content = object(payload.content);
  if (content?.kind !== 'telegram_outbound' || !Number.isSafeInteger(content.revision)) return false;
  if (content.status === 'delivered' || content.status === 'outcome_unknown') return true;
  if (content.status === 'dispatching') {
    const reconciledAt = (dependencies.now || (() => new Date()))().toISOString();
    await markPayload(
      dependencies.client,
      payload,
      {
        ...content,
        status: 'outcome_unknown',
        reconciliationRequired: true,
        reconciledAt,
      } as Record<string, JsonValue>,
      'dispatching',
      Number(content.revision),
      reconciledAt
    ).catch(() => undefined);
    return true;
  }
  if (content.status !== 'ready') return false;
  const text = boundedText(content.text, MAX_OUTBOUND_TEXT_BYTES);
  const buttons = Array.isArray(content.buttons)
    ? content.buttons.map(object)
      .filter((button): button is Record<string, unknown> => Boolean(button))
      .map((button) => ({
      text: boundedText(button.text, 200),
      data: boundedText(button.data, MAX_CALLBACK_BYTES),
    })).filter((button) => button.text && /^a\.[A-Za-z0-9_-]{32}$/.test(button.data))
    : [];
  if (!text) return false;
  const dispatchStartedAt = (dependencies.now || (() => new Date()))().toISOString();
  try {
    payload = await markPayload(
      dependencies.client,
      payload,
      { ...content, status: 'dispatching', dispatchStartedAt } as Record<string, JsonValue>,
      'ready',
      Number(content.revision),
      dispatchStartedAt
    );
  } catch (error) {
    if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
    return true;
  }
  content = object(payload.content)!;
  // A crash here leaves dispatching. Recovery marks outcome_unknown and never
  // guesses whether Telegram accepted a non-idempotent send.
  await dependencies.beforeOutboundSend?.();
  try {
    await deadlinePromise(
      buttons.length
        ? sendTelegramKeyboard(dependencies.telegram, chatId, text, buttons)
        : sendTelegramText(dependencies.telegram, chatId, text),
      deadlineAt
    );
  } catch (error) {
    const failedAt = (dependencies.now || (() => new Date()))().toISOString();
    if (error instanceof TelegramNotSentError) {
      await markPayload(
        dependencies.client,
        payload,
        { ...content, status: 'ready', lastNotSentAt: failedAt } as Record<string, JsonValue>,
        'dispatching',
        Number(content.revision),
        failedAt
      );
      throw error;
    }
    await markPayload(
      dependencies.client,
      payload,
      {
        ...content,
        status: 'outcome_unknown',
        reconciliationRequired: true,
        ambiguousAt: failedAt,
      } as Record<string, JsonValue>,
      'dispatching',
      Number(content.revision),
      failedAt
    );
    return true;
  }
  // A crash in this hook models acceptance before delivery finalization.
  await dependencies.afterOutboundAccepted?.();
  const deliveredAt = (dependencies.now || (() => new Date()))().toISOString();
  await markPayload(
    dependencies.client,
    payload,
    { ...content, status: 'delivered', deliveredAt } as Record<string, JsonValue>,
    'dispatching',
    Number(content.revision),
    deliveredAt
  ).catch((error) => {
    if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
  });
  return true;
}

async function recoverOutbound(
  dependencies: TelegramAdapterDependencies,
  conversationId: string,
  ownerUserId: string,
  updateId: string,
  chatId: string,
  deadlineAt: number
): Promise<boolean> {
  const event = await getConversationEventByIdempotency(
    dependencies.client, 'telegram', outboundIdempotency(updateId), conversationId
  );
  if (!event?.payloadRef) return false;
  const payload = await getConversationalPrivatePayload(
    dependencies.client, conversationId, event.payloadRef, ownerUserId
  );
  if (payload) await deliverOutbound(dependencies, payload, chatId, deadlineAt);
  // Once the outbound marker exists, never rerun the core even if recovery
  // encounters a corrupt/missing payload. The durable record requires manual
  // reconciliation instead of a second model/runtime execution.
  return true;
}

async function persistInteraction(
  dependencies: TelegramAdapterDependencies,
  input: CoreInput,
  interaction: CoreInteraction,
  actionContext: Omit<ActionContext, 'expectedConversationRevision'>,
  chatId: string,
  deadlineAt: number
): Promise<boolean> {
  const existing = await getConversationEventByIdempotency(
    dependencies.client, 'telegram', outboundIdempotency(input.provenance.updateId), input.conversationId
  );
  if (existing) {
    return recoverOutbound(
      dependencies, input.conversationId, actionContext.ownerUserId,
      input.provenance.updateId, chatId, deadlineAt
    );
  }
  const current = await getConversation(dependencies.client, input.conversationId);
  if (!current || current.revision !== input.conversationRevision) return false;
  const text = boundedText(interaction.message, MAX_OUTBOUND_TEXT_BYTES);
  if (!text) return false;
  const buttons = interaction.buttons?.length
    ? createOpaqueActions({
      ...actionContext,
      expectedConversationRevision: input.conversationRevision + 1,
    }, interaction.buttons, (dependencies.now || (() => new Date()))().toISOString())
    : { records: [], buttons: [] };
  const now = (dependencies.now || (() => new Date()))().toISOString();
  const payload: ConversationalPrivatePayload = {
    ...newRecordBase(
      stableId(`${input.conversationId}:${input.provenance.updateId}:outbound`),
      'conversational_private_payload',
      now
    ),
    recordType: 'conversational_private_payload',
    conversationId: input.conversationId,
    classification: 'private',
    content: {
      kind: 'telegram_outbound',
      status: 'ready',
      revision: 1,
      text,
      buttons: buttons.buttons,
    },
  };
  const event: ConversationEvent = {
    ...newRecordBase(randomUUID(), 'conversation_event', now),
    recordType: 'conversation_event',
    conversationId: input.conversationId,
    sequence: current.nextEventSequence,
    channel: 'telegram',
    idempotencyKey: outboundIdempotency(input.provenance.updateId),
    eventType: 'assistant_output',
    direction: 'outbound',
    actorId: 'conversational-core',
    provenance: `core-result:${input.provenance.updateId}`,
    classification: 'private',
    payloadRef: payload.id,
  };
  try {
    const appended = await appendConversationOutbound(
      dependencies.client,
      event,
      input.conversationRevision,
      actionContext.ownerUserId,
      payload,
      buttons.records,
      (() => {
        const mediaPayloadId = input.source?.payloadRef;
        const mediaActions = buttons.records.filter((record) => {
          const action = object(object(record.content)?.action);
          return (
            typeof mediaPayloadId === 'string'
            && action?.payloadRef === mediaPayloadId
            && (action.type === 'media_use' || action.type === 'media_discard')
          );
        });
        return mediaPayloadId && mediaActions.length === buttons.records.length && mediaActions.length > 0
          ? {
            payloadId: mediaPayloadId,
            expectedPayloadRevision: 2,
            actionIds: mediaActions.map((record) => record.id),
          }
          : undefined;
      })()
    );
    await dependencies.afterOutboundPersist?.();
    return deliverOutbound(dependencies, appended.payload, chatId, deadlineAt);
  } catch (error) {
    if ((error as { name?: string }).name === 'TransactionCanceledException') return false;
    throw error;
  }
}

async function invokeCoreAndRender(
  dependencies: TelegramAdapterDependencies,
  input: CoreInput,
  actionContext: Omit<ActionContext, 'expectedConversationRevision'>,
  chatId: string,
  deadlineAt: number
): Promise<boolean> {
  if (await recoverOutbound(
    dependencies, input.conversationId, actionContext.ownerUserId,
    input.provenance.updateId, chatId, deadlineAt
  )) return true;
  const current = await getConversation(dependencies.client, input.conversationId);
  if (!current || current.revision !== input.conversationRevision) return false;
  const interaction = await deadlinePromise(dependencies.core.handle(input), deadlineAt);
  return persistInteraction(dependencies, input, interaction, actionContext, chatId, deadlineAt);
}

async function stageMedia(
  kind: 'voice_note' | 'photo',
  updateId: string,
  chatId: string,
  conversation: Conversation,
  actorId: string,
  identityBindingId: string,
  channelBindingId: string,
  fileId: string,
  caption: string | undefined,
  metadata: { fileSize?: number; duration?: number; width?: number; height?: number },
  config: AdapterConfig,
  dependencies: TelegramAdapterDependencies,
  deadlineAt: number
): Promise<boolean> {
  const limits = dependencies.limits || mediaLimitsFromEnv();
  if (kind === 'voice_note') {
    if (!config.voiceEnabled || !dependencies.voice) throw new Error('voice_disabled');
    if ((metadata.duration || 0) > limits.voiceMaximumSeconds || (metadata.fileSize || 0) > limits.voiceMaximumBytes) {
      throw new Error('voice_too_large');
    }
  } else {
    if (!config.photoEnabled || !dependencies.photo) throw new Error('photo_disabled');
    if ((metadata.fileSize || 0) > limits.photoMaximumBytes) throw new Error('photo_too_large');
    if (metadata.width && metadata.height && metadata.width * metadata.height > limits.photoMaximumPixels) {
      throw new Error('photo_too_large');
    }
  }
  const now = (dependencies.now || (() => new Date()))();
  const timestamp = now.toISOString();
  let payload = await privatePayload(dependencies.client, conversation.id, actorId, {
    kind, status: 'processing', revision: 1, ...(caption ? { caption } : {}),
  }, timestamp, stableId(`${conversation.id}:${updateId}:${kind}`));
  const appended = await appendInput(
    dependencies.client, conversation, actorId, updateId, kind, timestamp, payload.id,
    { source: 'telegram', media: kind }
  );
  const inputRevision = conversation.revision + 1;
  const actionContext = {
    ownerUserId: actorId,
    actorId,
    identityBindingId,
    channelBindingId,
    chatId,
    conversationId: conversation.id,
    updateId,
  };
  if (appended.duplicate) {
    if (await recoverOutbound(
      dependencies, conversation.id, actorId, updateId, chatId, deadlineAt
    )) return true;
    const existing = await getConversationalPrivatePayload(
      dependencies.client, conversation.id, payload.id, actorId
    );
    const existingContent = object(existing?.content);
    if (existing && existingContent?.status === 'staged') {
      const derived = boundedText(existingContent.text);
      if (!derived) return true;
      await persistInteraction(dependencies, {
        kind: 'message',
        conversationId: conversation.id,
        conversationRevision: inputRevision,
        actor: { id: actorId, role: 'operator', channel: 'telegram' },
        inputTrust: 'untrusted_provider_derived',
        provenance: { updateId, chatId, channelUserId: '' },
      }, {
        kind: 'status_update',
        message: derived,
        buttons: [
          { text: 'Use this text', action: { type: 'media_use', payloadRef: payload.id } },
          { text: 'Discard', action: { type: 'media_discard', payloadRef: payload.id } },
        ],
      }, actionContext, chatId, deadlineAt);
    }
    return true;
  }
  await reapOrphanMedia(config.tempRoot, now);
  const directory = await createInvocationDirectory(config.tempRoot, updateId);
  const filePath = path.join(directory, kind === 'voice_note' ? 'voice.ogg' : 'photo.jpg');
  try {
    remainingSignal(deadlineAt, limits.downloadTimeoutMs);
    const file = await deadlinePromise(dependencies.telegram.getFile(fileId), deadlineAt);
    if (!TELEGRAM_FILE_PATH.test(file.filePath) || file.filePath.startsWith('/') || file.filePath.includes('..')) {
      throw new Error('telegram_invalid_file');
    }
    const maximum = kind === 'voice_note' ? limits.voiceMaximumBytes : limits.photoMaximumBytes;
    if (file.fileSize && file.fileSize > maximum) throw new Error('media_too_large');
    const bytes = await dependencies.telegram.download(
      file.filePath,
      filePath,
      maximum,
      remainingSignal(deadlineAt, limits.downloadTimeoutMs)
    );
    if (bytes <= 0 || bytes > maximum) throw new Error('media_too_large');
    if (kind === 'voice_note') await validateOgg(filePath, limits.voiceMaximumSeconds);
    else await validateJpeg(filePath, limits.photoMaximumPixels);
    const providerSignal = remainingSignal(deadlineAt, limits.providerTimeoutMs);
    const derived = validateDerivedText(
      kind === 'voice_note'
        ? await dependencies.voice!.transcribe(filePath, providerSignal)
        : await dependencies.photo!.describe(filePath, caption, providerSignal),
      limits.maximumDerivedTextBytes
    );
    payload = await markPayload(dependencies.client, payload, {
      kind,
      status: 'staged',
      text: derived,
      ...(caption ? { caption } : {}),
      trust: 'untrusted_provider_derived',
    }, 'processing', 1, timestamp);
    await persistInteraction(dependencies, {
      kind: 'message',
      conversationId: conversation.id,
      conversationRevision: inputRevision,
      actor: { id: actorId, role: 'operator', channel: 'telegram' },
      inputTrust: 'untrusted_provider_derived',
      source: { kind, payloadRef: payload.id },
      provenance: { updateId, chatId, channelUserId: '' },
    }, {
      kind: 'status_update',
      message: derived,
      buttons: [
        { text: 'Use this text', action: { type: 'media_use', payloadRef: payload.id } },
        { text: 'Discard', action: { type: 'media_discard', payloadRef: payload.id } },
      ],
    }, actionContext, chatId, deadlineAt);
    return false;
  } catch (error) {
    if (object(payload.content)?.status === 'staged') {
      throw new Error('media_outbound_pending', { cause: error });
    }
    await markPayload(
      dependencies.client, payload, { kind, status: 'failed' }, 'processing', 1, timestamp
    ).catch(() => undefined);
    throw error;
  } finally {
    await removeInvocationDirectory(config.tempRoot, directory);
  }
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error('telegram_empty_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximumBytes) throw new Error('telegram_response_too_large');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
  try {
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error('telegram_invalid_response');
  }
}

class HttpTelegramClient implements TelegramClient {
  constructor(
    private readonly botToken: string,
    private readonly timeoutMs = 5_000,
    private readonly maximumResponseBytes = 65_536,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  private async api(
    method: string,
    body: Record<string, unknown>,
    safeRetries = 0
  ): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await this.fetcher(`https://api.telegram.org/bot${this.botToken}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!result.ok) throw new Error(`telegram_${result.status}`);
        return await readBoundedJson(result, this.maximumResponseBytes);
      } catch (error) {
        if (attempt >= safeRetries) throw error;
      }
    }
  }

  async getFile(fileId: string) {
    if (!/^[a-zA-Z0-9_-]{1,300}$/.test(fileId)) throw new Error('telegram_invalid_file');
    const body = await this.api('getFile', { file_id: fileId }, 1);
    const result = object(body.result);
    if (!result || typeof result.file_path !== 'string') throw new Error('telegram_invalid_file');
    return {
      filePath: result.file_path,
      fileSize: typeof result.file_size === 'number' ? result.file_size : undefined,
    };
  }

  async download(filePath: string, targetPath: string, maximumBytes: number, signal: AbortSignal): Promise<number> {
    if (!TELEGRAM_FILE_PATH.test(filePath) || filePath.startsWith('/') || filePath.includes('..')) {
      throw new Error('telegram_invalid_file');
    }
    const result = await this.fetcher(`https://api.telegram.org/file/bot${this.botToken}/${filePath}`, { signal });
    const declared = Number(result.headers.get('content-length') || 0);
    if (!result.ok || !result.body || (declared && declared > maximumBytes)) {
      throw new Error(`telegram_download_${result.status}`);
    }
    const handle = await open(targetPath, 'wx', 0o600);
    const reader = result.body.getReader();
    let total = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > maximumBytes) throw new Error('media_too_large');
        await handle.write(chunk.value);
      }
      return total;
    } finally {
      await reader.cancel().catch(() => undefined);
      await handle.close();
    }
  }

  async sendMessage(chatId: string, text: string) {
    for (const chunk of telegramChunks(text)) {
      // sendMessage is not retried: Telegram has no caller idempotency key.
      await this.api('sendMessage', { chat_id: Number(chatId), text: chunk });
    }
  }

  async sendKeyboard(chatId: string, text: string, buttons: Array<{ text: string; data: string }>) {
    const chunks = telegramChunks(text);
    for (const chunk of chunks.slice(0, -1)) {
      await this.api('sendMessage', { chat_id: Number(chatId), text: chunk });
    }
    await this.api('sendMessage', {
      chat_id: Number(chatId),
      text: chunks.at(-1) || 'Ready.',
      reply_markup: {
        inline_keyboard: [buttons.map((button) => ({
          text: button.text,
          callback_data: button.data,
        }))],
      },
    });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string) {
    // Answering an existing callback is idempotent and safe to retry once.
    await this.api('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    }, 1);
  }
}

function adapterDependenciesFromConfig(
  config: AdapterConfig,
  client: DynamoDBDocumentClient,
  overrides: Partial<TelegramAdapterDependencies> = {}
): TelegramAdapterDependencies {
  const voiceArn = process.env.GROQ_TRANSCRIPTION_API_KEY_SECRET_ARN;
  const photoArn = process.env.ZAI_VISION_API_KEY_SECRET_ARN;
  const limits = overrides.limits || mediaLimitsFromEnv();
  if (config.voiceEnabled && !voiceArn && !overrides.voice) throw new Error('voice_config_error');
  if (config.photoEnabled && !photoArn && !overrides.photo) throw new Error('photo_config_error');
  let core = overrides.core;
  if (!core) {
    try {
      core = createTodoConversationalCoreFromEnv(client);
    } catch {
      throw new Error('telegram_core_unavailable');
    }
  }
  return {
    client,
    telegram: overrides.telegram || new HttpTelegramClient(
      config.botToken, config.telegramApiTimeoutMs, config.telegramMaximumResponseBytes
    ),
    core,
    ...(config.voiceEnabled ? {
      voice: overrides.voice || new GroqWhisperClient(
        voiceArn!, undefined, undefined, limits.providerMaximumResponseBytes
      ),
    } : {}),
    ...(config.photoEnabled ? {
      photo: overrides.photo || new ZaiVisionClient(
        photoArn!,
        undefined,
        process.env.ZAI_VISION_MODEL || 'glm-4.6v',
        process.env.ZAI_VISION_BASE_URL,
        limits.providerMaximumResponseBytes
      ),
    } : {}),
    now: overrides.now,
    limits,
    beforeOutboundSend: overrides.beforeOutboundSend,
    afterOutboundPersist: overrides.afterOutboundPersist,
    afterOutboundAccepted: overrides.afterOutboundAccepted,
  };
}

async function handleConversationalTelegramWebhook(
  event: LambdaEvent,
  config: AdapterConfig,
  dependencies: TelegramAdapterDependencies
): Promise<LambdaResponse> {
  const deadlineAt = Date.now() + config.hardDeadlineMs;
  const raw = typeof event.body === 'string' ? event.body : JSON.stringify(event.body || {});
  if (Buffer.byteLength(raw, 'utf8') > MAX_UPDATE_BYTES) {
    return response(413, { error: 'Telegram update is too large' });
  }
  let update: Record<string, unknown>;
  try { update = JSON.parse(raw); } catch { return response(400, { error: 'Invalid Telegram update' }); }
  const updateId = canonicalNumeric(update.update_id);
  if (!updateId) return response(400, { error: 'Invalid Telegram update' });
  const callback = object(update.callback_query);
  const message = object(update.message) || object(callback?.message);
  const chat = object(message?.chat);
  const chatId = canonicalChatId(chat?.id);
  const chatType = typeof chat?.type === 'string' ? chat.type : '';
  if (!chatId || !config.allowedChatIds.has(chatId)) return response(403, { error: 'Chat is not allowed' });
  const callbackId = boundedText(callback?.id, 200);
  if (callbackId) {
    await deadlinePromise(
      dependencies.telegram.answerCallbackQuery(callbackId).catch(() => undefined),
      deadlineAt
    ).catch(() => undefined);
  }
  if (chatType !== 'private') {
    const text = boundedText(message?.text);
    if (text.startsWith('/') || text.includes('@')) {
      const timestamp = (dependencies.now || (() => new Date()))().getTime();
      const previous = groupRedirects.get(chatId) || 0;
      if (timestamp - previous >= GROUP_REDIRECT_INTERVAL_MS) {
        if (groupRedirects.size >= 1_000) groupRedirects.clear();
        groupRedirects.set(chatId, timestamp);
        await deadlinePromise(
          dependencies.telegram.sendMessage(chatId, PRIVATE_REDIRECT).catch(() => undefined),
          deadlineAt
        ).catch(() => undefined);
      }
    }
    return response(200, { ok: true, route: 'private-only' });
  }
  const sender = object(callback?.from) || object(message?.from);
  const channelUserId = canonicalNumeric(sender?.id);
  if (!channelUserId || channelUserId !== chatId) {
    await deadlinePromise(
      dependencies.telegram.sendMessage(chatId, LINK_GUIDANCE).catch(() => undefined),
      deadlineAt
    ).catch(() => undefined);
    return response(200, { ok: true, route: 'link-required' });
  }
  const identity = await getIdentityBinding(dependencies.client, 'telegram', channelUserId);
  const user = identity?.status === 'active' ? await getUser(dependencies.client, identity.userId) : null;
  if (!identity || !user || user.disabled || !['admin', 'operator'].includes(user.role || '')) {
    await deadlinePromise(
      dependencies.telegram.sendMessage(chatId, LINK_GUIDANCE).catch(() => undefined),
      deadlineAt
    ).catch(() => undefined);
    return response(200, { ok: true, route: 'link-required' });
  }
  const now = (dependencies.now || (() => new Date()))();
  const ensured = await ensureConversation(dependencies.client, user.id, chatId, now);
  const conversation = ensured.conversation;
  const actionContext = {
    ownerUserId: user.id,
    actorId: user.id,
    identityBindingId: identity.id,
    channelBindingId: ensured.bindingId,
    chatId,
    conversationId: conversation.id,
    updateId,
  };

  if (callback) {
    const data = boundedText(callback.data, MAX_CALLBACK_BYTES);
    const match = data.match(/^a\.([A-Za-z0-9_-]{32})$/);
    if (!callbackId || !match) return response(200, { ok: true, route: 'invalid-action' });
    const id = actionId(match[1]);
    const actionPayload = await getConversationalPrivatePayload(
      dependencies.client, conversation.id, id, user.id, now
    );
    const actionContent = object(actionPayload?.content);
    const expectedRevision = Number(actionContent?.expectedConversationRevision);
    if (
      !actionPayload
      || !Number.isSafeInteger(expectedRevision)
      || actionContent?.kind !== 'telegram_action'
      || !Array.isArray(actionContent.siblingActionIds)
    ) return response(200, { ok: true, route: 'stale-action' });
    const event = inputEvent(
      { ...conversation, nextEventSequence: conversation.nextEventSequence },
      user.id,
      updateId,
      'button_action',
      now.toISOString(),
      actionPayload.id,
      { source: 'opaque_action' }
    );
    const pendingAction = object(actionContent.action);
    if (
      (pendingAction?.type === 'media_use' || pendingAction?.type === 'media_discard')
      && typeof pendingAction.payloadRef === 'string'
    ) {
      const media = await getConversationalPrivatePayload(
        dependencies.client, conversation.id, pendingAction.payloadRef, user.id, now
      );
      const mediaContent = object(media?.content);
      const currentMediaRevision = Number(mediaContent?.revision);
      const expectedTerminalStatus = pendingAction.type === 'media_use' ? 'used' : 'discarded';
      const expectedMediaRevision = mediaContent?.status === expectedTerminalStatus
        ? currentMediaRevision - 1
        : currentMediaRevision;
      const controlActionIds = Array.isArray(mediaContent?.controlActionIds)
        ? mediaContent.controlActionIds.filter((item): item is string => typeof item === 'string')
        : [];
      if (
        !media
        || !['staged', expectedTerminalStatus].includes(String(mediaContent?.status))
        || !Number.isSafeInteger(expectedMediaRevision)
        || !controlActionIds.includes(id)
      ) return response(200, { ok: true, route: 'stale-action' });
      const terminalEvent = pendingAction.type === 'media_use'
        ? inputEvent(
          { ...conversation, nextEventSequence: conversation.nextEventSequence },
          user.id,
          updateId,
          'message',
          now.toISOString(),
          media.id,
          { source: 'confirmed_untrusted_media' }
        )
        : event;
      const transitioned = await transitionStagedMediaAndAppend(dependencies.client, {
        actionId: id,
        siblingActionIds: controlActionIds.filter((actionIdValue) => actionIdValue !== id),
        conversationId: conversation.id,
        ownerUserId: user.id,
        actorId: user.id,
        identityBindingId: identity.id,
        channelBindingId: ensured.bindingId,
        channelConversationKey: chatId,
        expectedConversationRevision: expectedRevision,
        consumedAt: now.toISOString(),
        mediaPayloadId: media.id,
        expectedMediaRevision,
        terminalStatus: pendingAction.type === 'media_use' ? 'used' : 'discarded',
      }, terminalEvent);
      if (!transitioned) return response(200, { ok: true, route: 'stale-action' });
      if (pendingAction.type === 'media_discard') {
        return response(200, {
          ok: true,
          route: 'media-discarded',
          duplicate: transitioned.duplicate,
        });
      }
      const transitionedContent = object(transitioned.media.content);
      const derivedText = boundedText(transitionedContent?.text);
      if (!derivedText || transitionedContent?.trust !== 'untrusted_provider_derived') {
        return response(200, { ok: true, route: 'stale-action' });
      }
      await invokeCoreAndRender(dependencies, {
        kind: 'message',
        conversationId: conversation.id,
        conversationRevision: expectedRevision + 1,
        actor: { id: user.id, role: user.role as 'admin' | 'operator', channel: 'telegram' },
        text: derivedText,
        inputTrust: 'untrusted_provider_derived',
        source: { kind: String(transitionedContent.kind || 'media'), payloadRef: media.id },
        provenance: { updateId, chatId, channelUserId },
      }, actionContext, chatId, deadlineAt);
      return response(200, {
        ok: true,
        route: 'button-action',
        duplicate: transitioned.duplicate,
      });
    }
    const consumed = await consumeConversationalActionAndAppend(dependencies.client, {
      actionId: id,
      siblingActionIds: actionContent.siblingActionIds.filter((item): item is string => typeof item === 'string'),
      conversationId: conversation.id,
      ownerUserId: user.id,
      actorId: user.id,
      identityBindingId: identity.id,
      channelBindingId: ensured.bindingId,
      channelConversationKey: chatId,
      expectedConversationRevision: expectedRevision,
      consumedAt: now.toISOString(),
    }, event);
    if (!consumed) return response(200, { ok: true, route: 'stale-action' });
    await invokeCoreAndRender(dependencies, {
      kind: 'button_action',
      conversationId: conversation.id,
      conversationRevision: expectedRevision + 1,
      actor: { id: user.id, role: user.role as 'admin' | 'operator', channel: 'telegram' },
      action: (object(consumed.action.content)?.action || null) as JsonValue,
      inputTrust: 'operator_authored',
      provenance: { updateId, chatId, channelUserId },
    }, actionContext, chatId, deadlineAt);
    return response(200, { ok: true, route: 'button-action', duplicate: consumed.duplicate });
  }

  const text = boundedText(message?.text);
  const parsed = commandFrom(text);
  const supportedCommands = new Set(['new', 'sessions', 'continue', 'cancel', 'discard', 'help']);
  if (parsed.command === 'todo') {
    await sendBeforeDeadline(dependencies, chatId, TODO_GUIDANCE, deadlineAt);
    return response(200, { ok: true, route: 'todo-guidance' });
  }
  if (parsed.command === 'social') {
    await sendBeforeDeadline(dependencies, chatId, TYPEFULLY_GUIDANCE, deadlineAt);
    return response(200, { ok: true, route: 'social-guidance' });
  }
  if (parsed.command && !supportedCommands.has(parsed.command)) {
    await sendBeforeDeadline(dependencies, chatId, UNSUPPORTED, deadlineAt);
    return response(200, { ok: true, route: 'unsupported' });
  }

  if (parsed.command) {
    const appended = await appendInput(
      dependencies.client,
      conversation,
      user.id,
      updateId,
      'session_command',
      now.toISOString(),
      undefined,
      { command: parsed.command }
    );
    await invokeCoreAndRender(dependencies, {
      kind: 'session_command',
      command: parsed.command,
      conversationId: conversation.id,
      conversationRevision: conversation.revision + 1,
      actor: { id: user.id, role: user.role as 'admin' | 'operator', channel: 'telegram' },
      inputTrust: 'operator_authored',
      provenance: { updateId, chatId, channelUserId },
    }, actionContext, chatId, deadlineAt);
    return response(200, { ok: true, route: parsed.command, duplicate: appended.duplicate });
  }

  const voice = object(message?.voice);
  if (voice) {
    if (voice.mime_type !== undefined && voice.mime_type !== 'audio/ogg') {
      await sendBeforeDeadline(
        dependencies, chatId,
        'Only Telegram OGG voice notes are supported. Please send text instead.',
        deadlineAt
      );
      return response(200, { ok: true, route: 'media-failed' });
    }
    try {
      const duplicate = await stageMedia(
        'voice_note',
        updateId,
        chatId,
        conversation,
        user.id,
        identity.id,
        ensured.bindingId,
        boundedText(voice.file_id, 300),
        undefined,
        {
          fileSize: typeof voice.file_size === 'number' ? voice.file_size : undefined,
          duration: typeof voice.duration === 'number' ? voice.duration : undefined,
        },
        config,
        dependencies,
        deadlineAt
      );
      return response(200, { ok: true, route: 'voice-preview', duplicate });
    } catch (error) {
      if ((error as Error).message === 'media_outbound_pending') throw error;
      await sendBeforeDeadline(
        dependencies, chatId,
        'I could not safely process that voice note. Please send text or a new OGG voice note.',
        deadlineAt
      ).catch(() => undefined);
      return response(200, { ok: true, route: 'media-failed' });
    }
  }

  const photos = Array.isArray(message?.photo)
    ? message.photo.map(object).filter(Boolean) as Record<string, unknown>[]
    : [];
  if (photos.length) {
    const limits = dependencies.limits || mediaLimitsFromEnv();
    const eligible = photos.filter((photo) => (
      typeof photo.file_size !== 'number' || photo.file_size <= limits.photoMaximumBytes
    ));
    const photo = eligible.at(-1);
    if (!photo) {
      await sendBeforeDeadline(
        dependencies, chatId, 'That photo is too large. Please send text instead.', deadlineAt
      );
      return response(200, { ok: true, route: 'media-failed' });
    }
    try {
      const duplicate = await stageMedia(
        'photo',
        updateId,
        chatId,
        conversation,
        user.id,
        identity.id,
        ensured.bindingId,
        boundedText(photo.file_id, 300),
        boundedText(message?.caption, 4096) || undefined,
        {
          fileSize: typeof photo.file_size === 'number' ? photo.file_size : undefined,
          width: typeof photo.width === 'number' ? photo.width : undefined,
          height: typeof photo.height === 'number' ? photo.height : undefined,
        },
        config,
        dependencies,
        deadlineAt
      );
      return response(200, { ok: true, route: 'photo-preview', duplicate });
    } catch (error) {
      if ((error as Error).message === 'media_outbound_pending') throw error;
      await sendBeforeDeadline(
        dependencies, chatId, 'I could not safely process that photo. Please send text instead.', deadlineAt
      ).catch(() => undefined);
      return response(200, { ok: true, route: 'media-failed' });
    }
  }

  if (!text || message?.document || message?.audio || message?.animation) {
    await sendBeforeDeadline(dependencies, chatId, UNSUPPORTED, deadlineAt);
    return response(200, { ok: true, route: 'unsupported' });
  }
  const active = await activeMediaPayload(dependencies.client, conversation);
  const storedContent: JsonValue = {
    text,
    source: active ? 'operator_correction_of_untrusted_media' : 'telegram_text',
    ...(active ? { correctedPayloadRef: active.id } : {}),
  };
  const timestamp = now.toISOString();
  let stored: ConversationalPrivatePayload;
  let appended: { event: ConversationEvent; duplicate: boolean };
  if (active) {
    const activeContent = object(active.content);
    const controlActionIds = Array.isArray(activeContent?.controlActionIds)
      ? activeContent.controlActionIds.filter((item): item is string => typeof item === 'string')
      : [];
    const expectedMediaRevision = Number(activeContent?.revision);
    if (controlActionIds.length < 1 || !Number.isSafeInteger(expectedMediaRevision)) {
      return response(200, { ok: true, route: 'stale-media' });
    }
    stored = buildPrivatePayload(
      conversation.id,
      storedContent,
      timestamp,
      stableId(`${conversation.id}:${updateId}:message`)
    );
    const event = inputEvent(
      conversation, user.id, updateId, 'message', timestamp, stored.id
    );
    const transitioned = await transitionStagedMediaAndAppend(dependencies.client, {
      actionId: controlActionIds[0],
      siblingActionIds: controlActionIds.slice(1),
      conversationId: conversation.id,
      ownerUserId: user.id,
      actorId: user.id,
      identityBindingId: identity.id,
      channelBindingId: ensured.bindingId,
      channelConversationKey: chatId,
      expectedConversationRevision: conversation.revision,
      consumedAt: timestamp,
      mediaPayloadId: active.id,
      expectedMediaRevision,
      terminalStatus: 'corrected',
      correctionPayload: stored,
    }, event);
    if (!transitioned) return response(200, { ok: true, route: 'stale-media' });
    appended = { event: transitioned.event, duplicate: transitioned.duplicate };
  } else {
    stored = await privatePayload(
      dependencies.client,
      conversation.id,
      user.id,
      storedContent,
      timestamp,
      stableId(`${conversation.id}:${updateId}:message`)
    );
    appended = await appendInput(
      dependencies.client, conversation, user.id, updateId, 'message', timestamp, stored.id
    );
  }
  await invokeCoreAndRender(dependencies, {
    kind: 'message',
    conversationId: conversation.id,
    conversationRevision: conversation.revision + 1,
    actor: { id: user.id, role: user.role as 'admin' | 'operator', channel: 'telegram' },
    text,
    inputTrust: 'operator_authored',
    source: active
      ? { kind: 'media_correction', payloadRef: active.id }
      : { kind: 'telegram_text', payloadRef: stored.id },
    provenance: { updateId, chatId, channelUserId },
  }, actionContext, chatId, deadlineAt);
  return response(200, {
    ok: true,
    route: active ? 'media-correction' : 'message',
    duplicate: appended.duplicate,
  });
}

function conversationalTelegramConfig(
  botToken: string | undefined,
  webhookSecret: string | undefined,
  allowedChatIds: Set<string>
): AdapterConfig {
  if (!botToken || !webhookSecret || allowedChatIds.size === 0) throw new Error('telegram_config_error');
  return {
    botToken,
    webhookSecret,
    allowedChatIds,
    voiceEnabled: process.env.CONVERSATIONAL_TELEGRAM_VOICE_ENABLED === 'true',
    photoEnabled: process.env.CONVERSATIONAL_TELEGRAM_PHOTO_ENABLED === 'true',
    tempRoot: process.env.DATAOPS_TELEGRAM_MEDIA_TEMP_ROOT || DEFAULT_TEMP_ROOT,
    hardDeadlineMs: boundedInteger(process.env.TELEGRAM_HANDLER_DEADLINE_MS, 28_000, 1_000, 28_000),
    telegramApiTimeoutMs: boundedInteger(process.env.TELEGRAM_API_TIMEOUT_MS, 5_000, 100, 10_000),
    telegramMaximumResponseBytes: boundedInteger(
      process.env.TELEGRAM_API_MAX_RESPONSE_BYTES, 65_536, 1_024, 256 * 1024
    ),
  };
}

export {
  HttpTelegramClient,
  LINK_GUIDANCE,
  PRIVATE_REDIRECT,
  TelegramNotSentError,
  adapterDependenciesFromConfig,
  conversationalTelegramConfig,
  handleConversationalTelegramWebhook,
  safeEqual,
};

export type {
  AdapterConfig,
  CoreInput,
  CoreInteraction,
  TelegramAdapterDependencies,
  TelegramCoreRuntime,
};
