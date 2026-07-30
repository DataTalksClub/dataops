import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';

import { startLocal, stopLocal } from '../src/db/client';
import { MAX_UPDATE_BYTES } from '../src/conversation/telegramAdapter';
import {
  MAX_MAINTENANCE_REPLY_DEADLINE_MS,
  handleTelegramWebhook,
} from '../src/routes/telegram';

describe('Telegram rollout cutover', () => {
  before(async () => {
    await startLocal();
    process.env.IS_LOCAL = 'true';
    process.env.TELEGRAM_WEBHOOK_SECRET = 'test-secret';
    process.env.TELEGRAM_ALLOWED_CHAT_IDS = '12345,-1001';
    process.env.CONVERSATIONAL_TELEGRAM_INGRESS_ENABLED = 'false';
    process.env.CONVERSATIONAL_EXECUTION_ENABLED = 'false';
    process.env.CONVERSATIONAL_ENABLED_PLUGINS = 'none';
    process.env.CONVERSATIONAL_TYPEFULLY_EXTERNAL_EXECUTION_ENABLED = 'false';
    process.env.CONVERSATIONAL_TELEGRAM_VOICE_ENABLED = 'false';
    process.env.CONVERSATIONAL_TELEGRAM_PHOTO_ENABLED = 'false';
  });

  after(async () => {
    await stopLocal();
    delete process.env.IS_LOCAL;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    delete process.env.TELEGRAM_ALLOWED_CHAT_IDS;
  });

  it('authenticates dark-mode private input and performs only one bounded maintenance reply', async () => {
    const replies: Array<{ chatId: string; text: string; botToken?: string }> = [];
    const response = await handleTelegramWebhook({
      headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
      body: JSON.stringify({
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 12345, type: 'private' },
          from: { id: 12345 },
          text: 'create a task',
        },
      }),
    } as never, {
      async sendMaintenanceReply(chatId, text, botToken) {
        replies.push({ chatId, text, botToken });
      },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), { ok: true, route: 'maintenance' });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].chatId, '12345');
    assert.match(replies[0].text, /maintenance mode/i);
    assert.match(replies[0].text, /No request was stored or executed/i);
    assert.ok(Buffer.byteLength(replies[0].text, 'utf8') < 300);
  });

  it('accepts exactly 256 KiB and rejects the next byte before parse or downstream work', async () => {
    const update = {
      update_id: 6,
      message: {
        message_id: 6,
        chat: { id: 12345, type: 'private' },
        from: { id: 12345 },
        text: '/status',
      },
      padding: '',
    };
    const empty = JSON.stringify(update);
    update.padding = 'x'.repeat(MAX_UPDATE_BYTES - Buffer.byteLength(empty, 'utf8'));
    const boundary = JSON.stringify(update);
    assert.equal(Buffer.byteLength(boundary, 'utf8'), MAX_UPDATE_BYTES);

    let replies = 0;
    const accepted = await handleTelegramWebhook({
      headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
      body: boundary,
    } as never, {
      async sendMaintenanceReply() {
        replies += 1;
      },
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(replies, 1);

    const invalidOversizedBody = `{${'x'.repeat(MAX_UPDATE_BYTES)}`;
    assert.equal(Buffer.byteLength(invalidOversizedBody, 'utf8'), MAX_UPDATE_BYTES + 1);
    let downstreamCalls = 0;
    const rejected = await handleTelegramWebhook({
      headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
      body: invalidOversizedBody,
    } as never, {
      async sendMaintenanceReply() {
        replies += 1;
      },
      get client(): never {
        downstreamCalls += 1;
        throw new Error('oversized dark input must not acquire DynamoDB');
      },
      get core(): never {
        downstreamCalls += 1;
        throw new Error('oversized dark input must not construct the core');
      },
      get telegram(): never {
        downstreamCalls += 1;
        throw new Error('oversized dark input must not construct Telegram adapter work');
      },
    } as never);
    assert.equal(rejected.statusCode, 413);
    assert.deepEqual(JSON.parse(rejected.body), { error: 'Telegram update is too large' });
    assert.equal(replies, 1);
    assert.equal(downstreamCalls, 0);

    const unauthenticated = await handleTelegramWebhook({
      headers: { 'x-telegram-bot-api-secret-token': 'wrong' },
      body: invalidOversizedBody,
    } as never);
    assert.equal(unauthenticated.statusCode, 401);
  });

  it('aborts one dark reply by the capped deadline, never retries, and acknowledges safely', async () => {
    assert.ok(MAX_MAINTENANCE_REPLY_DEADLINE_MS <= 5_000);
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    const originalBotToken = process.env.TELEGRAM_BOT_TOKEN;
    const originalTimeout = process.env.TELEGRAM_API_TIMEOUT_MS;
    const logs: string[] = [];
    let attempts = 0;
    let observedAbort = false;
    process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token-private';
    process.env.TELEGRAM_API_TIMEOUT_MS = '100';
    console.log = (...values: unknown[]) => {
      logs.push(values.map(String).join(' '));
    };
    globalThis.fetch = ((_url, init) => new Promise<Response>((_resolve, reject) => {
      attempts += 1;
      const signal = init?.signal;
      assert.ok(signal);
      signal.addEventListener('abort', () => {
        observedAbort = true;
        reject(new Error('synthetic private update must not be logged'));
      }, { once: true });
    })) as typeof fetch;

    try {
      const startedAt = Date.now();
      const response = await handleTelegramWebhook({
        headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
        body: JSON.stringify({
          update_id: 7,
          message: {
            message_id: 7,
            chat: { id: 12345, type: 'private' },
            from: { id: 12345 },
            text: 'private input must not be logged',
          },
        }),
      } as never);
      const elapsedMs = Date.now() - startedAt;
      assert.equal(response.statusCode, 200);
      assert.deepEqual(JSON.parse(response.body), { ok: true, route: 'maintenance' });
      assert.equal(attempts, 1);
      assert.equal(observedAbort, true);
      assert.ok(elapsedMs >= 50 && elapsedMs < 1_000, `unexpected abort time ${elapsedMs}ms`);
      assert.deepEqual(logs.map((line) => JSON.parse(line)), [{
        namespace: 'DataOps/ConversationalAgent',
        component: 'telegram',
        event: 'maintenance_reply_failed',
      }]);
      assert.doesNotMatch(logs.join('\n'), /test-bot-token-private|private input|synthetic/i);
    } finally {
      globalThis.fetch = originalFetch;
      console.log = originalLog;
      if (originalBotToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = originalBotToken;
      if (originalTimeout === undefined) delete process.env.TELEGRAM_API_TIMEOUT_MS;
      else process.env.TELEGRAM_API_TIMEOUT_MS = originalTimeout;
    }
  });

  it('never trusts a private chat whose sender does not match the recipient', async () => {
    let replies = 0;
    const response = await handleTelegramWebhook({
      headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
      body: JSON.stringify({
        update_id: 2,
        message: {
          message_id: 2,
          chat: { id: 12345, type: 'private' },
          from: { id: 42 },
          text: '/todo',
        },
      }),
    } as never, {
      async sendMaintenanceReply() {
        replies += 1;
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(response.body).route, 'maintenance');
    assert.equal(replies, 0);
  });

  it('keeps the directed-group response static while dark', async () => {
    const replies: string[] = [];
    const response = await handleTelegramWebhook({
      headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
      body: JSON.stringify({
        update_id: 3,
        message: {
          message_id: 3,
          chat: { id: -1001, type: 'group' },
          from: { id: 12345 },
          text: '/help@DataOpsBot',
        },
      }),
    } as never, {
      async sendMaintenanceReply(_chatId, text) {
        replies.push(text);
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(response.body).route, 'private-only');
    assert.deepEqual(replies, ['Please continue with the DataOps bot in a private chat.']);
  });

  it('rejects missing or wrong webhook authentication before maintenance behavior', async () => {
    for (const headers of [{}, { 'x-telegram-bot-api-secret-token': 'wrong' }]) {
      const response = await handleTelegramWebhook({
        headers,
        body: JSON.stringify({
          update_id: 4,
          message: {
            message_id: 4,
            chat: { id: 12345, type: 'private' },
            from: { id: 12345 },
            text: '/status',
          },
        }),
      } as never);
      assert.equal(response.statusCode, 401);
    }
  });

  it('rejects retired independent behavior flags instead of restoring legacy paths', async () => {
    process.env.CONVERSATIONAL_AGENT_ENABLED = 'true';
    try {
      await assert.rejects(
        handleTelegramWebhook({
          headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
          body: JSON.stringify({
            update_id: 5,
            message: {
              message_id: 5,
              chat: { id: 12345, type: 'private' },
              from: { id: 12345 },
              text: '/podcast create one',
            },
          }),
        } as never),
        /retired/
      );
    } finally {
      delete process.env.CONVERSATIONAL_AGENT_ENABLED;
    }
  });
});
