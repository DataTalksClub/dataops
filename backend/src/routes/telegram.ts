import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

import { runSocialDraftAssistant } from '../assistant/socialDraftAssistant';
import { createAssistantJob } from '../db/assistantJobs';
import { getClient } from '../db/client';
import { createTables } from '../db/setup';
import { updateIntakeItem } from '../db/intake';
import { createTelegramIntake } from './intake';
import type { IntakeItem, LambdaEvent, LambdaResponse } from '../types';
import { TODO_GUIDANCE } from '../conversation/todoPlugin';
import {
  adapterDependenciesFromConfig,
  conversationalTelegramConfig,
  handleConversationalTelegramWebhook,
  safeEqual,
  type TelegramAdapterDependencies,
} from '../conversation/telegramAdapter';

interface TelegramConfig {
  botToken?: string;
  webhookSecret?: string;
  allowedChatIds: Set<string>;
}

interface LegacyTelegramDependencyOverrides {
  getClient?: typeof getClient;
  sendReply?: typeof sendTelegramReply;
}

type TelegramRouteDependencyOverrides = Partial<TelegramAdapterDependencies> & {
  legacy?: LegacyTelegramDependencyOverrides;
};

let secretsClient: SecretsManagerClient | null = null;
let cachedConfig: TelegramConfig | null = null;

// Parse message: extract description and optional date (YYYY-MM-DD at end)
function parseMessage(text: string): { description: string; date: string } {
  const dateRegex = /\s(\d{4}-\d{2}-\d{2})$/;
  const match = text.match(dateRegex);
  if (match) {
    return {
      description: text.slice(0, match.index).trim(),
      date: match[1]
    };
  }
  const today = new Date().toISOString().slice(0, 10);
  return { description: text.trim(), date: today };
}

function parseAllowedChatIds(value: unknown): Set<string> {
  if (Array.isArray(value)) {
    return new Set(value.map(String).map((item) => item.trim()).filter(Boolean));
  }
  if (typeof value !== 'string') return new Set();
  const trimmed = value.trim();
  if (!trimmed) return new Set();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parseAllowedChatIds(parsed);
    } catch {
      // Fall through to comma-separated parsing.
    }
  }
  return new Set(trimmed.split(',').map((item) => item.trim()).filter(Boolean));
}

function configFromRecord(record: Record<string, unknown>): TelegramConfig {
  const botToken = String(record.botToken || record.bot_token || record.TELEGRAM_BOT_TOKEN || '').trim() || undefined;
  const webhookSecret = String(record.webhookSecret || record.webhook_secret || record.TELEGRAM_WEBHOOK_SECRET || '').trim() || undefined;
  const allowedChatIds = parseAllowedChatIds(
    record.allowedChatIds || record.allowed_chat_ids || record.TELEGRAM_ALLOWED_CHAT_IDS
  );
  return { botToken, webhookSecret, allowedChatIds };
}

async function telegramConfig(forceRefresh = false): Promise<TelegramConfig> {
  const secretName = process.env.TELEGRAM_INTEGRATION_SECRET_NAME;
  if (!secretName) {
    return {
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
      allowedChatIds: parseAllowedChatIds(process.env.TELEGRAM_ALLOWED_CHAT_IDS),
    };
  }
  if (cachedConfig && !forceRefresh) return cachedConfig;
  secretsClient ||= new SecretsManagerClient({});
  const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
  if (!result.SecretString) throw new Error('Telegram integration secret has no SecretString');
  const parsed = JSON.parse(result.SecretString);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Telegram integration secret must contain a JSON object');
  }
  cachedConfig = configFromRecord(parsed as Record<string, unknown>);
  return cachedConfig;
}

function headerValue(headers: Record<string, string> | null | undefined, name: string): string {
  if (!headers) return '';
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match ? String(match[1]) : '';
}

async function sendTelegramReply(chatId: string, text: string, botToken?: string): Promise<void> {
  if (!botToken) return;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: /^-?\d+$/.test(chatId) ? Number(chatId) : chatId, text })
    });
    if (!response.ok) console.error('Failed to send Telegram reply:', response.status);
  } catch (err: unknown) {
    console.error('Failed to send Telegram reply:', err instanceof Error ? err.name : 'unknown error');
  }
}

function commandFrom(text: string): { command?: string; argument: string } {
  const match = text.trim().match(/^\/([a-z0-9_-]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
  if (!match) return { argument: text.trim() };
  return { command: match[1].toLowerCase(), argument: (match[2] || '').trim() };
}

function telegramMessage(update: Record<string, unknown>): Record<string, unknown> | null {
  return update.message && typeof update.message === 'object' && !Array.isArray(update.message)
    ? update.message as Record<string, unknown>
    : null;
}

function messageText(message: Record<string, unknown>): string {
  if (typeof message.text === 'string') return message.text;
  if (typeof message.caption === 'string') return message.caption;
  return '';
}

function chatIdFrom(message: Record<string, unknown>): string {
  const chat = message.chat && typeof message.chat === 'object' && !Array.isArray(message.chat)
    ? message.chat as Record<string, unknown>
    : {};
  return chat.id === undefined ? '' : String(chat.id);
}

function actorIdFrom(message: Record<string, unknown>): string | undefined {
  const from = message.from && typeof message.from === 'object' && !Array.isArray(message.from)
    ? message.from as Record<string, unknown>
    : {};
  return from.id === undefined ? undefined : `telegram:${String(from.id)}`;
}

async function markAssistantRoute(
  item: IntakeItem,
  assistantType: string,
  assistantJobId: string
): Promise<void> {
  const client = await getClient();
  await updateIntakeItem(client, item.id, {
    assistantJobIds: Array.from(new Set([...(item.assistantJobIds || []), assistantJobId])),
    assistantReadiness: {
      assistantType,
      status: 'submitted',
      missingFields: [],
      inputRefs: [{
        type: 'source-message',
        id: item.id,
        title: item.title,
        metadata: { source: 'telegram', sourceMessageId: item.sourceMessageId },
      }],
    },
    metadata: { ...(item.metadata || {}), telegramRoute: assistantType },
  });
}

async function handlePodcastRoute(item: IntakeItem, actorId?: string): Promise<string> {
  if ((item.assistantJobIds || []).length > 0) {
    return `Podcast request already captured: ${item.title}`;
  }
  const client = await getClient();
  const job = await createAssistantJob(client, {
    assistantType: 'podcast',
    title: item.title.replace(/^\/podcast(?:@[a-z0-9_]+)?\s*/i, '') || 'Podcast preparation request',
    requestedBy: actorId,
    inputRefs: [{
      type: 'source-message',
      id: item.id,
      title: item.title,
      metadata: { source: 'telegram', sourceMessageId: item.sourceMessageId },
    }],
    approvalRequired: true,
    approval: { status: 'pending' },
    maxAttempts: 2,
  });
  await markAssistantRoute(item, 'podcast', job.id);
  return `Podcast request captured for review: "${job.title}"`;
}

async function handleSocialRoute(
  update: Record<string, unknown>,
  item: IntakeItem,
  argument: string,
  actorId?: string
): Promise<string> {
  if ((item.assistantJobIds || []).length > 0) {
    return `Social draft request already captured: ${item.title}`;
  }
  if (!argument) return 'Use /social followed by the account and requested post, for example: /social Alexey post about the next workshop';
  const client = await getClient();
  const result = await runSocialDraftAssistant(client, { telegramUpdate: update, text: argument }, actorId);
  if (result.job) await markAssistantRoute(item, 'social-draft', result.job.id);
  if (result.reviewStatus === 'needs-account-clarification') {
    return 'Please name the target account: Alexey / Al_Grigor or DataTalksClub.';
  }
  if (result.reviewStatus === 'created') return 'Social draft created in Typefully and is waiting for review.';
  return 'The social draft request failed safely. Check the DataOps assistant job for details.';
}

async function handleLegacyTelegramWebhook(
  event: LambdaEvent,
  dependencyOverrides: LegacyTelegramDependencyOverrides = {}
): Promise<LambdaResponse> {
  let config: TelegramConfig;
  try {
    config = await telegramConfig();
  } catch {
    return { statusCode: 503, body: JSON.stringify({ error: 'Telegram integration is not configured' }) };
  }
  const suppliedSecret = headerValue(event.headers, 'x-telegram-bot-api-secret-token');
  if (!config.webhookSecret) {
    return { statusCode: 503, body: JSON.stringify({ error: 'Telegram integration is not configured' }) };
  }
  if (suppliedSecret !== config.webhookSecret && process.env.TELEGRAM_INTEGRATION_SECRET_NAME) {
    try {
      config = await telegramConfig(true);
    } catch {
      return { statusCode: 503, body: JSON.stringify({ error: 'Telegram integration is not configured' }) };
    }
  }
  if (suppliedSecret !== config.webhookSecret) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  if (config.allowedChatIds.size === 0) {
    return { statusCode: 503, body: JSON.stringify({ error: 'Telegram chat allowlist is not configured' }) };
  }

  let update: Record<string, unknown>;
  try {
    update = JSON.parse(typeof event.body === 'string' ? event.body : JSON.stringify(event.body || {}));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid Telegram update' }) };
  }
  const message = telegramMessage(update);
  if (!message) return { statusCode: 200, body: JSON.stringify({ ok: true }) };

  const chatId = chatIdFrom(message);
  if (!chatId || !config.allowedChatIds.has(chatId)) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Chat is not allowed' }) };
  }

  const text = messageText(message);
  const { command, argument } = commandFrom(text);
  const sendReply = dependencyOverrides.sendReply || sendTelegramReply;
  if (command === 'todo') {
    await sendReply(chatId, TODO_GUIDANCE, config.botToken);
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, route: 'todo-guidance' }),
    };
  }
  if (command === 'start' || command === 'help') {
    await sendReply(
      chatId,
      [
        'DataOps Telegram',
        '',
        'Send a message or attachment to capture operations intake.',
        '/podcast <notes> — create a podcast assistant request',
        '/social <account and request> — create a social draft for review',
        '/status — check that the shared integration is online',
      ].join('\n'),
      config.botToken
    );
    return { statusCode: 200, body: JSON.stringify({ ok: true, route: 'help' }) };
  }
  if (command === 'status') {
    await sendReply(chatId, 'DataOps Telegram is online. Intake and assistant requests are routed through this bot.', config.botToken);
    return { statusCode: 200, body: JSON.stringify({ ok: true, route: 'status' }) };
  }

  const client = await (dependencyOverrides.getClient || getClient)();
  await createTables(client);
  const item = await createTelegramIntake(client, update);
  if (!item) return { statusCode: 200, body: JSON.stringify({ ok: true }) };

  let reply: string;
  let route = 'intake';
  if (command === 'podcast') {
    route = 'podcast';
    reply = await handlePodcastRoute(item, actorIdFrom(message));
  } else if (command === 'social') {
    route = 'social-draft';
    reply = await handleSocialRoute(update, item, argument, actorIdFrom(message));
  } else {
    reply = `Intake captured: "${item.title}"`;
  }
  await sendReply(chatId, reply, config.botToken);
  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, route, intakeItemId: item.id }),
  };
}

async function handleTelegramWebhook(
  event: LambdaEvent,
  dependencyOverrides: TelegramRouteDependencyOverrides = {}
): Promise<LambdaResponse> {
  if (process.env.CONVERSATIONAL_TELEGRAM_ENABLED !== 'true') {
    return handleLegacyTelegramWebhook(event, dependencyOverrides.legacy);
  }
  let config: TelegramConfig;
  try {
    config = await telegramConfig();
  } catch {
    return { statusCode: 503, body: JSON.stringify({ error: 'Telegram integration is not configured' }) };
  }
  const suppliedSecret = headerValue(event.headers, 'x-telegram-bot-api-secret-token');
  if (!config.webhookSecret) {
    return { statusCode: 503, body: JSON.stringify({ error: 'Telegram integration is not configured' }) };
  }
  if (!safeEqual(suppliedSecret, config.webhookSecret) && process.env.TELEGRAM_INTEGRATION_SECRET_NAME) {
    try {
      config = await telegramConfig(true);
    } catch {
      return { statusCode: 503, body: JSON.stringify({ error: 'Telegram integration is not configured' }) };
    }
  }
  if (!config.webhookSecret || !safeEqual(suppliedSecret, config.webhookSecret)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  try {
    const adapterConfig = conversationalTelegramConfig(
      config.botToken,
      config.webhookSecret,
      config.allowedChatIds
    );
    const client = dependencyOverrides.client || await getClient();
    const dependencies = adapterDependenciesFromConfig(adapterConfig, client, dependencyOverrides);
    return await handleConversationalTelegramWebhook(event, adapterConfig, dependencies);
  } catch {
    return { statusCode: 503, body: JSON.stringify({ error: 'Conversational Telegram is unavailable' }) };
  }
}

function resetTelegramConfigCache(): void {
  cachedConfig = null;
  secretsClient = null;
}

export { handleLegacyTelegramWebhook, handleTelegramWebhook, parseMessage, resetTelegramConfigCache };
