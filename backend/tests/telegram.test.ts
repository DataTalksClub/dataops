import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables, deleteTables } from '../src/db/setup';
import { parseMessage, handleTelegramWebhook } from '../src/routes/telegram';
import { getAssistantJob } from '../src/db/assistantJobs';
import { getIntakeItem } from '../src/db/intake';
import { route } from '../src/router';
import { TODO_GUIDANCE } from '../src/conversation/todoPlugin';

describe('Telegram integration', () => {
  let port: number;

  before(async () => {
    port = await startLocal();
    process.env.IS_LOCAL = 'true';
    process.env.TELEGRAM_WEBHOOK_SECRET = 'test-secret';
    process.env.TELEGRAM_ALLOWED_CHAT_IDS = '12345';
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  after(async () => {
    await stopLocal();
    delete process.env.IS_LOCAL;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    delete process.env.TELEGRAM_ALLOWED_CHAT_IDS;
  });

  // ── parseMessage ─────────────────────────────────────────────────

  describe('parseMessage', () => {
    it('extracts description and date when date is at the end', () => {
      const result = parseMessage('Buy groceries 2026-03-10');
      assert.strictEqual(result.description, 'Buy groceries');
      assert.strictEqual(result.date, '2026-03-10');
    });

    it('uses today as default date when no date is provided', () => {
      const result = parseMessage('Buy groceries');
      assert.strictEqual(result.description, 'Buy groceries');
      const today = new Date().toISOString().slice(0, 10);
      assert.strictEqual(result.date, today);
    });

    it('handles message with only a date (no description before it)', () => {
      const result = parseMessage('2026-05-01');
      assert.strictEqual(result.description, '2026-05-01');
      const today = new Date().toISOString().slice(0, 10);
      assert.strictEqual(result.date, today);
    });

    it('handles message with trailing whitespace', () => {
      const result = parseMessage('  Submit report  ');
      assert.strictEqual(result.description, 'Submit report');
      const today = new Date().toISOString().slice(0, 10);
      assert.strictEqual(result.date, today);
    });

    it('handles multi-word description with date', () => {
      const result = parseMessage('Dentist appointment downtown 2026-04-15');
      assert.strictEqual(result.description, 'Dentist appointment downtown');
      assert.strictEqual(result.date, '2026-04-15');
    });
  });

  // ── handleTelegramWebhook ────────────────────────────────────────

  describe('handleTelegramWebhook', () => {
    it('creates an intake item from a plain message by default', async () => {
      const event = {
        headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
        body: JSON.stringify({
          message: {
            message_id: 1,
            chat: { id: 12345 },
            text: 'Buy groceries'
          }
        })
      };

      const res = await handleTelegramWebhook(event as any);
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.ok, true);
      assert.ok(body.intakeItemId);
      assert.strictEqual(body.taskId, undefined);

      const { getIntakeItem } = await import('../src/db/intake');
      const client = await getClient();
      const item = await getIntakeItem(client, body.intakeItemId);
      assert.strictEqual(item!.title, 'Buy groceries');
      assert.strictEqual(item!.source, 'telegram');
      assert.strictEqual(item!.status, 'new');
    });

    it('never restores the retired direct-task compatibility bypass', async () => {
      process.env.TELEGRAM_DIRECT_TASKS_COMPAT = 'true';
      try {
        const event = {
          headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
          body: JSON.stringify({
            message: {
              message_id: 2,
              chat: { id: 12345 },
              text: 'Dentist appointment 2026-04-15'
            }
          })
        };

        const res = await handleTelegramWebhook(event as any);
        assert.strictEqual(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.strictEqual(body.taskId, undefined);
        assert.ok(body.intakeItemId);

        const { listTasksByDate } = await import('../src/db/tasks');
        const client = await getClient();
        assert.deepStrictEqual(await listTasksByDate(client, '2026-04-15'), []);
      } finally {
        delete process.env.TELEGRAM_DIRECT_TASKS_COMPAT;
      }
    });

    it('/start command returns DataOps intake instructions and does not create a task', async () => {
      const originalFetch = globalThis.fetch;
      const replies: Array<{ chat_id: number; text: string }> = [];
      process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token';
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        replies.push(JSON.parse(String(init?.body || '{}')));
        return new Response('{}', { status: 200 });
      }) as typeof fetch;

      try {
        const event = {
          headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
          body: JSON.stringify({
            message: {
              message_id: 3,
              chat: { id: 12345 },
              text: '/start'
            }
          })
        };

        const res = await handleTelegramWebhook(event as any);
        assert.strictEqual(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.strictEqual(body.ok, true);
        assert.strictEqual(body.taskId, undefined);
        assert.strictEqual(replies.length, 1);
        assert.strictEqual(replies[0].chat_id, 12345);
        assert.ok(replies[0].text.includes('DataOps Telegram'));
        assert.ok(replies[0].text.includes('/podcast'));
        assert.ok(replies[0].text.includes('/social'));
        assert.ok(!replies[0].text.includes('DataTasks Bot'));
      } finally {
        globalThis.fetch = originalFetch;
        delete process.env.TELEGRAM_BOT_TOKEN;
      }
    });

    it('returns static /todo guidance with every supported command variant while default-off', async () => {
      const environmentKeys = [
        'CONVERSATIONAL_TELEGRAM_ENABLED',
        'CONVERSATIONAL_TODO_PLUGIN_ENABLED',
        'CONVERSATIONAL_TODO_EXECUTOR_ENABLED',
        'CONVERSATIONAL_RESULT_DELIVERY_ENABLED',
      ] as const;
      const previous = Object.fromEntries(
        environmentKeys.map((key) => [key, process.env[key]])
      );
      const variants = [
        '/todo',
        '/todo buy milk tomorrow',
        '  /ToDo  ',
        '\n/TODO   buy milk tomorrow\t',
        '/todo@DataOpsBot',
        '/ToDo@dataops_bot   buy milk tomorrow',
      ];
      let databaseClientCalls = 0;
      let coreCalls = 0;
      const replies: Array<{ chatId: string; text: string; botToken?: string }> = [];
      try {
        for (const flagState of ['unset', 'false'] as const) {
          for (const key of environmentKeys) {
            if (flagState === 'unset') delete process.env[key];
            else process.env[key] = 'false';
          }
          for (const [index, text] of variants.entries()) {
            const res = await handleTelegramWebhook({
              headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
              body: JSON.stringify({
                message: {
                  message_id: 600 + index,
                  chat: { id: 12345 },
                  from: { id: 42 },
                  text,
                },
              }),
            } as any, {
              core: {
                async handle() {
                  coreCalls += 1;
                  assert.fail('conversational core must not run for legacy /todo');
                },
              },
              legacy: {
                async getClient() {
                  databaseClientCalls += 1;
                  assert.fail('database client must not be acquired for /todo guidance');
                },
                async sendReply(chatId, replyText, botToken) {
                  replies.push({ chatId, text: replyText, botToken });
                },
              },
            });
            assert.strictEqual(res.statusCode, 200);
            assert.deepStrictEqual(JSON.parse(res.body), {
              ok: true,
              route: 'todo-guidance',
            });
          }
        }
      } finally {
        for (const key of environmentKeys) {
          const value = previous[key];
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      assert.strictEqual(databaseClientCalls, 0);
      assert.strictEqual(coreCalls, 0);
      assert.strictEqual(replies.length, variants.length * 2);
      assert.ok(Buffer.byteLength(TODO_GUIDANCE, 'utf8') <= 300);
      assert.ok(replies.every((reply) => (
        reply.chatId === '12345'
        && reply.text === TODO_GUIDANCE
        && reply.botToken === undefined
      )));
      assert.ok(replies.every((reply) => (
        !/intake captured|todo created|approved and queued/i.test(reply.text)
      )));
    });

    it('returns 401 when secret token is missing', async () => {
      const event = {
        headers: {},
        body: JSON.stringify({
          message: {
            message_id: 4,
            chat: { id: 12345 },
            text: 'Should not create'
          }
        })
      };

      const res = await handleTelegramWebhook(event as any);
      assert.strictEqual(res.statusCode, 401);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Unauthorized');
    });

    it('returns 401 when secret token is wrong', async () => {
      const event = {
        headers: { 'x-telegram-bot-api-secret-token': 'wrong-secret' },
        body: JSON.stringify({
          message: {
            message_id: 5,
            chat: { id: 12345 },
            text: 'Should not create'
          }
        })
      };

      const res = await handleTelegramWebhook(event as any);
      assert.strictEqual(res.statusCode, 401);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Unauthorized');
    });

    it('fails closed when the webhook secret is not configured', async () => {
      delete process.env.TELEGRAM_WEBHOOK_SECRET;
      try {
        const res = await handleTelegramWebhook({
          headers: {},
          body: JSON.stringify({ message: { message_id: 50, chat: { id: 12345 }, text: 'test' } })
        } as any);
        assert.strictEqual(res.statusCode, 503);
      } finally {
        process.env.TELEGRAM_WEBHOOK_SECRET = 'test-secret';
      }
    });

    it('fails closed when the shared chat allowlist is not configured', async () => {
      delete process.env.TELEGRAM_ALLOWED_CHAT_IDS;
      try {
        const res = await handleTelegramWebhook({
          headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
          body: JSON.stringify({ message: { message_id: 56, chat: { id: 12345 }, text: 'test' } })
        } as any);
        assert.strictEqual(res.statusCode, 503);
        assert.strictEqual(JSON.parse(res.body).error, 'Telegram chat allowlist is not configured');
      } finally {
        process.env.TELEGRAM_ALLOWED_CHAT_IDS = '12345';
      }
    });

    it('rejects a chat outside the shared allowlist', async () => {
      const res = await handleTelegramWebhook({
        headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
        body: JSON.stringify({ message: { message_id: 51, chat: { id: 99999 }, text: 'test' } })
      } as any);
      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(JSON.parse(res.body).error, 'Chat is not allowed');
    });

    it('accepts the Telegram-signed webhook without interactive portal authentication', async () => {
      const previousSkipAuth = process.env.SKIP_AUTH;
      const previousDocsDomain = process.env.DATAOPS_DOCS_DOMAIN;
      delete process.env.SKIP_AUTH;
      process.env.DATAOPS_DOCS_DOMAIN = '1';
      try {
        const client = await getClient();
        const res = await route({
          httpMethod: 'POST',
          path: '/api/webhook/telegram',
          headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
          body: JSON.stringify({ message: { message_id: 55, chat: { id: 12345 }, text: '/status' } })
        } as any, client);
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(JSON.parse(res.body).route, 'status');
      } finally {
        if (previousSkipAuth === undefined) delete process.env.SKIP_AUTH;
        else process.env.SKIP_AUTH = previousSkipAuth;
        if (previousDocsDomain === undefined) delete process.env.DATAOPS_DOCS_DOMAIN;
        else process.env.DATAOPS_DOCS_DOMAIN = previousDocsDomain;
      }
    });

    it('routes /podcast through the shared bot into a podcast assistant job', async () => {
      const res = await handleTelegramWebhook({
        headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
        body: JSON.stringify({
          message: {
            message_id: 52,
            chat: { id: 12345 },
            from: { id: 42, username: 'operator' },
            text: '/podcast Prepare questions for the next guest'
          }
        })
      } as any);
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.route, 'podcast');
      const client = await getClient();
      const item = await getIntakeItem(client, body.intakeItemId);
      assert.strictEqual(item!.assistantReadiness?.assistantType, 'podcast');
      assert.strictEqual(item!.assistantJobIds.length, 1);
      const job = await getAssistantJob(client, item!.assistantJobIds[0]);
      assert.strictEqual(job!.assistantType, 'podcast');
      assert.strictEqual(job!.requestedBy, 'telegram:42');
      assert.strictEqual(job!.status, 'draft');
    });

    it('keeps /social static and cannot reach a model or provider write', async () => {
      const res = await handleTelegramWebhook({
        headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
        body: JSON.stringify({
          message: {
            message_id: 54,
            chat: { id: 12345 },
            from: { id: 42, username: 'operator' },
            text: '/social Alexey post about the next workshop'
          }
        })
      } as any);
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.route, 'social-draft');
      const client = await getClient();
      const item = await getIntakeItem(client, body.intakeItemId);
      assert.strictEqual(item!.assistantReadiness, undefined);
      assert.deepStrictEqual(item!.assistantJobIds, []);
    });

    it('captures Telegram attachments through the same intake route', async () => {
      const res = await handleTelegramWebhook({
        headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
        body: JSON.stringify({
          message: {
            message_id: 53,
            chat: { id: 12345 },
            caption: 'Podcast guest brief',
            document: { file_id: 'telegram-file-id', file_name: 'brief.pdf' }
          }
        })
      } as any);
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      const client = await getClient();
      const item = await getIntakeItem(client, body.intakeItemId);
      assert.deepStrictEqual(item!.receivedChannels, ['telegram', 'document']);
      assert.strictEqual(item!.metadata?.hasAttachments, true);
    });

    it('returns 200 ok for non-message updates', async () => {
      const event = {
        headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
        body: JSON.stringify({
          edited_message: {
            message_id: 6,
            chat: { id: 12345 },
            text: 'Edited text'
          }
        })
      };

      const res = await handleTelegramWebhook(event as any);
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.taskId, undefined);
    });

    it('handles message with only a date gracefully', async () => {
      const event = {
        headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
        body: JSON.stringify({
          message: {
            message_id: 7,
            chat: { id: 12345 },
            text: '2026-05-01'
          }
        })
      };

      const res = await handleTelegramWebhook(event as any);
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.intakeItemId);

      const { getIntakeItem } = await import('../src/db/intake');
      const client = await getClient();
      const item = await getIntakeItem(client, body.intakeItemId);
      assert.strictEqual(item!.title, '2026-05-01');
      assert.strictEqual(item!.source, 'telegram');
    });
  });
});
