import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables, deleteTables } from '../src/db/setup';
import { parseMessage, handleTelegramWebhook } from '../src/routes/telegram';

describe('Telegram integration', () => {
  let port: number;

  before(async () => {
    port = await startLocal();
    process.env.IS_LOCAL = 'true';
    process.env.TELEGRAM_WEBHOOK_SECRET = 'test-secret';
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  after(async () => {
    await stopLocal();
    delete process.env.IS_LOCAL;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
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

    it('creates a task only when direct task compatibility mode is enabled', async () => {
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
        assert.ok(body.taskId);
        assert.strictEqual(body.intakeItemId, undefined);

        const { getTask } = await import('../src/db/tasks');
        const client = await getClient();
        const task = await getTask(client, body.taskId);
        assert.strictEqual(task!.description, 'Dentist appointment');
        assert.strictEqual(task!.date, '2026-04-15');
        assert.strictEqual(task!.source, 'telegram');
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
        assert.ok(replies[0].text.includes('DataOps operations intake'));
        assert.ok(replies[0].text.includes('capture raw operations intake'));
        assert.ok(!replies[0].text.includes('DataTasks Bot'));
      } finally {
        globalThis.fetch = originalFetch;
        delete process.env.TELEGRAM_BOT_TOKEN;
      }
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
