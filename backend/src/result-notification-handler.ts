import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from './db/client';
import {
  runResultDispatcher,
  type ResultTransport,
} from './conversation/resultDispatcher';
import { conversationalRolloutSnapshot } from './conversation/rollout';
import { emitConversationalMetric } from './conversation/observability';
import {
  oldestPendingResultAgeSeconds,
  writeRolloutHeartbeat,
} from './conversation/rolloutState';

let client: DynamoDBDocumentClient | null = null;
let secrets: SecretsManagerClient | null = null;
let cachedBotToken: string | null = null;

interface ResultNotificationHandlerOverrides {
  client?: DynamoDBDocumentClient;
  transport?: ResultTransport;
  now?: () => Date;
  runResultDispatcher?: typeof runResultDispatcher;
  oldestPendingResultAgeSeconds?: typeof oldestPendingResultAgeSeconds;
  writeRolloutHeartbeat?: typeof writeRolloutHeartbeat;
  emitConversationalMetric?: typeof emitConversationalMetric;
}

async function botToken(): Promise<string> {
  if (cachedBotToken) return cachedBotToken;
  const secretName = process.env.TELEGRAM_INTEGRATION_SECRET_NAME;
  if (!secretName) throw new Error('Telegram result delivery is not configured');
  secrets ||= new SecretsManagerClient({});
  const result = await secrets.send(new GetSecretValueCommand({ SecretId: secretName }));
  if (!result.SecretString) throw new Error('Telegram result delivery is not configured');
  const parsed = JSON.parse(result.SecretString) as Record<string, unknown>;
  const token = parsed.botToken || parsed.bot_token || parsed.TELEGRAM_BOT_TOKEN;
  if (typeof token !== 'string' || !token.trim() || token.length > 1_000) {
    throw new Error('Telegram result delivery is not configured');
  }
  cachedBotToken = token;
  return token;
}

class TelegramResultTransport implements ResultTransport {
  async sendPrivateMessage(channelConversationKey: string, message: string): Promise<void> {
    const destination = telegramMessageBody(channelConversationKey, '');
    const token = await botToken();
    const chunks: string[] = [];
    let chunk = '';
    for (const character of message) {
      if (Buffer.byteLength(chunk + character, 'utf8') > 3_900) {
        chunks.push(chunk);
        chunk = character;
      } else {
        chunk += character;
      }
    }
    if (chunk) chunks.push(chunk);
    for (const text of chunks) {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...destination,
          text,
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error('Telegram result delivery failed');
    }
  }
}

function telegramMessageBody(
  channelConversationKey: string,
  text: string
): { chat_id: string; text: string } {
  if (!/^[1-9]\d{0,19}$/.test(channelConversationKey)) {
    throw new Error('Invalid Telegram destination');
  }
  return { chat_id: channelConversationKey, text };
}

async function handleResultNotification(
  overrides: ResultNotificationHandlerOverrides = {}
): Promise<unknown> {
  const rollout = conversationalRolloutSnapshot();
  if (!rollout.eligibility.resultDelivery) {
    return { disabled: true };
  }
  const currentClient = overrides.client || (client ||= await getClient());
  const now = overrides.now || (() => new Date());
  const startedAt = now();
  const emitMetric = overrides.emitConversationalMetric || emitConversationalMetric;
  const result = await (overrides.runResultDispatcher || runResultDispatcher)({
    client: currentClient,
    transport: overrides.transport || new TelegramResultTransport(),
    now: () => startedAt,
    limit: Number(process.env.CONVERSATIONAL_RESULT_DISPATCH_LIMIT || 50),
    leaseSeconds: Number(process.env.CONVERSATIONAL_RESULT_DISPATCH_LEASE_SECONDS || 60),
  });
  if (result.delivered) {
    emitMetric('ResultDeliverySucceeded', result.delivered, 'result-dispatcher');
  }
  if (result.rejected) {
    emitMetric('ResultDeliveryFailed', result.rejected, 'result-dispatcher');
  }
  if (result.outcomeUnknown) {
    emitMetric(
      'ResultDeliveryOutcomeUnknown',
      result.outcomeUnknown,
      'result-dispatcher'
    );
  }
  const completedAt = now();
  const oldestPending = await (
    overrides.oldestPendingResultAgeSeconds || oldestPendingResultAgeSeconds
  )(currentClient, completedAt);
  emitMetric(
    'ResultDeliveryOldestPendingAgeSeconds',
    oldestPending ?? 0,
    'result-dispatcher'
  );
  await (overrides.writeRolloutHeartbeat || writeRolloutHeartbeat)(
    currentClient,
    'result_dispatcher',
    completedAt
  );
  emitMetric(
    'ResultDispatcherHeartbeatAgeSeconds',
    0,
    'result-dispatcher',
    completedAt.getTime()
  );
  return result;
}

async function handler(): Promise<unknown> {
  return handleResultNotification();
}

function resetResultNotificationHandlerForTests(): void {
  client = null;
  secrets = null;
  cachedBotToken = null;
}

export {
  TelegramResultTransport,
  handleResultNotification,
  handler,
  resetResultNotificationHandlerForTests,
  telegramMessageBody,
};
export type { ResultNotificationHandlerOverrides };
