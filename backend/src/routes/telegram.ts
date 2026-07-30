import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

import { getClient } from '../db/client';
import type { LambdaEvent, LambdaResponse } from '../types';
import {
  adapterDependenciesFromConfig,
  conversationalTelegramConfig,
  handleConversationalTelegramWebhook,
  MAX_UPDATE_BYTES,
  safeEqual,
  type TelegramAdapterDependencies,
} from '../conversation/telegramAdapter';
import { conversationalRolloutSnapshot } from '../conversation/rollout';
import {
  emitConversationalMetric,
  logConversationalEvent,
} from '../conversation/observability';

interface TelegramConfig {
  botToken?: string;
  webhookSecret?: string;
  allowedChatIds: Set<string>;
}

type TelegramRouteDependencyOverrides = Partial<TelegramAdapterDependencies> & {
  sendMaintenanceReply?: typeof sendTelegramReply;
};

const MAX_MAINTENANCE_REPLY_DEADLINE_MS = 5_000;

let secretsClient: SecretsManagerClient | null = null;
let cachedConfig: TelegramConfig | null = null;

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
    const configuredDeadline = Number(process.env.TELEGRAM_API_TIMEOUT_MS || 5_000);
    const deadlineMs = Number.isSafeInteger(configuredDeadline)
      ? Math.max(100, Math.min(configuredDeadline, MAX_MAINTENANCE_REPLY_DEADLINE_MS))
      : MAX_MAINTENANCE_REPLY_DEADLINE_MS;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: /^-?\d+$/.test(chatId) ? Number(chatId) : chatId, text }),
      signal: AbortSignal.timeout(deadlineMs),
    });
    if (!response.ok) throw new Error('maintenance_reply_rejected');
  } catch {
    logConversationalEvent('maintenance_reply_failed', 'telegram');
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

function senderIdFrom(message: Record<string, unknown>): string {
  const from = message.from && typeof message.from === 'object' && !Array.isArray(message.from)
    ? message.from as Record<string, unknown>
    : {};
  return from.id === undefined ? '' : String(from.id);
}

async function handleMaintenanceTelegramWebhook(
  event: LambdaEvent,
  config: TelegramConfig,
  sendReply: typeof sendTelegramReply
): Promise<LambdaResponse> {
  const raw = typeof event.body === 'string' ? event.body : JSON.stringify(event.body || {});
  if (Buffer.byteLength(raw, 'utf8') > MAX_UPDATE_BYTES) {
    return { statusCode: 413, body: JSON.stringify({ error: 'Telegram update is too large' }) };
  }
  let update: Record<string, unknown>;
  try {
    update = JSON.parse(raw);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid Telegram update' }) };
  }
  const message = telegramMessage(update);
  if (!message) return { statusCode: 200, body: JSON.stringify({ ok: true }) };

  const chatId = chatIdFrom(message);
  if (!chatId || !config.allowedChatIds.has(chatId)) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Chat is not allowed' }) };
  }
  const chat = message.chat as Record<string, unknown>;
  if (chat.type !== 'private') {
    const text = messageText(message);
    if (text.startsWith('/') || text.includes('@')) {
      try {
        await sendReply(chatId, 'Please continue with the DataOps bot in a private chat.', config.botToken);
      } catch {
        logConversationalEvent('maintenance_reply_failed', 'telegram');
      }
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, route: 'private-only' }) };
  }
  if (senderIdFrom(message) !== chatId) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, route: 'maintenance' }) };
  }
  try {
    await sendReply(
      chatId,
      'DataOps conversational Telegram is in maintenance mode. No request was stored or executed.',
      config.botToken
    );
  } catch {
    logConversationalEvent('maintenance_reply_failed', 'telegram');
  }
  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, route: 'maintenance' }),
  };
}

async function handleTelegramWebhook(
  event: LambdaEvent,
  dependencyOverrides: TelegramRouteDependencyOverrides = {}
): Promise<LambdaResponse> {
  const rollout = conversationalRolloutSnapshot();
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
  if (!rollout.eligibility.runtimeAvailable) {
    return handleMaintenanceTelegramWebhook(
      event,
      config,
      dependencyOverrides.sendMaintenanceReply || sendTelegramReply
    );
  }
  try {
    const adapterConfig = conversationalTelegramConfig(
      config.botToken,
      config.webhookSecret,
      config.allowedChatIds,
      rollout
    );
    const client = dependencyOverrides.client || await getClient();
    const dependencies = adapterDependenciesFromConfig(adapterConfig, client, dependencyOverrides);
    return await handleConversationalTelegramWebhook(event, adapterConfig, dependencies);
  } catch {
    emitConversationalMetric('TelegramWebhookFailures', 1, 'telegram');
    logConversationalEvent('webhook_failed', 'telegram');
    return { statusCode: 503, body: JSON.stringify({ error: 'Conversational Telegram is unavailable' }) };
  }
}

function resetTelegramConfigCache(): void {
  cachedConfig = null;
  secretsClient = null;
}

export {
  MAX_MAINTENANCE_REPLY_DEADLINE_MS,
  handleTelegramWebhook,
  resetTelegramConfigCache,
  sendTelegramReply,
};
