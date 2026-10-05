import { open } from 'fs/promises';
import path from 'path';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getUser } from '../db/users';
import type { LambdaEvent, LambdaResponse } from '../types';
import type {
  Conversation,
  ConversationEvent,
  ConversationalPrivatePayload,
  JsonValue,
} from './types';
import { getIdentityBinding } from './identityBindings';
import type { ConversationalRolloutSnapshot } from './rollout';
import {
  emitConversationalMetric,
  logConversationalEvent,
} from './observability';
import { consumeConversationalActionAndAppend, transitionStagedMediaAndAppend } from './conversationActions';
import { getConversationalPrivatePayload } from './privatePayloads';
import { createTodoConversationalCoreFromEnv, TODO_GUIDANCE } from './todoCore';
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
} from './telegramMedia';
import {
  MAX_CALLBACK_BYTES,
  MAX_UPDATE_BYTES,
  HttpTelegramClient,
  actionId,
  boundedInteger,
  boundedText,
  canonicalChatId,
  canonicalNumeric,
  commandFrom,
  deadlinePromise,
  object,
  remainingSignal,
  response,
  sendBeforeDeadline,
  stableId,
  type AdapterConfig,
  type TelegramAdapterDependencies,
} from './telegramProtocol';
import {
  activeMediaPayload,
  appendInput,
  buildPrivatePayload,
  ensureConversation,
  inputEvent,
  markPayload,
  privatePayload,
} from './telegramRecords';
import { invokeCoreAndRender, persistInteraction, recoverOutbound } from './telegramOutbound';

const PRIVATE_REDIRECT = 'Please continue with the DataOps bot in a private chat.';
const LINK_GUIDANCE = 'This Telegram account is not linked. Ask a DataOps administrator to link it.';
const UNSUPPORTED = 'That input is not supported here. Send private text, a voice note, or a photo.';
const TYPEFULLY_GUIDANCE = 'Send a new typed social request in this private chat. I will ask you to confirm that exact text as public source before preparing a Typefully draft preview.';
const PODCAST_GUIDANCE = 'Podcast creation is outside this conversational MVP. No job or document was created.';
const HELP_GUIDANCE = [
  'DataOps conversational Telegram works in verified private chats.',
  'Describe one todo or a typed public social draft request, review the complete proposal, then use its exact controls.',
  'Voice notes and photos are shown back for Use, correction, or Discard before conversation.',
  'Approvals require buttons; typed shortcuts never approve or execute.',
  'Session commands: /new, /sessions, /continue, /cancel, /discard.',
].join('\n');

const GROUP_REDIRECT_INTERVAL_MS = 60_000;
const groupRedirects = new Map<string, number>();

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
  try {
    await reapOrphanMedia(config.tempRoot, now);
  } catch {
    emitConversationalMetric('RetentionCleanupFailed', 1, 'retention-cleanup');
    logConversationalEvent('cleanup_failed', 'retention-cleanup');
  }
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
    try {
      await removeInvocationDirectory(config.tempRoot, directory);
    } catch {
      emitConversationalMetric('MediaCleanupFailed', 1, 'media-cleanup');
      logConversationalEvent('cleanup_failed', 'media-cleanup');
    }
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
  const staticCommand = commandFrom(boundedText(message?.text)).command;
  const staticGuidance = staticCommand === 'todo'
    ? TODO_GUIDANCE
    : staticCommand === 'social'
      ? TYPEFULLY_GUIDANCE
      : staticCommand === 'podcast'
        ? PODCAST_GUIDANCE
        : staticCommand === 'start' || staticCommand === 'help'
          ? HELP_GUIDANCE
          : staticCommand === 'status'
            ? 'DataOps conversational Telegram is online.'
            : null;
  if (staticGuidance) {
    await sendBeforeDeadline(dependencies, chatId, staticGuidance, deadlineAt);
    return response(200, { ok: true, route: `${staticCommand}-guidance` });
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
  const supportedCommands = new Set(['new', 'sessions', 'continue', 'cancel', 'discard']);
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
      emitConversationalMetric('VoiceFailures', 1, 'voice');
      logConversationalEvent('media_failed', 'voice');
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
      emitConversationalMetric('PhotoFailures', 1, 'photo');
      logConversationalEvent('media_failed', 'photo');
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
  allowedChatIds: Set<string>,
  rollout: ConversationalRolloutSnapshot
): AdapterConfig {
  if (!botToken || !webhookSecret || allowedChatIds.size === 0) throw new Error('telegram_config_error');
  return {
    botToken,
    webhookSecret,
    allowedChatIds,
    voiceEnabled: rollout.eligibility.voiceAvailable,
    photoEnabled: rollout.eligibility.photoAvailable,
    tempRoot: process.env.DATAOPS_TELEGRAM_MEDIA_TEMP_ROOT || DEFAULT_TEMP_ROOT,
    hardDeadlineMs: boundedInteger(process.env.TELEGRAM_HANDLER_DEADLINE_MS, 28_000, 1_000, 28_000),
    telegramApiTimeoutMs: boundedInteger(process.env.TELEGRAM_API_TIMEOUT_MS, 5_000, 100, 5_000),
    telegramMaximumResponseBytes: boundedInteger(
      process.env.TELEGRAM_API_MAX_RESPONSE_BYTES, 65_536, 1_024, 256 * 1024
    ),
  };
}

export {
  HELP_GUIDANCE,
  LINK_GUIDANCE,
  PODCAST_GUIDANCE,
  PRIVATE_REDIRECT,
  TYPEFULLY_GUIDANCE,
  UNSUPPORTED,
  adapterDependenciesFromConfig,
  conversationalTelegramConfig,
  handleConversationalTelegramWebhook,
};
