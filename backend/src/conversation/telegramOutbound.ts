import { randomUUID } from 'crypto';

import {
  appendConversationOutbound,
  getConversationEventByIdempotency,
} from './conversationEvents';
import { getConversation } from './conversations';
import { getConversationalPrivatePayload } from './privatePayloads';
import {
  type ConversationEvent,
  type ConversationalPrivatePayload,
  type JsonValue,
} from './types';
import {
  MAX_CALLBACK_BYTES,
  MAX_OUTBOUND_TEXT_BYTES,
  boundedText,
  deadlinePromise,
  object,
  sendTelegramKeyboard,
  sendTelegramText,
  stableId,
  type ActionContext,
  type CoreInput,
  type CoreInteraction,
  type TelegramAdapterDependencies,
} from './telegramProtocol';
import {
  createOpaqueActions,
  markPayload,
  newRecordBase,
  outboundIdempotency,
} from './telegramRecords';

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

export {
  TelegramNotSentError,
  deliverOutbound,
  invokeCoreAndRender,
  persistInteraction,
  recoverOutbound,
};
