import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import type { LambdaEvent, LambdaResponse } from '../types';

const DEFAULT_ZAI_BASE_URL = 'https://api.z.ai/api/anthropic';
const DEFAULT_ZAI_MODEL = 'glm-5.2';
const SOCIAL_ASSISTANT_TYPE = 'social-draft';
const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

function anthropicMessagesUrl(baseUrl = DEFAULT_ZAI_BASE_URL): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
}

async function handleSocialDraftAssistantRoutes(
  event: LambdaEvent,
  _client: DynamoDBDocumentClient
): Promise<LambdaResponse | null> {
  if (!(event.path || '/').startsWith('/api/assistant-social-drafts')) return null;
  return {
    statusCode: 410,
    headers: JSON_HEADERS,
    body: JSON.stringify({
      error: 'This legacy social assistant is retired. Use the conversational Typefully approval flow.',
    }),
  };
}

export {
  DEFAULT_ZAI_BASE_URL,
  DEFAULT_ZAI_MODEL,
  SOCIAL_ASSISTANT_TYPE,
  anthropicMessagesUrl,
  handleSocialDraftAssistantRoutes,
};
