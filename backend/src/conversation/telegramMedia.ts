import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
} from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { decode as decodeJpeg } from 'jpeg-js';

const DEFAULT_TEMP_ROOT = '/tmp/dataops-telegram-media';
const TELEGRAM_FILE_PATH = /^[a-zA-Z0-9_./-]{1,500}$/;
const SAFE_TEXT = /(?:bearer\s+\S+|(?:api[_-]?key|secret|token|password|credential|authorization)\s*[:=]\s*\S+)/i;

interface TelegramFileInfo {
  filePath: string;
  fileSize?: number;
}

interface TelegramClient {
  getFile(fileId: string): Promise<TelegramFileInfo>;
  download(filePath: string, targetPath: string, maximumBytes: number, signal: AbortSignal): Promise<number>;
  sendMessage(chatId: string, text: string): Promise<void>;
  sendKeyboard(chatId: string, text: string, buttons: Array<{ text: string; data: string }>): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  disableControls?(chatId: string, messageId: string): Promise<void>;
}

interface VoiceTranscriber {
  transcribe(filePath: string, signal: AbortSignal): Promise<string>;
}

interface PhotoDescriber {
  describe(filePath: string, caption: string | undefined, signal: AbortSignal): Promise<string>;
}

interface MediaLimits {
  voiceMaximumBytes: number;
  voiceMaximumSeconds: number;
  photoMaximumBytes: number;
  photoMaximumPixels: number;
  downloadTimeoutMs: number;
  providerTimeoutMs: number;
  providerMaximumResponseBytes: number;
  maximumDerivedTextBytes: number;
}

const DEFAULT_LIMITS: MediaLimits = {
  voiceMaximumBytes: 20 * 1024 * 1024,
  voiceMaximumSeconds: 300,
  photoMaximumBytes: 10 * 1024 * 1024,
  photoMaximumPixels: 20_000_000,
  downloadTimeoutMs: 8_000,
  providerTimeoutMs: 18_000,
  providerMaximumResponseBytes: 65_536,
  maximumDerivedTextBytes: 16_384,
};

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new Error('Telegram media configuration is outside allowed bounds');
  }
  return candidate;
}

function mediaLimitsFromEnv(): MediaLimits {
  return {
    voiceMaximumBytes: boundedInteger(process.env.TELEGRAM_VOICE_MAX_BYTES, DEFAULT_LIMITS.voiceMaximumBytes, 1, 20 * 1024 * 1024),
    voiceMaximumSeconds: boundedInteger(process.env.TELEGRAM_VOICE_MAX_SECONDS, DEFAULT_LIMITS.voiceMaximumSeconds, 1, 300),
    photoMaximumBytes: boundedInteger(process.env.TELEGRAM_PHOTO_MAX_BYTES, DEFAULT_LIMITS.photoMaximumBytes, 1, 10 * 1024 * 1024),
    photoMaximumPixels: boundedInteger(process.env.TELEGRAM_PHOTO_MAX_PIXELS, DEFAULT_LIMITS.photoMaximumPixels, 1, 20_000_000),
    downloadTimeoutMs: boundedInteger(process.env.TELEGRAM_MEDIA_DOWNLOAD_TIMEOUT_MS, DEFAULT_LIMITS.downloadTimeoutMs, 100, 10_000),
    providerTimeoutMs: boundedInteger(process.env.TELEGRAM_MEDIA_PROVIDER_TIMEOUT_MS, DEFAULT_LIMITS.providerTimeoutMs, 100, 20_000),
    providerMaximumResponseBytes: boundedInteger(
      process.env.TELEGRAM_MEDIA_PROVIDER_MAX_RESPONSE_BYTES,
      DEFAULT_LIMITS.providerMaximumResponseBytes,
      1_024,
      256 * 1024
    ),
    maximumDerivedTextBytes: boundedInteger(process.env.TELEGRAM_MEDIA_MAX_TEXT_BYTES, DEFAULT_LIMITS.maximumDerivedTextBytes, 1, 16_384),
  };
}

function validateDerivedText(value: unknown, maximumBytes: number): string {
  if (typeof value !== 'string') throw new Error('media_invalid_output');
  const normalized = value.trim();
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > maximumBytes || SAFE_TEXT.test(normalized)) {
    throw new Error('media_invalid_output');
  }
  return normalized;
}

async function validateOgg(filePath: string, maximumSeconds: number): Promise<void> {
  const bytes = await readFile(filePath);
  let offset = 0;
  let sawOpus = false;
  let maximumGranule = 0n;
  while (offset < bytes.length) {
    if (offset + 27 > bytes.length || bytes.toString('ascii', offset, offset + 4) !== 'OggS' || bytes[offset + 4] !== 0) {
      throw new Error('voice_invalid_container');
    }
    const segments = bytes[offset + 26];
    const headerLength = 27 + segments;
    if (offset + headerLength > bytes.length) throw new Error('voice_invalid_container');
    let bodyLength = 0;
    for (let index = 0; index < segments; index += 1) bodyLength += bytes[offset + 27 + index];
    const pageEnd = offset + headerLength + bodyLength;
    if (pageEnd > bytes.length) throw new Error('voice_invalid_container');
    const granule = bytes.readBigUInt64LE(offset + 6);
    if (granule !== 0xffffffffffffffffn && granule > maximumGranule) maximumGranule = granule;
    const opusOffset = bytes.indexOf(Buffer.from('OpusHead'), offset + headerLength);
    if (opusOffset >= offset + headerLength && opusOffset < pageEnd) sawOpus = true;
    offset = pageEnd;
  }
  if (!sawOpus || maximumGranule <= 0n || maximumGranule > BigInt(maximumSeconds) * 48_000n) {
    throw new Error('voice_invalid_duration');
  }
}

function jpegDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error('photo_invalid_jpeg');
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new Error('photo_invalid_jpeg');
}

async function validateJpeg(filePath: string, maximumPixels: number): Promise<void> {
  const info = await stat(filePath);
  if (info.size < 4) throw new Error('photo_invalid_jpeg');
  const bytes = await readFile(filePath);
  const handle = await open(filePath, 'r');
  try {
    const dimensions = jpegDimensions(bytes);
    if (dimensions.width <= 0 || dimensions.height <= 0 || dimensions.width * dimensions.height > maximumPixels) {
      throw new Error('photo_too_large');
    }
    const tail = Buffer.alloc(2);
    await handle.read(tail, 0, 2, info.size - 2);
    if (tail[0] !== 0xff || tail[1] !== 0xd9) throw new Error('photo_invalid_jpeg');
    let decoded: { width: number; height: number; data: Uint8Array };
    try {
      decoded = decodeJpeg(bytes, {
        useTArray: true,
        formatAsRGBA: false,
        tolerantDecoding: false,
        maxResolutionInMP: maximumPixels / 1_000_000,
        maxMemoryUsageInMB: 128,
      });
    } catch {
      throw new Error('photo_invalid_jpeg');
    }
    if (
      decoded.width !== dimensions.width
      || decoded.height !== dimensions.height
      || decoded.width * decoded.height > maximumPixels
      || decoded.data.byteLength !== decoded.width * decoded.height * 3
    ) throw new Error('photo_invalid_jpeg');
  } finally {
    await handle.close();
  }
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) throw new Error('provider_empty_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximumBytes) throw new Error('provider_response_too_large');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('provider_invalid_response');
  }
}

async function createInvocationDirectory(root: string, updateId: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('media_unsafe_temp_root');
  const directory = path.join(root, `${updateId.replace(/\D/g, '').slice(0, 30)}-${randomBytes(12).toString('hex')}`);
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

async function removeInvocationDirectory(root: string, directory: string): Promise<void> {
  const relative = path.relative(root, directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
  const info = await lstat(directory).catch(() => null);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) return;
  await rm(directory, { recursive: true, force: true });
}

async function reapOrphanMedia(
  root: string,
  now: Date,
  options: { maximumEntries?: number; maximumBytes?: number; olderThanMs?: number; maximumRuntimeMs?: number } = {}
): Promise<{ removed: number; bytes: number }> {
  const maximumEntries = options.maximumEntries ?? 20;
  const maximumBytes = options.maximumBytes ?? 50 * 1024 * 1024;
  const olderThanMs = options.olderThanMs ?? 15 * 60 * 1000;
  const maximumRuntimeMs = options.maximumRuntimeMs ?? 100;
  const started = process.hrtime.bigint();
  const timedOut = () => Number(process.hrtime.bigint() - started) / 1_000_000 >= maximumRuntimeMs;
  const rootInfo = await lstat(root).catch(() => null);
  if (!rootInfo || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return { removed: 0, bytes: 0 };
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  let bytes = 0;
  for (const entry of entries.slice(0, maximumEntries)) {
    if (timedOut()) break;
    const target = path.join(root, entry.name);
    const info = await lstat(target).catch(() => null);
    if (!info || info.isSymbolicLink() || !info.isDirectory() || now.getTime() - info.mtimeMs < olderThanMs) continue;
    const children = await readdir(target, { withFileTypes: true }).catch(() => []);
    let directoryBytes = 0;
    let safe = true;
    for (const child of children.slice(0, maximumEntries)) {
      if (timedOut()) { safe = false; break; }
      const childInfo = await lstat(path.join(target, child.name)).catch(() => null);
      if (!childInfo || childInfo.isSymbolicLink() || !childInfo.isFile()) { safe = false; break; }
      directoryBytes += childInfo.size;
    }
    if (!safe || children.length > maximumEntries || bytes + directoryBytes > maximumBytes) continue;
    await rm(target, { recursive: true, force: true });
    removed += 1;
    bytes += directoryBytes;
  }
  return { removed, bytes };
}

class AwsJsonSecretReader {
  private readonly client = new SecretsManagerClient({});
  async apiKey(secretArn: string): Promise<string> {
    const result = await this.client.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const parsed = JSON.parse(result.SecretString || '{}') as Record<string, unknown>;
    if (typeof parsed.apiKey !== 'string' || !parsed.apiKey.trim() || parsed.apiKey.length > 1000) {
      throw new Error('media_config_error');
    }
    return parsed.apiKey;
  }
}

class GroqWhisperClient implements VoiceTranscriber {
  private key?: string;
  constructor(
    private readonly secretArn: string,
    private readonly reader = new AwsJsonSecretReader(),
    private readonly baseUrl = 'https://api.groq.com/openai/v1/audio/transcriptions',
    private readonly maximumResponseBytes = DEFAULT_LIMITS.providerMaximumResponseBytes,
    private readonly fetcher: typeof fetch = fetch
  ) {}
  async transcribe(filePath: string, signal: AbortSignal): Promise<string> {
    this.key ||= await this.reader.apiKey(this.secretArn);
    const data = new FormData();
    data.set('model', 'whisper-large-v3');
    data.set('response_format', 'text');
    data.set('file', new Blob([new Uint8Array(await readFile(filePath))], { type: 'audio/ogg' }), 'voice.ogg');
    const response = await this.fetcher(this.baseUrl, {
      method: 'POST', headers: { Authorization: `Bearer ${this.key}` }, body: data, signal,
    });
    if (!response.ok) throw new Error(`groq_${response.status}`);
    return readBoundedResponse(response, this.maximumResponseBytes);
  }
}

class ZaiVisionClient implements PhotoDescriber {
  private key?: string;
  constructor(
    private readonly secretArn: string,
    private readonly reader = new AwsJsonSecretReader(),
    private readonly model = 'glm-4.6v',
    private readonly baseUrl = 'https://api.z.ai/api/paas/v4/chat/completions',
    private readonly maximumResponseBytes = DEFAULT_LIMITS.providerMaximumResponseBytes,
    private readonly fetcher: typeof fetch = fetch
  ) {}
  async describe(filePath: string, caption: string | undefined, signal: AbortSignal): Promise<string> {
    this.key ||= await this.reader.apiKey(this.secretArn);
    const image = (await readFile(filePath)).toString('base64');
    const response = await this.fetcher(this.baseUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2048,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: `Describe this image and transcribe visible text as plain text.${caption ? ` User caption: ${caption}` : ''}` },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } },
          ],
        }],
      }),
      signal,
    });
    if (!response.ok) throw new Error(`vision_${response.status}`);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBoundedResponse(response, this.maximumResponseBytes)) as Record<string, unknown>;
    } catch (error) {
      if ((error as Error).message === 'provider_response_too_large') throw error;
      throw new Error('media_invalid_output');
    }
    const choices = body.choices as Array<Record<string, unknown>> | undefined;
    const message = choices?.[0]?.message as Record<string, unknown> | undefined;
    if (typeof message?.content !== 'string') throw new Error('media_invalid_output');
    return message.content;
  }
}

export {
  DEFAULT_LIMITS,
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
};
export type {
  MediaLimits,
  PhotoDescriber,
  TelegramClient,
  TelegramFileInfo,
  VoiceTranscriber,
};
