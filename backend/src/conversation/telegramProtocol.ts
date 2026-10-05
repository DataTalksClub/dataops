import { createHash, timingSafeEqual } from 'crypto';
import { open } from 'fs/promises';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import type { LambdaResponse } from '../types';
import type { JsonValue } from './types';
import {
  TELEGRAM_FILE_PATH,
  type MediaLimits,
  type PhotoDescriber,
  type TelegramClient,
  type VoiceTranscriber,
} from './telegramMedia';

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

const TELEGRAM_MESSAGE_CHUNK_BYTES = 3_900;

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

export type {
  ActionContext,
  AdapterConfig,
  CoreInput,
  CoreInteraction,
  InputTrust,
  NormalizedKind,
  TelegramAdapterDependencies,
  TelegramCoreRuntime,
};
export {
  MAX_CALLBACK_BYTES,
  MAX_OUTBOUND_TEXT_BYTES,
  MAX_TEXT_BYTES,
  MAX_UPDATE_BYTES,
  HttpTelegramClient,
  TELEGRAM_MESSAGE_CHUNK_BYTES,
  actionId,
  boundedInteger,
  boundedText,
  canonicalChatId,
  canonicalNumeric,
  commandFrom,
  deadlinePromise,
  object,
  readBoundedJson,
  remainingSignal,
  response,
  safeEqual,
  sendBeforeDeadline,
  sendTelegramKeyboard,
  sendTelegramText,
  stableId,
  telegramChunks,
};
