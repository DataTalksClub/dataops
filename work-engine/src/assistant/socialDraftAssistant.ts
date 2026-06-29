import { createHash } from 'crypto';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { appendAssistantJobEvent, createAssistantJob, updateAssistantJob } from '../db/assistantJobs';
import { createArtifact } from '../db/artifacts';
import { styleExamplesFor, type SocialStyleExample } from './socialStyleExamples';
import type { ArtifactRecord, AssistantJobRecord, LambdaEvent, LambdaResponse } from '../types';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };
const DEFAULT_ZAI_BASE_URL = 'https://api.z.ai/api/anthropic';
const DEFAULT_ZAI_MODEL = 'glm-5.2';
const DEFAULT_ZAI_MAX_TOKENS = 4096;
const DEFAULT_TYPEFULLY_BASE_URL = 'https://api.typefully.com';
const SOCIAL_ASSISTANT_TYPE = 'social-draft';
const SECRET_KEY_PATTERN = /(secret|token|password|credential|cookie|authorization|signed[_-]?url|api[_-]?key)/i;
const SECRET_VALUE_PATTERN = /(x-amz-signature|x-amz-credential|x-amz-security-token|access_token=|token=|secret=|api[_-]?key|bearer\s+[a-z0-9._-]+|ghp_[a-z0-9_]+|sk-[a-z0-9_-]+|zai[_-]?api[_-]?key|private[_-]?url|typefully\.com\/\?d=|\.tmp\/typefully|typefully-export|all-drafts\.json)/i;

type AccountKey = 'alexey' | 'datatalksclub';
type Platform = 'x' | 'linkedin';

interface SocialAccountConfig {
  key: AccountKey;
  label: string;
  typefullySocialSetId?: number;
  aliases: string[];
}

interface TelegramMessageSource {
  messageId?: string;
  chatId?: string;
  chatTitle?: string;
  senderHandle?: string;
  text: string;
}

interface SocialDraftIntent {
  source: TelegramMessageSource;
  account: SocialAccountConfig;
  platforms: Platform[];
  requestedIntent: string;
  styleExamples: SocialStyleExample[];
}

interface GeneratedSocialDraft {
  draftTitle?: string;
  scratchpadText?: string;
  xPosts: string[];
  linkedinPosts: string[];
}

interface TypefullyDraftResult {
  id: string | number;
  status?: string;
  privateUrl?: string;
  shareUrl?: string | null;
  socialSetId: number;
  platforms: Platform[];
  preview?: string;
}

interface ZaiSocialDraftClient {
  generateDraft(intent: SocialDraftIntent): Promise<GeneratedSocialDraft>;
}

interface TypefullyDraftClient {
  createSavedDraft(input: {
    socialSetId: number;
    draft: GeneratedSocialDraft;
    platforms: Platform[];
  }): Promise<TypefullyDraftResult>;
}

interface SocialDraftClients {
  zai?: ZaiSocialDraftClient;
  typefully?: TypefullyDraftClient;
}

interface SocialDraftRunResult {
  job: AssistantJobRecord | null;
  artifact: ArtifactRecord | null;
  accountKey?: AccountKey;
  reviewStatus: 'created' | 'needs-account-clarification' | 'failed';
  typefullyCalled: boolean;
}

let testClients: SocialDraftClients | null = null;

function jsonResponse(statusCode: number, body: unknown): LambdaResponse {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  };
}

function parseBody(event: LambdaEvent): Record<string, unknown> | null {
  if (!event.body) return null;
  if (typeof event.body === 'object') return event.body as Record<string, unknown>;
  try {
    return JSON.parse(event.body);
  } catch {
    return null;
  }
}

function headerValue(headers: Record<string, string> | null | undefined, name: string): string {
  if (!headers) return '';
  const match = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match ? String(match[1]) : '';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function boundedString(value: unknown, maxLength: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function containsSecret(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return SECRET_VALUE_PATTERN.test(value);
  if (Array.isArray(value)) return value.some(containsSecret);
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([key, child]) => (
      SECRET_KEY_PATTERN.test(key) || containsSecret(child)
    ));
  }
  return false;
}

function sanitizeError(error: unknown): { code: string; summary: string } {
  const fallback = { code: 'social-draft-error', summary: 'Social draft assistant failed with redacted details' };
  if (error instanceof Error) {
    if (containsSecret(error.message)) return fallback;
    return { code: error.name || 'social-draft-error', summary: boundedString(error.message, 500) || fallback.summary };
  }
  if (typeof error === 'string') {
    if (containsSecret(error)) return fallback;
    return { code: 'social-draft-error', summary: boundedString(error, 500) || fallback.summary };
  }
  if (containsSecret(error)) return fallback;
  return fallback;
}

function stableHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function numberFromEnv(...names: string[]): number | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (!value) continue;
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function accountConfigs(): SocialAccountConfig[] {
  return [
    {
      key: 'alexey',
      label: 'Alexey / Al_Grigor',
      typefullySocialSetId: numberFromEnv('TYPEFULLY_SOCIAL_SET_ALEXEY', 'TYPEFULLY_ALEXEY_SOCIAL_SET_ID'),
      aliases: ['alexey', 'al_grigor', 'al grigor', 'agrigorev', 'alexey grigorev', 'personal', 'my account', 'my social'],
    },
    {
      key: 'datatalksclub',
      label: 'DataTalksClub',
      typefullySocialSetId: numberFromEnv('TYPEFULLY_SOCIAL_SET_DATATALKSCLUB', 'TYPEFULLY_DATATALKSCLUB_SOCIAL_SET_ID', 'TYPEFULLY_SOCIAL_SET_DTC'),
      aliases: ['datatalksclub', 'datatalks.club', 'data talks club', 'dtc', 'bdc', 'community account'],
    },
  ];
}

function extractTelegramSource(body: Record<string, unknown>): TelegramMessageSource | null {
  const explicitText = isNonEmptyString(body.text) ? body.text : undefined;
  const update = body.telegramUpdate && typeof body.telegramUpdate === 'object'
    ? body.telegramUpdate as Record<string, unknown>
    : body;
  const message = update.message && typeof update.message === 'object'
    ? update.message as Record<string, unknown>
    : undefined;
  const text = explicitText || (isNonEmptyString(message?.text) ? message.text : undefined);
  if (!text) return null;

  const chat = message?.chat && typeof message.chat === 'object' ? message.chat as Record<string, unknown> : {};
  const from = message?.from && typeof message.from === 'object' ? message.from as Record<string, unknown> : {};
  return {
    messageId: message?.message_id !== undefined ? String(message.message_id) : undefined,
    chatId: chat.id !== undefined ? String(chat.id) : undefined,
    chatTitle: isNonEmptyString(chat.title) ? chat.title : undefined,
    senderHandle: isNonEmptyString(from.username) ? from.username : undefined,
    text: boundedString(text, 4000),
  };
}

function selectAccount(text: string): { account?: SocialAccountConfig; ambiguous: boolean; matched: AccountKey[] } {
  const normalized = text.toLowerCase();
  const matched = accountConfigs().filter((account) => (
    account.aliases.some((alias) => normalized.includes(alias))
  ));
  const keys = Array.from(new Set(matched.map((account) => account.key)));
  if (keys.length !== 1) {
    return { ambiguous: true, matched: keys };
  }
  return { account: matched.find((account) => account.key === keys[0]), ambiguous: false, matched: keys };
}

function platformList(body: Record<string, unknown>): Platform[] {
  if (Array.isArray(body.platforms)) {
    const requested = body.platforms.filter((platform): platform is Platform => platform === 'x' || platform === 'linkedin');
    if (requested.length > 0) return Array.from(new Set(requested));
  }
  return ['x', 'linkedin'];
}

function inferIntent(text: string): string {
  const withoutCommand = text
    .replace(/^\/?(social|draft|post|typefully)\b[:\s-]*/i, '')
    .replace(/\b(for|from)\s+(alexey|al_grigor|al grigor|datatalksclub|dtc|bdc)\b/ig, '')
    .trim();
  return boundedString(withoutCommand || text, 1000);
}

function assembleSystemPrompt(account: SocialAccountConfig, examples: SocialStyleExample[]): string {
  const exampleText = examples.map((example) => [
    `Account: ${account.label}`,
    `Platform: ${example.platform}`,
    `Example: ${example.label}`,
    example.text,
  ].join('\n')).join('\n\n---\n\n');

  return [
    'You draft social posts for DataTalks.Club operations.',
    'Return concise, review-ready copy for X/Twitter and LinkedIn.',
    'Match the account style from the examples, but do not copy them.',
    'Never schedule or publish. The system will create a saved Typefully draft for human review.',
    'Return the result through the social_draft tool.',
    '',
    'Historical style examples:',
    exampleText,
  ].join('\n');
}

function anthropicMessagesUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/v1')) return `${trimmed}/messages`;
  return `${trimmed}/v1/messages`;
}

class FetchZaiSocialDraftClient implements ZaiSocialDraftClient {
  async generateDraft(intent: SocialDraftIntent): Promise<GeneratedSocialDraft> {
    const apiKey = process.env.ZAI_API_KEY;
    if (!apiKey) throw new Error('ZAI_API_KEY is not configured');

    const baseUrl = process.env.ZAI_BASE_URL || DEFAULT_ZAI_BASE_URL;
    const model = process.env.ZAI_MODEL || DEFAULT_ZAI_MODEL;
    const maxTokens = Number(process.env.ZAI_MAX_TOKENS || DEFAULT_ZAI_MAX_TOKENS);
    const response = await fetch(anthropicMessagesUrl(baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: assembleSystemPrompt(intent.account, intent.styleExamples),
        messages: [{
          role: 'user',
          content: [
            `Target account: ${intent.account.label}`,
            `Platforms: ${intent.platforms.join(', ')}`,
            `Telegram request: ${intent.source.text}`,
            `Intent: ${intent.requestedIntent}`,
          ].join('\n'),
        }],
        tools: [{
          name: 'social_draft',
          description: 'Review-ready social copy for Typefully saved draft creation.',
          input_schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              draftTitle: { type: 'string' },
              scratchpadText: { type: 'string' },
              xPosts: { type: 'array', items: { type: 'string' } },
              linkedinPosts: { type: 'array', items: { type: 'string' } },
            },
            required: ['xPosts', 'linkedinPosts'],
          },
        }],
        tool_choice: { type: 'tool', name: 'social_draft' },
      }),
    });

    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      const error = payload && typeof payload.error === 'object' ? payload.error as Record<string, unknown> : {};
      throw new Error(isNonEmptyString(error.message) ? error.message : `z.ai request failed with HTTP ${response.status}`);
    }

    return parseGeneratedDraft(payload);
  }
}

function parseGeneratedDraft(payload: Record<string, unknown> | null): GeneratedSocialDraft {
  const content = Array.isArray(payload?.content) ? payload?.content as Record<string, unknown>[] : [];
  const toolUse = content.find((block) => block.type === 'tool_use' && block.name === 'social_draft');
  if (toolUse && toolUse.input && typeof toolUse.input === 'object') {
    return normalizeGeneratedDraft(toolUse.input as Record<string, unknown>);
  }

  const textBlock = content.find((block) => block.type === 'text' && typeof block.text === 'string');
  if (textBlock && typeof textBlock.text === 'string') {
    const parsed = JSON.parse(textBlock.text) as Record<string, unknown>;
    return normalizeGeneratedDraft(parsed);
  }

  throw new Error('z.ai response did not include social_draft output');
}

function normalizeGeneratedDraft(value: Record<string, unknown>): GeneratedSocialDraft {
  const xPosts = Array.isArray(value.xPosts) ? value.xPosts.filter(isNonEmptyString).map((text) => boundedString(text, 4000)) : [];
  const linkedinPosts = Array.isArray(value.linkedinPosts) ? value.linkedinPosts.filter(isNonEmptyString).map((text) => boundedString(text, 8000)) : [];
  if (xPosts.length === 0 && linkedinPosts.length === 0) throw new Error('Generated draft is empty');
  return {
    draftTitle: isNonEmptyString(value.draftTitle) ? boundedString(value.draftTitle, 120) : undefined,
    scratchpadText: isNonEmptyString(value.scratchpadText) ? boundedString(value.scratchpadText, 1000) : undefined,
    xPosts,
    linkedinPosts,
  };
}

class FetchTypefullyDraftClient implements TypefullyDraftClient {
  async createSavedDraft(input: { socialSetId: number; draft: GeneratedSocialDraft; platforms: Platform[] }): Promise<TypefullyDraftResult> {
    const apiKey = process.env.TYPEFULLY_API_KEY;
    if (!apiKey) throw new Error('TYPEFULLY_API_KEY is not configured');

    const platformPayload: Record<string, unknown> = {};
    if (input.platforms.includes('x') && input.draft.xPosts.length > 0) {
      platformPayload.x = { enabled: true, posts: input.draft.xPosts.map((text) => ({ text })) };
    }
    if (input.platforms.includes('linkedin') && input.draft.linkedinPosts.length > 0) {
      platformPayload.linkedin = { enabled: true, posts: input.draft.linkedinPosts.map((text) => ({ text })) };
    }
    if (Object.keys(platformPayload).length === 0) throw new Error('No generated platform posts to send to Typefully');

    const response = await fetch(`${(process.env.TYPEFULLY_BASE_URL || DEFAULT_TYPEFULLY_BASE_URL).replace(/\/+$/, '')}/v2/social-sets/${input.socialSetId}/drafts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        draft_title: input.draft.draftTitle,
        scratchpad_text: input.draft.scratchpadText,
        share: false,
        platforms: platformPayload,
      }),
    });

    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      const error = payload && typeof payload.error === 'object' ? payload.error as Record<string, unknown> : {};
      throw new Error(isNonEmptyString(error.message) ? error.message : `Typefully request failed with HTTP ${response.status}`);
    }

    return {
      id: String(payload?.id || payload?.draft_id || ''),
      status: isNonEmptyString(payload?.status) ? payload.status : undefined,
      privateUrl: isNonEmptyString(payload?.private_url) ? payload.private_url : undefined,
      shareUrl: isNonEmptyString(payload?.share_url) ? payload.share_url : null,
      socialSetId: input.socialSetId,
      platforms: input.platforms,
      preview: isNonEmptyString(payload?.preview) ? payload.preview : undefined,
    };
  }
}

function socialDraftClients(): Required<SocialDraftClients> {
  return {
    zai: testClients?.zai || new FetchZaiSocialDraftClient(),
    typefully: testClients?.typefully || new FetchTypefullyDraftClient(),
  };
}

async function appendEvent(client: DynamoDBDocumentClient, jobId: string, action: string, summary: string, metadata?: Record<string, unknown>, actorId?: string): Promise<void> {
  await appendAssistantJobEvent(client, {
    assistantJobId: jobId,
    action,
    summary: boundedString(summary, 1000),
    actorId,
    metadata,
  });
}

async function createReviewArtifact(
  client: DynamoDBDocumentClient,
  job: AssistantJobRecord,
  input: {
    title: string;
    description: string;
    storageUri: string;
    status: 'needs-review' | 'approved';
    metadata: Record<string, unknown>;
    actorId?: string;
  }
): Promise<ArtifactRecord> {
  return createArtifact(client, {
    type: 'assistant-output',
    title: input.title,
    description: input.description,
    status: input.status,
    storageProvider: input.storageUri.startsWith('http') ? 'external-url' : 'local-dev',
    storageUri: input.storageUri,
    checksum: stableHash(input.metadata),
    dataClass: 'internal',
    visibility: 'internal',
    assistantJobId: job.id,
    sourceType: 'assistant-output',
    createdBy: input.actorId,
    metadata: input.metadata,
  });
}

async function runSocialDraftAssistant(
  client: DynamoDBDocumentClient,
  body: Record<string, unknown>,
  actorId?: string
): Promise<SocialDraftRunResult> {
  const source = extractTelegramSource(body);
  if (!source) throw new Error('Telegram message text is required');
  if (containsSecret(source.text)) throw new Error('Telegram message text must not contain tokens or credentials');

  const selected = selectAccount(source.text);
  const requestedIntent = inferIntent(source.text);
  const platforms = platformList(body);
  const title = `Social draft: ${boundedString(requestedIntent, 80) || 'Telegram request'}`;
  const job = await createAssistantJob(client, {
    assistantType: SOCIAL_ASSISTANT_TYPE,
    title,
    requestedBy: actorId,
    inputRefs: [{
      type: 'source-message',
      title: 'Mock Telegram social drafting request',
      id: source.messageId,
      metadata: {
        source: 'telegram',
        chatId: source.chatId,
        chatTitle: source.chatTitle,
        senderHandle: source.senderHandle,
        text: source.text,
      },
    }],
    approvalRequired: true,
    approval: { status: 'pending' },
    maxAttempts: 2,
  });
  await appendEvent(client, job.id, 'created', 'Social draft assistant job created from Telegram message', { source: 'telegram' }, actorId);

  if (selected.ambiguous || !selected.account) {
    const artifact = await createReviewArtifact(client, job, {
      title: 'Social draft account needs clarification',
      description: 'The Telegram message did not identify Alexey / Al_Grigor or DataTalksClub clearly enough for an external draft write.',
      status: 'needs-review',
      storageUri: `local-dev://assistant-jobs/${job.id}/social-draft-account-clarification.json`,
      actorId,
      metadata: {
        assistant_type: SOCIAL_ASSISTANT_TYPE,
        review_status: 'needs-account-clarification',
        source: 'telegram',
        requested_intent: requestedIntent,
        target_platforms: platforms,
        matched_accounts: selected.matched,
        typefully_called: false,
      },
    });
    const updated = await updateAssistantJob(client, job.id, {
      status: 'waiting_approval',
      outputArtifactIds: [artifact.id],
      completedAt: new Date().toISOString(),
    });
    await appendEvent(client, job.id, 'approval-requested', 'Social draft needs account clarification before Typefully write', { review_status: 'needs-account-clarification', typefully_called: false }, actorId);
    return { job: updated || job, artifact, reviewStatus: 'needs-account-clarification', typefullyCalled: false };
  }

  const account = selected.account;
  if (!account.typefullySocialSetId) {
    const sanitized = sanitizeError(`Typefully social set id is not configured for ${account.label}`);
    const failed = await updateAssistantJob(client, job.id, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      lastError: sanitized,
    });
    await appendEvent(client, job.id, 'failed', 'Social draft assistant failed before Typefully write', { account: account.key, typefully_called: false }, actorId);
    return { job: failed || job, artifact: null, accountKey: account.key, reviewStatus: 'failed', typefullyCalled: false };
  }

  await updateAssistantJob(client, job.id, {
    status: 'running',
    queuedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    attemptCount: 1,
  });
  await appendEvent(client, job.id, 'started', 'Social draft assistant started', { account: account.key, platforms }, actorId);

  const intent: SocialDraftIntent = {
    source,
    account,
    platforms,
    requestedIntent,
    styleExamples: styleExamplesFor(account.key),
  };
  const clients = socialDraftClients();
  let generated: GeneratedSocialDraft;
  let typefullyDraft: TypefullyDraftResult;
  try {
    generated = await clients.zai.generateDraft(intent);
    typefullyDraft = await clients.typefully.createSavedDraft({
      socialSetId: account.typefullySocialSetId,
      draft: generated,
      platforms,
    });
  } catch (error) {
    const sanitized = sanitizeError(error);
    const failed = await updateAssistantJob(client, job.id, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      lastError: sanitized,
    });
    await appendEvent(client, job.id, 'failed', 'Social draft assistant failed with redacted provider details', { account: account.key, typefully_called: false }, actorId);
    return { job: failed || job, artifact: null, accountKey: account.key, reviewStatus: 'failed', typefullyCalled: false };
  }

  const artifact = await createReviewArtifact(client, job, {
    title: `${account.label} Typefully draft`,
    description: 'Saved Typefully draft created from a Telegram social drafting request.',
    status: 'needs-review',
    storageUri: typefullyDraft.privateUrl || `local-dev://assistant-jobs/${job.id}/typefully-draft.json`,
    actorId,
    metadata: {
      assistant_type: SOCIAL_ASSISTANT_TYPE,
      review_status: 'created',
      source: 'telegram',
      target_account: account.key,
      target_account_label: account.label,
      target_social_set_id: account.typefullySocialSetId,
      target_platforms: platforms,
      requested_intent: requestedIntent,
      generated_platforms: {
        x: generated.xPosts.length,
        linkedin: generated.linkedinPosts.length,
      },
      style_examples: intent.styleExamples.map((example) => ({ platform: example.platform, label: example.label })),
      typefully: {
        draft_id: typefullyDraft.id,
        status: typefullyDraft.status,
        social_set_id: typefullyDraft.socialSetId,
        platforms: typefullyDraft.platforms,
        private_url: typefullyDraft.privateUrl,
        share_url: typefullyDraft.shareUrl,
        preview: typefullyDraft.preview,
      },
    },
  });

  const updated = await updateAssistantJob(client, job.id, {
    status: 'waiting_approval',
    outputArtifactIds: [artifact.id],
    completedAt: new Date().toISOString(),
    lastError: undefined,
  });
  await appendEvent(client, job.id, 'artifact-attached', 'Social Typefully draft artifact attached', { artifactIds: [artifact.id], account: account.key }, actorId);
  await appendEvent(client, job.id, 'approval-requested', 'Social Typefully draft is ready for review', { account: account.key, typefully_called: true }, actorId);

  return { job: updated || job, artifact, accountKey: account.key, reviewStatus: 'created', typefullyCalled: true };
}

async function handleSocialDraftAssistantRoutes(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse | null> {
  const method = event.httpMethod || 'GET';
  const reqPath = event.path || '/';
  if (!reqPath.startsWith('/api/assistant-social-drafts')) return null;
  if (method !== 'POST' || !/^\/api\/assistant-social-drafts\/mock-telegram\/?$/.test(reqPath)) {
    return jsonResponse(404, { error: 'Not found' });
  }

  const body = parseBody(event);
  if (!body) return jsonResponse(400, { error: 'Request body is required' });
  const actorId = headerValue(event.headers, 'x-user-id') || (isNonEmptyString(body.requestedBy) ? body.requestedBy : undefined);

  try {
    const result = await runSocialDraftAssistant(client, body, actorId);
    return jsonResponse(201, result);
  } catch (error) {
    const sanitized = sanitizeError(error);
    return jsonResponse(400, { error: sanitized.summary, code: sanitized.code });
  }
}

function setSocialDraftAssistantClients(clients: SocialDraftClients | null): void {
  testClients = clients;
}

export {
  DEFAULT_ZAI_BASE_URL,
  DEFAULT_ZAI_MODEL,
  SOCIAL_ASSISTANT_TYPE,
  FetchTypefullyDraftClient,
  FetchZaiSocialDraftClient,
  anthropicMessagesUrl,
  handleSocialDraftAssistantRoutes,
  runSocialDraftAssistant,
  selectAccount,
  setSocialDraftAssistantClients,
  type GeneratedSocialDraft,
  type SocialDraftIntent,
  type TypefullyDraftClient,
  type TypefullyDraftResult,
  type ZaiSocialDraftClient,
};
