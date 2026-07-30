import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdir, readdir, rm, symlink, utimes, writeFile } from 'fs/promises';
import path from 'path';
import { encode as encodeJpeg } from 'jpeg-js';
import { PutCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient, startLocal, stopLocal } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { TABLE_CONVERSATIONAL_STATE } from '../src/db/setup';
import { createUserWithId, updateUser } from '../src/db/users';
import {
  createConversation,
  getChannelBinding,
  getConversationEventByIdempotency,
  getConversationalPrivatePayload,
  getIdentityBinding,
  listConversationEvents,
  listOwnerConversations,
  replaceChannelBinding,
} from '../src/conversation/repository';
import {
  GroqWhisperClient,
  reapOrphanMedia,
  type PhotoDescriber,
  type TelegramClient,
  type VoiceTranscriber,
} from '../src/conversation/telegramMedia';
import {
  HttpTelegramClient,
  TelegramNotSentError,
  adapterDependenciesFromConfig,
  conversationalTelegramConfig,
  type CoreInput,
  type TelegramCoreRuntime,
} from '../src/conversation/telegramAdapter';
import { handleConversationalIdentityBindingRoutes } from '../src/routes/conversationalIdentityBindings';
import { handleTelegramWebhook, resetTelegramConfigCache } from '../src/routes/telegram';
import { expiryFrom, type Conversation, type JsonValue } from '../src/conversation/types';
import { CONVERSATIONAL_ENTITY_SPECS } from '../src/conversation/portable';
import type { LambdaEvent } from '../src/types';

const NOW = new Date('2026-07-30T12:00:00.000Z');
const ROOT = path.resolve('..', '.tmp', 'telegram-conversational-tests');

function apiEvent(
  method: string,
  requestPath: string,
  actorId?: string,
  body?: Record<string, unknown>,
  query?: Record<string, string>
): LambdaEvent {
  return {
    httpMethod: method,
    path: requestPath,
    headers: actorId ? { 'x-user-id': actorId } : {},
    body: body ? JSON.stringify(body) : null,
    queryStringParameters: query,
  };
}

function webhook(update: Record<string, unknown>): LambdaEvent {
  return {
    httpMethod: 'POST',
    path: '/api/webhook/telegram',
    headers: { 'x-telegram-bot-api-secret-token': 'webhook-secret' },
    body: JSON.stringify(update),
  };
}

function messageUpdate(
  updateId: number,
  content: Record<string, unknown>,
  options: { userId?: number; chatId?: number; type?: string } = {}
) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: options.userId ?? 7001, username: 'ignored-name' },
      chat: { id: options.chatId ?? 7001, type: options.type ?? 'private' },
      ...content,
    },
  };
}

function validJpeg(): Buffer {
  return encodeJpeg({
    width: 32,
    height: 16,
    data: Buffer.alloc(32 * 16 * 4, 127),
  }, 80).data;
}

function validOgg(seconds = 30): Buffer {
  const body = Buffer.concat([Buffer.from('OpusHead'), Buffer.alloc(11)]);
  const page = Buffer.alloc(28 + body.length);
  page.write('OggS', 0, 'ascii');
  page[4] = 0;
  page.writeBigUInt64LE(BigInt(seconds) * 48_000n, 6);
  page[26] = 1;
  page[27] = body.length;
  body.copy(page, 28);
  return page;
}

class FakeTelegram implements TelegramClient {
  readonly sent: Array<{ chatId: string; text: string; buttons?: Array<{ text: string; data: string }> }> = [];
  readonly answered: string[] = [];
  readonly downloads: string[] = [];
  files = new Map<string, { path: string; bytes: Buffer; size?: number }>();
  failNextSend = false;
  acceptThenThrow = false;

  async getFile(fileId: string) {
    const file = this.files.get(fileId);
    if (!file) throw new Error('missing fake file');
    return { filePath: file.path, fileSize: file.size ?? file.bytes.length };
  }

  async download(filePath: string, targetPath: string, maximumBytes: number) {
    const file = [...this.files.values()].find((candidate) => candidate.path === filePath);
    if (!file) throw new Error('missing fake path');
    if (file.bytes.length > maximumBytes) throw new Error('media_too_large');
    this.downloads.push(filePath);
    await writeFile(targetPath, file.bytes, { mode: 0o600 });
    return file.bytes.length;
  }

  async sendMessage(chatId: string, text: string) {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new TelegramNotSentError('fake_not_sent');
    }
    this.sent.push({ chatId, text });
    if (this.acceptThenThrow) {
      this.acceptThenThrow = false;
      throw new Error('fake_accepted_response_lost');
    }
  }

  async sendKeyboard(chatId: string, text: string, buttons: Array<{ text: string; data: string }>) {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new TelegramNotSentError('fake_not_sent');
    }
    this.sent.push({ chatId, text, buttons });
    if (this.acceptThenThrow) {
      this.acceptThenThrow = false;
      throw new Error('fake_accepted_response_lost');
    }
  }

  async answerCallbackQuery(id: string) {
    this.answered.push(id);
  }
}

class FakeCore implements TelegramCoreRuntime {
  readonly calls: CoreInput[] = [];
  delayed?: Promise<void>;
  reply?: string;
  buttons?: Array<{ text: string; action: JsonValue }>;
  async handle(input: CoreInput) {
    this.calls.push(input);
    await this.delayed;
    if (input.command === 'help') {
      return {
        kind: 'assistant_message' as const,
        message: 'Send private text, voice, or a photo; approvals require buttons.',
      };
    }
    if (input.command === 'sessions' || input.command === 'continue') {
      return {
        kind: 'clarification' as const,
        message: 'Choose one of your conversations.',
        buttons: [{ text: 'Recent conversation', action: { type: 'continue', conversationRef: 'opaque-core-ref' } }],
      };
    }
    return {
      kind: 'assistant_message' as const,
      message: this.reply || `core:${input.kind}:${input.text || input.command || ''}`,
      ...(this.buttons ? { buttons: this.buttons } : {}),
    };
  }
}

describe('private conversational Telegram adapter', () => {
  let client: Awaited<ReturnType<typeof getClient>>;
  let telegram: FakeTelegram;
  let core: FakeCore;
  let voiceCalls = 0;
  let photoCalls = 0;
  const voice: VoiceTranscriber = {
    transcribe: async () => {
      voiceCalls += 1;
      return 'transcribed voice text';
    },
  };
  const photo: PhotoDescriber = {
    describe: async (_file, caption) => {
      photoCalls += 1;
      return `photo description${caption ? ` (${caption})` : ''}`;
    },
  };

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    await createUserWithId(client, 'admin-telegram', {
      name: 'Admin', email: 'admin-telegram@example.test', role: 'admin',
    });
    await createUserWithId(client, 'operator-telegram', {
      name: 'Operator', email: 'operator-telegram@example.test', role: 'operator',
    });
    await createUserWithId(client, 'other-telegram', {
      name: 'Other', email: 'other-telegram@example.test', role: 'operator',
    });
  });

  after(async () => {
    await rm(ROOT, { recursive: true, force: true });
    await stopLocal();
  });

  beforeEach(async () => {
    process.env.CONVERSATIONAL_TELEGRAM_ENABLED = 'true';
    process.env.CONVERSATIONAL_TELEGRAM_VOICE_ENABLED = 'true';
    process.env.CONVERSATIONAL_TELEGRAM_PHOTO_ENABLED = 'true';
    process.env.TELEGRAM_BOT_TOKEN = 'fake-bot-token';
    process.env.TELEGRAM_WEBHOOK_SECRET = 'webhook-secret';
    process.env.TELEGRAM_ALLOWED_CHAT_IDS = '7001,-1007001';
    process.env.DATAOPS_TELEGRAM_MEDIA_TEMP_ROOT = ROOT;
    delete process.env.TELEGRAM_INTEGRATION_SECRET_NAME;
    resetTelegramConfigCache();
    telegram = new FakeTelegram();
    core = new FakeCore();
    voiceCalls = 0;
    photoCalls = 0;
    await rm(ROOT, { recursive: true, force: true });
    await mkdir(ROOT, { recursive: true });
    const existing = await getIdentityBinding(client, 'telegram', '7001');
    if (!existing) {
      const result = await handleConversationalIdentityBindingRoutes(
        '/api/conversational/identity-bindings',
        'POST',
        apiEvent('POST', '/api/conversational/identity-bindings', 'admin-telegram', {
          userId: 'operator-telegram', channel: 'telegram', channelUserId: '7001',
        }),
        client,
        () => NOW
      );
      assert.strictEqual(result?.statusCode, 201);
    } else if (existing.status === 'revoked') {
      await handleConversationalIdentityBindingRoutes(
        '/api/conversational/identity-bindings',
        'POST',
        apiEvent('POST', '/api/conversational/identity-bindings', 'admin-telegram', {
          userId: 'operator-telegram', channel: 'telegram', channelUserId: '7001',
        }),
        client,
        () => NOW
      );
    }
  });

  function dependencies(overrides: Record<string, unknown> = {}) {
    return {
      client, telegram, core, voice, photo, now: () => NOW,
      limits: {
        voiceMaximumBytes: 20 * 1024 * 1024,
        voiceMaximumSeconds: 300,
        photoMaximumBytes: 10 * 1024 * 1024,
        photoMaximumPixels: 20_000_000,
        downloadTimeoutMs: 1000,
        providerTimeoutMs: 1000,
        providerMaximumResponseBytes: 65_536,
        maximumDerivedTextBytes: 16_384,
      },
      ...overrides,
    };
  }

  async function outboundStatus(updateId: number): Promise<Record<string, unknown> | null> {
    const binding = await getChannelBinding(client, 'telegram', '7001', NOW);
    if (!binding) return null;
    const event = await getConversationEventByIdempotency(
      client, 'telegram', `telegram:${updateId}:outbound`, binding.conversationId
    );
    if (!event?.payloadRef) return null;
    const payload = await getConversationalPrivatePayload(
      client, binding.conversationId, event.payloadRef, 'operator-telegram', NOW
    );
    return payload?.content as Record<string, unknown> || null;
  }

  async function mediaPayload(updateId: number, kind: 'voice_note' | 'photo') {
    const binding = await getChannelBinding(client, 'telegram', '7001', NOW);
    assert.ok(binding);
    const event = await getConversationEventByIdempotency(
      client, 'telegram', `telegram:${updateId}:${kind}`, binding.conversationId
    );
    assert.ok(event?.payloadRef);
    const payload = await getConversationalPrivatePayload(
      client, binding.conversationId, event.payloadRef, 'operator-telegram', NOW
    );
    assert.ok(payload);
    return payload;
  }

  it('enforces the admin binding lifecycle, uniqueness, revisions, and disabled users', async () => {
    const list = await handleConversationalIdentityBindingRoutes(
      '/api/conversational/identity-bindings',
      'GET',
      apiEvent('GET', '/api/conversational/identity-bindings', 'admin-telegram', undefined, { channel: 'telegram' }),
      client
    );
    assert.strictEqual(list?.statusCode, 200);
    assert.doesNotMatch(list!.body, /username|token|secret/i);

    const forbidden = await handleConversationalIdentityBindingRoutes(
      '/api/conversational/identity-bindings',
      'GET',
      apiEvent('GET', '/api/conversational/identity-bindings', 'operator-telegram', undefined, { channel: 'telegram' }),
      client
    );
    assert.strictEqual(forbidden?.statusCode, 403);
    const anonymous = await handleConversationalIdentityBindingRoutes(
      '/api/conversational/identity-bindings',
      'GET',
      apiEvent('GET', '/api/conversational/identity-bindings', undefined, undefined, { channel: 'telegram' }),
      client
    );
    assert.strictEqual(anonymous?.statusCode, 401);

    const conflict = await handleConversationalIdentityBindingRoutes(
      '/api/conversational/identity-bindings',
      'POST',
      apiEvent('POST', '/api/conversational/identity-bindings', 'admin-telegram', {
        userId: 'other-telegram', channel: 'telegram', channelUserId: '7001',
      }),
      client
    );
    assert.strictEqual(conflict?.statusCode, 409);

    await updateUser(client, 'other-telegram', { disabled: true });
    const disabled = await handleConversationalIdentityBindingRoutes(
      '/api/conversational/identity-bindings',
      'POST',
      apiEvent('POST', '/api/conversational/identity-bindings', 'admin-telegram', {
        userId: 'other-telegram', channel: 'telegram', channelUserId: '7002',
      }),
      client
    );
    assert.strictEqual(disabled?.statusCode, 409);
    await updateUser(client, 'other-telegram', { disabled: false });

    const current = (await getIdentityBinding(client, 'telegram', '7001'))!;
    const stale = await handleConversationalIdentityBindingRoutes(
      '/api/conversational/identity-bindings/telegram/7001/revoke',
      'POST',
      apiEvent('POST', '/api/conversational/identity-bindings/telegram/7001/revoke', 'admin-telegram', {
        revision: current.revision + 1,
      }),
      client
    );
    assert.strictEqual(stale?.statusCode, 409);
    const revoked = await handleConversationalIdentityBindingRoutes(
      '/api/conversational/identity-bindings/telegram/7001/revoke',
      'POST',
      apiEvent('POST', '/api/conversational/identity-bindings/telegram/7001/revoke', 'admin-telegram', {
        revision: current.revision,
      }),
      client
    );
    assert.strictEqual(revoked?.statusCode, 200);
    assert.strictEqual((await getIdentityBinding(client, 'telegram', '7001'))?.status, 'revoked');

    const failingAuditClient = {
      send: async (command: { input?: { Item?: Record<string, unknown> } }) => {
        if (command instanceof PutCommand && command.input.Item?.recordType === 'identity_binding_audit') {
          throw new Error('injected_audit_failure');
        }
        return client.send(command as never);
      },
    } as unknown as DynamoDBDocumentClient;
    await assert.rejects(() => handleConversationalIdentityBindingRoutes(
      '/api/conversational/identity-bindings',
      'POST',
      apiEvent('POST', '/api/conversational/identity-bindings', 'admin-telegram', {
        userId: 'other-telegram', channel: 'telegram', channelUserId: '7003',
      }),
      failingAuditClient,
      () => NOW
    ), /injected_audit_failure/);
    assert.strictEqual(await getIdentityBinding(client, 'telegram', '7003'), null);

    const concurrent = await Promise.all([
      handleConversationalIdentityBindingRoutes(
        '/api/conversational/identity-bindings',
        'POST',
        apiEvent('POST', '/api/conversational/identity-bindings', 'admin-telegram', {
          userId: 'other-telegram', channel: 'telegram', channelUserId: '7004',
        }),
        client,
        () => NOW
      ),
      handleConversationalIdentityBindingRoutes(
        '/api/conversational/identity-bindings',
        'POST',
        apiEvent('POST', '/api/conversational/identity-bindings', 'admin-telegram', {
          userId: 'other-telegram', channel: 'telegram', channelUserId: '7004',
        }),
        client,
        () => NOW
      ),
    ]);
    const concurrentStatuses = concurrent.map((result) => result?.statusCode).sort();
    assert.ok(
      (
        concurrentStatuses[0] === 200
        && concurrentStatuses[1] === 201
      ) || (
        concurrentStatuses[0] === 201
        && concurrentStatuses[1] === 409
      ),
      `expected one create and one duplicate/conflict, received ${concurrentStatuses.join(',')}`
    );
    const createdResponse = concurrent.find((result) => result?.statusCode === 201);
    assert.ok(createdResponse);
    const createdBody = JSON.parse(createdResponse.body) as {
      binding: Record<string, unknown>;
    };
    const duplicateResponse = concurrent.find((result) => result?.statusCode === 200);
    if (duplicateResponse) {
      const duplicateBody = JSON.parse(duplicateResponse.body) as {
        binding: Record<string, unknown>;
        duplicate?: boolean;
      };
      assert.strictEqual(duplicateBody.duplicate, true);
      assert.deepStrictEqual(duplicateBody.binding, createdBody.binding);
    }
    const audits = await client.send(new QueryCommand({
      TableName: TABLE_CONVERSATIONAL_STATE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': 'IDENTITY_AUDIT#telegram#7004' },
    }));
    assert.strictEqual(audits.Items?.length, 1);
    const audit = audits.Items![0] as Record<string, unknown>;
    assert.strictEqual(
      Date.parse(String(audit.expiresAt)) - Date.parse(String(audit.createdAt)),
      365 * 86_400_000
    );
  });

  it('isolates groups and unknown private identities before runtime or media', async () => {
    const group = await handleTelegramWebhook(
      webhook(messageUpdate(100, { text: '/help@dataops' }, { chatId: -1007001, type: 'supergroup' })),
      dependencies()
    );
    assert.strictEqual(group.statusCode, 200);
    assert.strictEqual(core.calls.length, 0);
    assert.strictEqual(telegram.downloads.length, 0);
    assert.match(telegram.sent[0].text, /private chat/);

    telegram.sent.length = 0;
    const unknown = await handleTelegramWebhook(
      webhook(messageUpdate(101, { text: 'private request' }, { userId: 7999 })),
      dependencies()
    );
    assert.strictEqual(unknown.statusCode, 200);
    assert.strictEqual(core.calls.length, 0);
    assert.match(telegram.sent[0].text, /not linked/);
  });

  it('normalizes private text once and rejects stale runtime output', async () => {
    const first = await handleTelegramWebhook(webhook(messageUpdate(110, { text: 'hello' })), dependencies());
    assert.strictEqual(first.statusCode, 200);
    assert.strictEqual(core.calls.length, 1);
    assert.strictEqual(core.calls[0].kind, 'message');
    assert.strictEqual(core.calls[0].actor.id, 'operator-telegram');
    assert.equal(typeof core.calls[0].source?.payloadRef, 'string');
    assert.strictEqual(telegram.sent.length, 1);
    const duplicate = await handleTelegramWebhook(webhook(messageUpdate(110, { text: 'hello' })), dependencies());
    assert.strictEqual(JSON.parse(duplicate.body).duplicate, true);
    assert.strictEqual(core.calls.length, 1);
    assert.strictEqual(telegram.sent.length, 1);

    let release!: () => void;
    core.delayed = new Promise<void>((resolve) => { release = resolve; });
    const delayed = handleTelegramWebhook(webhook(messageUpdate(111, { text: 'slow' })), dependencies());
    while (!core.calls.some((call) => call.text === 'slow')) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    core.delayed = undefined;
    await handleTelegramWebhook(webhook(messageUpdate(112, { text: 'newer' })), dependencies());
    release();
    await delayed;
    assert.ok(!telegram.sent.some((sent) => sent.text.includes('slow')));

    core.reply = 'x'.repeat(8_000);
    const sentBeforeLongReply = telegram.sent.length;
    await handleTelegramWebhook(webhook(messageUpdate(113, { text: 'long reply' })), dependencies());
    const chunks = telegram.sent.slice(sentBeforeLongReply);
    assert.strictEqual(chunks.length, 3);
    assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk.text, 'utf8') <= 3_900));

    core.reply = '完整 preview '.repeat(2_000);
    core.buttons = [{ text: 'Approve', action: { type: 'approve' } }];
    const sentBeforeLongPreview = telegram.sent.length;
    await handleTelegramWebhook(webhook(messageUpdate(1119, { text: 'long preview' })), dependencies());
    const previewChunks = telegram.sent.slice(sentBeforeLongPreview);
    assert.ok(previewChunks.length > 4);
    assert.ok(previewChunks.every((chunk, index) => (
      chunk.text.startsWith(`Preview ${index + 1}/${previewChunks.length}\n`)
    )));
    assert.ok(previewChunks.slice(0, -1).every((chunk) => chunk.buttons === undefined));
    assert.deepEqual(previewChunks.at(-1)?.buttons?.map((button) => button.text), ['Approve']);
    core.buttons = undefined;
  });

  it('recovers a persisted outbound reply after send failure without rerunning core', async () => {
    telegram.failNextSend = true;
    const failed = await handleTelegramWebhook(
      webhook(messageUpdate(114, { text: 'recover me' })),
      dependencies()
    );
    assert.strictEqual(failed.statusCode, 503);
    assert.strictEqual(core.calls.length, 1);
    assert.strictEqual(telegram.sent.length, 0);

    const retried = await handleTelegramWebhook(
      webhook(messageUpdate(114, { text: 'recover me' })),
      dependencies()
    );
    assert.strictEqual(retried.statusCode, 200);
    assert.strictEqual(core.calls.length, 1);
    assert.strictEqual(telegram.sent.length, 1);
    assert.match(telegram.sent[0].text, /recover me/);
  });

  it('recovers an atomically persisted output after the transaction response boundary', async () => {
    let crashed = false;
    const first = await handleTelegramWebhook(
      webhook(messageUpdate(170, { text: 'persisted before crash' })),
      dependencies({
        afterOutboundPersist: async () => {
          if (!crashed) {
            crashed = true;
            throw new Error('simulated_post_commit_crash');
          }
        },
      })
    );
    assert.strictEqual(first.statusCode, 503);
    assert.strictEqual(core.calls.length, 1);
    assert.strictEqual(telegram.sent.length, 0);
    const retry = await handleTelegramWebhook(
      webhook(messageUpdate(170, { text: 'persisted before crash' })),
      dependencies()
    );
    assert.strictEqual(retry.statusCode, 200);
    assert.strictEqual(core.calls.length, 1);
    assert.strictEqual(telegram.sent.length, 1);
  });

  it('does not blindly resend after dispatch-started or accepted delivery ambiguity', async () => {
    const beforeSendCrash = await handleTelegramWebhook(
      webhook(messageUpdate(171, { text: 'crash before send' })),
      dependencies({ beforeOutboundSend: async () => { throw new Error('simulated_crash'); } })
    );
    assert.strictEqual(beforeSendCrash.statusCode, 503);
    assert.strictEqual(core.calls.length, 1);
    assert.strictEqual(telegram.sent.length, 0);
    const reconciledBeforeSend = await handleTelegramWebhook(
      webhook(messageUpdate(171, { text: 'crash before send' })),
      dependencies()
    );
    assert.strictEqual(reconciledBeforeSend.statusCode, 200);
    assert.strictEqual(core.calls.length, 1);
    assert.strictEqual(telegram.sent.length, 0);
    assert.strictEqual((await outboundStatus(171))?.status, 'outcome_unknown');
    assert.strictEqual((await outboundStatus(171))?.reconciliationRequired, true);

    telegram.acceptThenThrow = true;
    const acceptedLost = await handleTelegramWebhook(
      webhook(messageUpdate(172, { text: 'accepted response lost' })),
      dependencies()
    );
    assert.strictEqual(acceptedLost.statusCode, 200);
    assert.strictEqual(core.calls.length, 2);
    assert.strictEqual(telegram.sent.length, 1);
    assert.strictEqual((await outboundStatus(172))?.status, 'outcome_unknown');
    await handleTelegramWebhook(
      webhook(messageUpdate(172, { text: 'accepted response lost' })),
      dependencies()
    );
    assert.strictEqual(core.calls.length, 2);
    assert.strictEqual(telegram.sent.length, 1);

    const acceptedThenCrash = await handleTelegramWebhook(
      webhook(messageUpdate(173, { text: 'accepted before finalize crash' })),
      dependencies({ afterOutboundAccepted: async () => { throw new Error('simulated_finalize_crash'); } })
    );
    assert.strictEqual(acceptedThenCrash.statusCode, 503);
    assert.strictEqual(core.calls.length, 3);
    assert.strictEqual(telegram.sent.length, 2);
    assert.strictEqual((await outboundStatus(173))?.status, 'dispatching');
    await handleTelegramWebhook(
      webhook(messageUpdate(173, { text: 'accepted before finalize crash' })),
      dependencies()
    );
    assert.strictEqual(core.calls.length, 3);
    assert.strictEqual(telegram.sent.length, 2);
    assert.strictEqual((await outboundStatus(173))?.status, 'outcome_unknown');
  });

  it('revision-binds outbound persistence before a newer input races the send', async () => {
    let raced = false;
    const first = handleTelegramWebhook(
      webhook(messageUpdate(115, { text: 'committed first' })),
      dependencies({
        beforeOutboundSend: async () => {
          if (raced) return;
          raced = true;
          await handleTelegramWebhook(
            webhook(messageUpdate(116, { text: 'committed second' })),
            dependencies()
          );
        },
      })
    );
    assert.strictEqual((await first).statusCode, 200);
    assert.strictEqual(core.calls.length, 2);
    assert.ok(telegram.sent.some((sent) => sent.text.includes('committed first')));
    assert.ok(telegram.sent.some((sent) => sent.text.includes('committed second')));
    const conversations = await listOwnerConversations(client, 'operator-telegram', undefined, 20, NOW);
    const events = await listConversationEvents(
      client, conversations.items[0].id, 'operator-telegram', undefined, 50, NOW
    );
    assert.strictEqual(events.items.filter((event) => (
      event.direction === 'outbound'
      && (event.provenance === 'core-result:115' || event.provenance === 'core-result:116')
    )).length, 2);
  });

  it('maps core commands and blocks legacy mutation shortcuts', async () => {
    for (const [updateId, text] of [[120, '/social post now'], [1121, '/social']] as const) {
      const social = await handleTelegramWebhook(
        webhook(messageUpdate(updateId, { text })),
        dependencies()
      );
      assert.strictEqual(JSON.parse(social.body).route, 'social-guidance');
      assert.match(telegram.sent.at(-1)?.text || '', /typed social request.*confirm.*public source/i);
      assert.strictEqual(core.calls.length, 0);
    }
    const todo = await handleTelegramWebhook(
      webhook(messageUpdate(119, { text: '/todo buy milk tomorrow' })),
      dependencies()
    );
    assert.strictEqual(JSON.parse(todo.body).route, 'todo-guidance');
    assert.match(telegram.sent.at(-1)!.text, /ordinary private message/i);
    assert.strictEqual(core.calls.length, 0);
    await handleTelegramWebhook(webhook(messageUpdate(121, { text: 'yes' })), dependencies());
    assert.strictEqual(core.calls.at(-1)?.kind, 'message');
    await handleTelegramWebhook(webhook(messageUpdate(122, { text: '/cancel' })), dependencies());
    assert.strictEqual(core.calls.at(-1)?.command, 'cancel');
    await handleTelegramWebhook(webhook(messageUpdate(123, { text: '/help' })), dependencies());
    assert.match(telegram.sent.at(-1)!.text, /approvals require buttons/i);
    const sessions = await handleTelegramWebhook(webhook(messageUpdate(124, { text: '/sessions' })), dependencies());
    assert.strictEqual(JSON.parse(sessions.body).route, 'sessions');
    assert.ok(telegram.sent.at(-1)!.buttons);
  });

  it('stages one bounded OGG transcript, deduplicates provider work, and uses or discards explicitly', async () => {
    telegram.files.set('voice-file', { path: 'voice/file.ogg', bytes: validOgg() });
    const preview = await handleTelegramWebhook(webhook(messageUpdate(130, {
      voice: { file_id: 'voice-file', file_size: validOgg().length, duration: 30, mime_type: 'audio/ogg' },
    })), dependencies());
    assert.strictEqual(JSON.parse(preview.body).route, 'voice-preview');
    assert.strictEqual(voiceCalls, 1);
    assert.strictEqual(core.calls.length, 0);
    const useData = telegram.sent.at(-1)!.buttons![0].data;
    await handleTelegramWebhook(webhook(messageUpdate(130, {
      voice: { file_id: 'voice-file', file_size: validOgg().length, duration: 30, mime_type: 'audio/ogg' },
    })), dependencies());
    assert.strictEqual(voiceCalls, 1);

    const callback = {
      update_id: 131,
      callback_query: {
        id: 'callback-voice',
        from: { id: 7001 },
        data: useData,
        message: { message_id: 999, chat: { id: 7001, type: 'private' } },
      },
    };
    const used = await handleTelegramWebhook(webhook(callback), dependencies());
    assert.strictEqual(JSON.parse(used.body).route, 'button-action');
    assert.deepStrictEqual(telegram.answered, ['callback-voice']);
    assert.strictEqual(core.calls.at(-1)?.text, 'transcribed voice text');
    assert.strictEqual(core.calls.at(-1)?.kind, 'message');
    assert.strictEqual(core.calls.at(-1)?.inputTrust, 'untrusted_provider_derived');
    assert.strictEqual(core.calls.at(-1)?.source?.kind, 'voice_note');
    const usedPayload = await mediaPayload(130, 'voice_note');
    assert.strictEqual((usedPayload.content as Record<string, unknown>).status, 'used');
    assert.strictEqual((usedPayload.content as Record<string, unknown>).text, 'transcribed voice text');
    const afterUse = await handleTelegramWebhook(
      webhook(messageUpdate(134, { text: 'ordinary after use' })), dependencies()
    );
    assert.strictEqual(JSON.parse(afterUse.body).route, 'message');
    assert.strictEqual(core.calls.at(-1)?.source?.kind, 'telegram_text');
    assert.strictEqual(typeof core.calls.at(-1)?.source?.payloadRef, 'string');
    assert.deepStrictEqual(await readdir(ROOT), []);

    telegram.files.set('bad-voice', { path: 'voice/bad.ogg', bytes: Buffer.from('NOPE') });
    await handleTelegramWebhook(webhook(messageUpdate(132, {
      voice: { file_id: 'bad-voice', file_size: 4, duration: 5, mime_type: 'audio/ogg' },
    })), dependencies());
    assert.strictEqual(voiceCalls, 1);
    assert.match(telegram.sent.at(-1)!.text, /could not safely process/);

    telegram.files.set('overlong-voice', { path: 'voice/overlong.ogg', bytes: validOgg(301) });
    await handleTelegramWebhook(webhook(messageUpdate(133, {
      voice: { file_id: 'overlong-voice', file_size: validOgg(301).length, duration: 5, mime_type: 'audio/ogg' },
    })), dependencies());
    assert.strictEqual(voiceCalls, 1);
    assert.match(telegram.sent.at(-1)!.text, /could not safely process/);

    telegram.files.set('discard-voice', { path: 'voice/discard.ogg', bytes: validOgg() });
    await handleTelegramWebhook(webhook(messageUpdate(180, {
      voice: {
        file_id: 'discard-voice',
        file_size: validOgg().length,
        duration: 30,
        mime_type: 'audio/ogg',
      },
    })), dependencies());
    const discardButton = telegram.sent.at(-1)!.buttons![1].data;
    const beforeDiscardCore = core.calls.length;
    const discarded = await handleTelegramWebhook(webhook({
      update_id: 181,
      callback_query: {
        id: 'callback-discard',
        from: { id: 7001 },
        data: discardButton,
        message: { message_id: 1000, chat: { id: 7001, type: 'private' } },
      },
    }), dependencies());
    assert.strictEqual(JSON.parse(discarded.body).route, 'media-discarded');
    assert.strictEqual(core.calls.length, beforeDiscardCore);
    const discardedPayload = await mediaPayload(180, 'voice_note');
    const discardedContent = discardedPayload.content as Record<string, unknown>;
    assert.strictEqual(discardedContent.status, 'discarded');
    assert.strictEqual('text' in discardedContent, false);
    const controlActionIds = discardedContent.controlActionIds as string[];
    const controls = await Promise.all(controlActionIds.map((actionId) => (
      getConversationalPrivatePayload(
        client, discardedPayload.conversationId, actionId, 'operator-telegram', NOW
      )
    )));
    assert.deepStrictEqual(
      controls.map((control) => (control!.content as Record<string, unknown>).status).sort(),
      ['consumed', 'revoked']
    );
    const afterDiscard = await handleTelegramWebhook(
      webhook(messageUpdate(182, { text: 'ordinary after discard' })), dependencies()
    );
    assert.strictEqual(JSON.parse(afterDiscard.body).route, 'message');
    assert.strictEqual(core.calls.at(-1)?.source?.kind, 'telegram_text');
    assert.strictEqual(typeof core.calls.at(-1)?.source?.payloadRef, 'string');
  });

  it('uses opaque actor-bound actions once and rejects concurrent sibling or cross-actor use', async () => {
    telegram.files.set('voice-actions', { path: 'voice/actions.ogg', bytes: validOgg() });
    await handleTelegramWebhook(webhook(messageUpdate(160, {
      voice: {
        file_id: 'voice-actions',
        file_size: validOgg().length,
        duration: 30,
        mime_type: 'audio/ogg',
      },
    })), dependencies());
    const buttons = telegram.sent.at(-1)!.buttons!;
    assert.ok(buttons.every((button) => /^a\.[A-Za-z0-9_-]{32}$/.test(button.data)));
    assert.ok(buttons.every((button) => !/use|discard|continue|payload/i.test(button.data)));

    const callback = (updateId: number, data: string, userId = 7001) => ({
      update_id: updateId,
      callback_query: {
        id: `callback-${updateId}`,
        from: { id: userId },
        data,
        message: { message_id: 999, chat: { id: 7001, type: 'private' } },
      },
    });
    const beforeCore = core.calls.length;
    const raced = await Promise.all([
      handleTelegramWebhook(webhook(callback(161, buttons[0].data)), dependencies()),
      handleTelegramWebhook(webhook(callback(162, buttons[1].data)), dependencies()),
    ]);
    assert.strictEqual(raced.filter((result) => JSON.parse(result.body).route === 'button-action').length, 1);
    assert.strictEqual(core.calls.length, beforeCore + 1);

    const repeated = await handleTelegramWebhook(
      webhook(callback(163, buttons[0].data)),
      dependencies()
    );
    assert.strictEqual(JSON.parse(repeated.body).route, 'stale-action');
    assert.strictEqual(core.calls.length, beforeCore + 1);

    const crossActor = await handleTelegramWebhook(
      webhook(callback(164, buttons[0].data, 7999)),
      dependencies()
    );
    assert.strictEqual(JSON.parse(crossActor.body).route, 'link-required');
    assert.strictEqual(core.calls.length, beforeCore + 1);

    telegram.files.set('voice-cross-conversation', {
      path: 'voice/cross-conversation.ogg',
      bytes: validOgg(),
    });
    await handleTelegramWebhook(webhook(messageUpdate(165, {
      voice: {
        file_id: 'voice-cross-conversation',
        file_size: validOgg().length,
        duration: 30,
        mime_type: 'audio/ogg',
      },
    })), dependencies());
    const oldConversationData = telegram.sent.at(-1)!.buttons![0].data;
    const channelBinding = (await getChannelBinding(client, 'telegram', '7001', NOW))!;
    const timestamp = NOW.toISOString();
    const replacement: Conversation = {
      id: 'telegram-cross-conversation',
      recordType: 'conversation',
      schemaVersion: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...expiryFrom(timestamp, 30),
      ownerUserId: 'operator-telegram',
      audience: 'private',
      status: 'active',
      nextEventSequence: 1,
      revision: 1,
    };
    await createConversation(client, replacement);
    await replaceChannelBinding(
      client,
      { ...channelBinding, conversationId: replacement.id, updatedAt: timestamp },
      channelBinding.conversationId
    );
    const crossConversation = await handleTelegramWebhook(
      webhook(callback(166, oldConversationData)),
      dependencies()
    );
    assert.strictEqual(JSON.parse(crossConversation.body).route, 'stale-action');
  });

  it('allows exactly one correction or media callback winner and treats later text normally', async () => {
    telegram.files.set('voice-correction-race', {
      path: 'voice/correction-race.ogg',
      bytes: validOgg(),
    });
    await handleTelegramWebhook(webhook(messageUpdate(190, {
      voice: {
        file_id: 'voice-correction-race',
        file_size: validOgg().length,
        duration: 30,
        mime_type: 'audio/ogg',
      },
    })), dependencies());
    const useData = telegram.sent.at(-1)!.buttons![0].data;
    const callback = {
      update_id: 191,
      callback_query: {
        id: 'callback-correction-race',
        from: { id: 7001 },
        data: useData,
        message: { message_id: 1001, chat: { id: 7001, type: 'private' } },
      },
    };
    const beforeCore = core.calls.length;
    const results = await Promise.all([
      handleTelegramWebhook(webhook(callback), dependencies()),
      handleTelegramWebhook(
        webhook(messageUpdate(192, { text: 'racing correction' })),
        dependencies()
      ),
    ]);
    const routes = results.map((result) => JSON.parse(result.body).route);
    assert.strictEqual(
      routes.filter((route) => route === 'button-action' || route === 'media-correction').length,
      1
    );
    assert.strictEqual(
      routes.filter((route) => route === 'stale-action' || route === 'stale-media').length,
      1
    );
    assert.strictEqual(core.calls.length, beforeCore + 1);
    const racedPayload = await mediaPayload(190, 'voice_note');
    assert.ok(['used', 'corrected'].includes(
      String((racedPayload.content as Record<string, unknown>).status)
    ));
    const binding = (await getChannelBinding(client, 'telegram', '7001', NOW))!;
    const events = await listConversationEvents(
      client, binding.conversationId, 'operator-telegram', undefined, 100, NOW
    );
    assert.strictEqual(events.items.filter((event) => (
      event.idempotencyKey === 'telegram:191:message'
      || event.idempotencyKey === 'telegram:192:message'
    )).length, 1);

    const winnerIndex = routes.findIndex((route) => (
      route === 'button-action' || route === 'media-correction'
    ));
    const replay = winnerIndex === 0
      ? await handleTelegramWebhook(webhook(callback), dependencies())
      : await handleTelegramWebhook(
        webhook(messageUpdate(192, { text: 'racing correction' })),
        dependencies()
      );
    assert.strictEqual(replay.statusCode, 200);
    assert.strictEqual(core.calls.length, beforeCore + 1);

    const afterTerminal = await handleTelegramWebhook(
      webhook(messageUpdate(193, { text: 'ordinary after race' })), dependencies()
    );
    assert.strictEqual(JSON.parse(afterTerminal.body).route, 'message');
    assert.strictEqual(core.calls.at(-1)?.source?.kind, 'telegram_text');
    assert.strictEqual(typeof core.calls.at(-1)?.source?.payloadRef, 'string');
  });

  it('stages bounded JPEG OCR with caption, supports correction, and rejects image documents', async () => {
    telegram.files.set('photo-file', { path: 'photos/photo.jpg', bytes: validJpeg() });
    await handleTelegramWebhook(webhook(messageUpdate(140, {
      photo: [{ file_id: 'photo-file', file_size: validJpeg().length, width: 32, height: 16 }],
      caption: 'separate caption',
    })), dependencies());
    assert.strictEqual(photoCalls, 1);
    assert.match(telegram.sent.at(-1)!.text, /photo description/);
    await handleTelegramWebhook(webhook(messageUpdate(141, { text: 'corrected image text' })), dependencies());
    assert.strictEqual(core.calls.at(-1)?.text, 'corrected image text');
    const correctedPayload = await mediaPayload(140, 'photo');
    const correctedContent = correctedPayload.content as Record<string, unknown>;
    assert.strictEqual(correctedContent.status, 'corrected');
    assert.strictEqual('text' in correctedContent, false);
    assert.strictEqual('caption' in correctedContent, false);
    const correctedControls = await Promise.all(
      (correctedContent.controlActionIds as string[]).map((actionId) => (
        getConversationalPrivatePayload(
          client, correctedPayload.conversationId, actionId, 'operator-telegram', NOW
        )
      ))
    );
    assert.deepStrictEqual(
      correctedControls.map((control) => (control!.content as Record<string, unknown>).status),
      ['revoked', 'revoked']
    );
    const afterCorrection = await handleTelegramWebhook(
      webhook(messageUpdate(146, { text: 'ordinary after correction' })), dependencies()
    );
    assert.strictEqual(JSON.parse(afterCorrection.body).route, 'message');
    assert.strictEqual(core.calls.at(-1)?.source?.kind, 'telegram_text');
    assert.strictEqual(typeof core.calls.at(-1)?.source?.payloadRef, 'string');
    const before = photoCalls;
    await handleTelegramWebhook(webhook(messageUpdate(142, {
      document: { file_id: 'photo-file', mime_type: 'image/jpeg' },
    })), dependencies());
    assert.strictEqual(photoCalls, before);
    assert.match(telegram.sent.at(-1)!.text, /not supported/);

    const headerOnly = Buffer.from([
      0xff, 0xd8,
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x10, 0x00, 0x20, 0x01, 0x01, 0x11, 0x00,
      0xff, 0xd9,
    ]);
    telegram.files.set('header-only', { path: 'photos/header-only.jpg', bytes: headerOnly });
    await handleTelegramWebhook(webhook(messageUpdate(143, {
      photo: [{ file_id: 'header-only', file_size: headerOnly.length, width: 32, height: 16 }],
    })), dependencies());
    assert.strictEqual(photoCalls, before);

    const truncated = Buffer.concat([validJpeg().subarray(0, validJpeg().length - 100), Buffer.from([0xff, 0xd9])]);
    telegram.files.set('truncated-photo', { path: 'photos/truncated.jpg', bytes: truncated });
    await handleTelegramWebhook(webhook(messageUpdate(144, {
      photo: [{ file_id: 'truncated-photo', file_size: truncated.length, width: 32, height: 16 }],
    })), dependencies());
    assert.strictEqual(photoCalls, before);

    const bomb = Buffer.from([
      0xff, 0xd8,
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0xff, 0xff, 0xff, 0xff, 0x01, 0x01, 0x11, 0x00,
      0xff, 0xd9,
    ]);
    telegram.files.set('bomb-photo', { path: 'photos/bomb.jpg', bytes: bomb });
    await handleTelegramWebhook(webhook(messageUpdate(145, {
      photo: [{ file_id: 'bomb-photo', file_size: bomb.length, width: 1, height: 1 }],
    })), dependencies());
    assert.strictEqual(photoCalls, before);
  });

  it('fails closed when media flags/config are disabled and preserves legacy behavior when global is off', async () => {
    process.env.CONVERSATIONAL_TELEGRAM_VOICE_ENABLED = 'false';
    telegram.files.set('voice-disabled', { path: 'voice/file.ogg', bytes: validOgg() });
    await handleTelegramWebhook(webhook(messageUpdate(150, {
      voice: { file_id: 'voice-disabled', duration: 2, file_size: validOgg().length, mime_type: 'audio/ogg' },
    })), { client, telegram, core, voice, photo, now: () => NOW });
    assert.strictEqual(voiceCalls, 0);
    assert.strictEqual(telegram.downloads.length, 0);

    process.env.CONVERSATIONAL_TELEGRAM_ENABLED = 'false';
    delete process.env.TELEGRAM_BOT_TOKEN;
    resetTelegramConfigCache();
    const legacy = await handleTelegramWebhook(webhook({
      message: { message_id: 151, chat: { id: 7001 }, text: '/status' },
    }));
    assert.strictEqual(JSON.parse(legacy.body).route, 'status');
  });

  it('reaps only old safe directories within budget and never follows symlinks', async () => {
    const old = path.join(ROOT, 'old-safe');
    const fresh = path.join(ROOT, 'fresh');
    const outside = path.join(ROOT, '..', 'telegram-outside');
    await mkdir(old, { recursive: true });
    await mkdir(fresh, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(old, 'voice.ogg'), 'OggS');
    await writeFile(path.join(outside, 'keep.txt'), 'keep');
    await symlink(outside, path.join(ROOT, 'outside-link'));
    const oldTime = new Date(NOW.getTime() - 20 * 60 * 1000);
    await utimes(old, oldTime, oldTime);
    await utimes(fresh, NOW, NOW);
    const result = await reapOrphanMedia(ROOT, NOW, { maximumEntries: 10, maximumBytes: 1000 });
    assert.strictEqual(result.removed, 1);
    assert.ok((await readdir(ROOT)).includes('fresh'));
    assert.ok((await readdir(ROOT)).includes('outside-link'));
    assert.deepStrictEqual(await readdir(outside), ['keep.txt']);
    await rm(outside, { recursive: true, force: true });
  });

  it('persists bounded private events without usernames or raw media', async () => {
    await handleTelegramWebhook(webhook(messageUpdate(160, { text: 'private event text' })), dependencies());
    const conversations = await listOwnerConversations(client, 'operator-telegram', undefined, 20, NOW);
    const conversation = conversations.items[0];
    const events = await listConversationEvents(client, conversation.id, 'operator-telegram', undefined, 50, NOW);
    const serialized = JSON.stringify(events.items);
    assert.doesNotMatch(serialized, /ignored-name|fake-bot-token|private event text|OggS/);
    assert.match(serialized, /telegram:160:message/);
    const privatePayloadSpec = CONVERSATIONAL_ENTITY_SPECS.find(
      (spec) => spec.recordType === 'conversational_private_payload'
    )!;
    const portable = privatePayloadSpec.map({
      PK: 'PRIVATE_PAYLOAD#test',
      SK: 'META',
      id: 'test',
      recordType: 'conversational_private_payload',
      schemaVersion: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      conversationId: conversation.id,
      classification: 'private',
      content: {
        kind: 'voice_note',
        status: 'staged',
        revision: 2,
        text: 'private transcript must not export',
        caption: 'private caption must not export',
        action: { type: 'media_use', payloadRef: 'safe-reference' },
      },
    });
    assert.doesNotMatch(
      JSON.stringify(portable),
      /private transcript must not export|private caption must not export/
    );
    assert.deepStrictEqual(
      (portable.content as Record<string, unknown>).redactedFields,
      ['caption', 'text']
    );
    const resultNotificationSpec = CONVERSATIONAL_ENTITY_SPECS.find(
      (spec) => spec.recordType === 'result_notification'
    )!;
    const portableNotification = resultNotificationSpec.map({
      PK: 'RESULT_NOTIFICATION#test',
      SK: 'META',
      GSI2PK: 'RESULT_NOTIFICATION_STATE#pending',
      GSI2SK: `READY#${NOW.toISOString()}#test`,
      id: 'test',
      recordType: 'result_notification',
      schemaVersion: 1,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      conversationId: conversation.id,
      executionAttemptId: 'attempt-test',
      actorId: 'operator-telegram',
      channel: 'telegram',
      channelConversationKey: '7001',
      identityChannelUserId: '7001',
      identityBindingId: 'identity-test',
      identityBindingRevision: 1,
      channelBindingId: 'channel-test',
      privatePayloadRef: 'execution-result-attempt-test',
      status: 'pending',
      readyAt: NOW.toISOString(),
      leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      revision: 1,
    });
    assert.equal(portableNotification.status, 'outcome_unknown');
    assert.equal('channelConversationKey' in portableNotification, false);
    assert.equal('identityChannelUserId' in portableNotification, false);
    assert.equal('leaseExpiresAt' in portableNotification, false);
  });

  it('bounds hanging and oversized Telegram/provider responses and has no production fake core', async () => {
    const hangingFetch = (async (_input: unknown, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })
    )) as typeof fetch;
    const hangingTelegram = new HttpTelegramClient('fake', 100, 1024, hangingFetch);
    const started = Date.now();
    await assert.rejects(() => hangingTelegram.getFile('safe-file'));
    assert.ok(Date.now() - started < 1_000);

    let telegramCalls = 0;
    const oversizedFetch = (async () => {
      telegramCalls += 1;
      return new Response(Buffer.alloc(2_048, 0x20), { status: 200 });
    }) as typeof fetch;
    const oversizedTelegram = new HttpTelegramClient('fake', 100, 1024, oversizedFetch);
    await assert.rejects(() => oversizedTelegram.getFile('safe-file'), /too_large/);
    assert.strictEqual(telegramCalls, 2);

    const voicePath = path.join(ROOT, 'bounded-provider.ogg');
    await writeFile(voicePath, validOgg());
    const oversizedProvider = new GroqWhisperClient(
      'arn:example',
      { apiKey: async () => 'fake-key' } as never,
      'https://groq.example/transcribe',
      1024,
      (async () => new Response(Buffer.alloc(2_048, 0x61), { status: 200 })) as typeof fetch
    );
    await assert.rejects(
      () => oversizedProvider.transcribe(voicePath, AbortSignal.timeout(1_000)),
      /provider_response_too_large/
    );

    process.env.CONVERSATIONAL_TELEGRAM_VOICE_ENABLED = 'false';
    process.env.CONVERSATIONAL_TELEGRAM_PHOTO_ENABLED = 'false';
    const config = conversationalTelegramConfig('fake', 'secret', new Set(['7001']));
    assert.throws(
      () => adapterDependenciesFromConfig(config, client),
      /telegram_core_unavailable/
    );
  });
});
