import { createTask } from '../db/tasks';
import { getClient } from '../db/client';
import { createTables } from '../db/setup';
import type { LambdaEvent, LambdaResponse } from '../types';

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
  // Default to today
  const today = new Date().toISOString().slice(0, 10);
  return { description: text.trim(), date: today };
}

// Send a reply via Telegram API
async function sendTelegramReply(chatId: number, text: string, botToken: string | undefined): Promise<void> {
  if (!botToken) return; // Skip in tests
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
  } catch (err: unknown) {
    console.error('Failed to send Telegram reply:', err);
  }
}

async function handleTelegramWebhook(event: LambdaEvent): Promise<LambdaResponse> {
  // Verify webhook secret
  const headers = event.headers || {};
  const secret = headers['x-telegram-bot-api-secret-token'] || headers['X-Telegram-Bot-Api-Secret-Token'];
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (expectedSecret && secret !== expectedSecret) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const body = JSON.parse(event.body || '{}');
  const message = body.message;

  // Non-message updates: acknowledge silently
  if (!message || !message.text) {
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  const chatId = message.chat.id;
  const text: string = message.text;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  // /start command
  if (text === '/start') {
    await sendTelegramReply(chatId,
      'DataTasks Bot\n\nSend me a message to create a task.\nFormat: Task description [YYYY-MM-DD]\n\nExamples:\n- Buy groceries\n- Submit report 2026-03-15',
      botToken
    );
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  // Parse and create task
  const { description, date } = parseMessage(text);

  if (!description) {
    await sendTelegramReply(chatId, 'Please provide a task description.', botToken);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  const client = await getClient();
  await createTables(client);
  const task = await createTask(client, { description, date, source: 'telegram' });

  await sendTelegramReply(chatId, `Task created: "${task.description}" for ${task.date}`, botToken);

  return { statusCode: 200, body: JSON.stringify({ ok: true, taskId: task.id }) };
}

export { handleTelegramWebhook, parseMessage };
