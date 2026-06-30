// Typefully API client for creating saved drafts only.
//
// Design invariants (issue #77):
//  - This client only ever creates saved drafts. It MUST NEVER send publish_at.
//  - publish_at is the only Typefully field that publishes, schedules, or
//    queues to the next free slot. Omitting it keeps a draft saved and under
//    human control.
//  - Any request input that carries publish_at is rejected at the builder
//    layer, before any network call, so publishing control cannot be bypassed.
//  - No API token, bearer header, or credential value may appear in returned
//    artifacts, errors, logs, or proof records. Errors are redacted to
//    operator-readable codes/summaries only.
//
// Required environment variables:
//  - TYPEFULLY_API_KEY: bearer token for the Typefully API (local dev / SAM).
//    In deployed runtime this is read from an AWS Secrets Manager secret whose
//    name is passed via TYPEFULLY_API_KEY_SECRET_NAME (see template.full.yaml).
//  - TYPEFULLY_BASE_URL (optional): defaults to https://api.typefully.com.
//  - TYPEFULLY_SOCIAL_SET_<ACCOUNT>: numeric social set id per target account.
//    For the social draft assistant: TYPEFULLY_SOCIAL_SET_ALEXEY and
//    TYPEFULLY_SOCIAL_SET_DATATALKSCLUB. Direct draft creation callers pass an
//    explicit socialSetId.
import type { GeneratedSocialDraft } from './socialDraftAssistant';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const DEFAULT_TYPEFULLY_BASE_URL = 'https://api.typefully.com';

export type TypefullyPlatform = 'x' | 'linkedin';

export interface TypefullyDraftResult {
  id: string | number;
  status?: string;
  privateUrl?: string;
  shareUrl?: string | null;
  socialSetId: number;
  platforms: TypefullyPlatform[];
  preview?: string;
  draftTitle?: string;
}

export interface TypefullyClientError {
  code: TypefullyErrorCode;
  summary: string;
  status?: number;
  retryable: boolean;
}

export type TypefullyErrorCode =
  | 'missing-credentials'
  | 'missing-social-set'
  | 'publish-at-rejected'
  | 'empty-platform-content'
  | 'unauthorized'
  | 'forbidden'
  | 'unprocessable'
  | 'rate-limited'
  | 'network-error'
  | 'typefully-error';

export interface TypefullySavedDraftInput {
  socialSetId: number;
  draft: GeneratedSocialDraft;
  platforms: TypefullyPlatform[];
}

export interface TypefullyCreateDraftRequest {
  draft_title?: string;
  scratchpad_text?: string;
  share: false;
  platforms: Record<string, { enabled: true; posts: Array<{ text: string }> }>;
}

export interface TypefullyDraftClient {
  createSavedDraft(input: TypefullySavedDraftInput): Promise<TypefullyDraftResult>;
}

export class TypefullyRequestError extends Error {
  readonly code: TypefullyErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  constructor(error: TypefullyClientError) {
    super(error.summary);
    this.name = 'TypefullyRequestError';
    this.code = error.code;
    this.status = error.status;
    this.retryable = error.retryable;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function boundedString(value: unknown, maxLength: number): string {
  const text = typeof value === 'string' ? value : '';
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

const SECRET_KEY_PATTERN = /(secret|token|password|credential|cookie|authorization|signed[_-]?url|api[_-]?key)/i;
const SECRET_VALUE_PATTERN = /(x-amz-signature|x-amz-credential|x-amz-security-token|access_token=|token=|secret=|api[_-]?key|bearer\s+[a-z0-9._-]+|ghp_[a-z0-9_]+|sk-[a-z0-9_-]+|typefully\.com\/\?d=|\.tmp\/typefully|typefully-export|all-drafts\.json)/i;

export function containsSecret(value: unknown): boolean {
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

// Detect any attempt to publish or schedule. Rejects the literal strings
// Typefully uses to trigger publishing/scheduling ("now", "next-free-slot")
// as well as any ISO 8601 datetime value, whether passed as publish_at or
// under a nested key. Callers run this before any network call.
export function isPublishAtAttempt(value: unknown, path = ''): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') {
    if (path.toLowerCase() === 'publish_at') {
      const lower = value.trim().toLowerCase();
      if (lower === 'now' || lower === 'next-free-slot') return true;
      if (!Number.isNaN(Date.parse(value)) && /\d{4}-\d{2}-\d{2}/.test(value)) return true;
    }
    return false;
  }
  if (Array.isArray(value)) return value.some((item) => isPublishAtAttempt(item, path));
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([key, child]) => (
      isPublishAtAttempt(child, key)
    ));
  }
  return false;
}

// Build the Typefully create-draft request body. Single chokepoint that
// guarantees no publish_at is emitted and platform content is non-empty.
export function buildCreateDraftRequest(
  draft: GeneratedSocialDraft,
  platforms: TypefullyPlatform[]
): TypefullyCreateDraftRequest {
  if (isPublishAtAttempt(draft)) {
    throw new TypefullyRequestError({
      code: 'publish-at-rejected',
      summary: 'publish_at is not allowed: Typefully integration creates saved drafts only',
      retryable: false,
    });
  }

  const platformPayload: TypefullyCreateDraftRequest['platforms'] = {};
  if (platforms.includes('x') && draft.xPosts.length > 0) {
    platformPayload.x = { enabled: true, posts: draft.xPosts.map((text) => ({ text: boundedString(text, 4000) })) };
  }
  if (platforms.includes('linkedin') && draft.linkedinPosts.length > 0) {
    platformPayload.linkedin = { enabled: true, posts: draft.linkedinPosts.map((text) => ({ text: boundedString(text, 8000) })) };
  }
  if (Object.keys(platformPayload).length === 0) {
    throw new TypefullyRequestError({
      code: 'empty-platform-content',
      summary: 'No platform posts available to send to Typefully',
      retryable: false,
    });
  }

  const request: TypefullyCreateDraftRequest = {
    share: false,
    platforms: platformPayload,
  };
  if (isNonEmptyString(draft.draftTitle)) request.draft_title = boundedString(draft.draftTitle, 120);
  if (isNonEmptyString(draft.scratchpadText)) request.scratchpad_text = boundedString(draft.scratchpadText, 1000);
  return request;
}

function typefullyBaseUrl(): string {
  return (process.env.TYPEFULLY_BASE_URL || DEFAULT_TYPEFULLY_BASE_URL).replace(/\/+$/, '');
}

function classifyHttpError(status: number, rawMessage: string): TypefullyClientError {
  if (containsSecret(rawMessage)) {
    return {
      code: 'typefully-error',
      status,
      summary: 'Typefully request failed with redacted sensitive details',
      retryable: false,
    };
  }
  switch (status) {
    case 401:
      return { code: 'unauthorized', status, summary: 'Typefully rejected the API token (401)', retryable: false };
    case 403:
      return { code: 'forbidden', status, summary: 'Typefully denied access to this social set (403)', retryable: false };
    case 422:
      return { code: 'unprocessable', status, summary: boundedString(rawMessage, 300) || 'Typefully rejected the draft payload (422)', retryable: false };
    case 429:
      return { code: 'rate-limited', status, summary: 'Typefully rate limit reached (429); retry later', retryable: true };
    default:
      return { code: 'typefully-error', status, summary: boundedString(rawMessage, 300) || `Typefully request failed with HTTP ${status}`, retryable: status >= 500 };
  }
}

// Cached Typefully token. Local dev sets TYPEFULLY_API_KEY directly. Deployed
// runtime sets TYPEFULLY_API_KEY_SECRET_NAME to a Secrets Manager secret name
// (provisioned by template.full.yaml) and the token is fetched once per cold
// start. The resolved value is never logged or persisted.
let cachedTypefullyToken: string | null | undefined;
let secretsClient: SecretsManagerClient | null = null;

async function resolveTypefullyApiKey(): Promise<string | null> {
  if (process.env.TYPEFULLY_API_KEY) return process.env.TYPEFULLY_API_KEY;
  if (cachedTypefullyToken !== undefined) return cachedTypefullyToken;

  const secretName = process.env.TYPEFULLY_API_KEY_SECRET_NAME;
  if (!secretName) {
    cachedTypefullyToken = null;
    return null;
  }

  try {
    secretsClient ||= new SecretsManagerClient({});
    const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
    cachedTypefullyToken = result.SecretString || (result.SecretBinary ? Buffer.from(result.SecretBinary).toString('utf-8') : '') || null;
  } catch {
    // Never leak the Secrets Manager error; surface a redacted missing-credentials
    // error to the caller. The token stays null so the job fails cleanly.
    cachedTypefullyToken = null;
  }
  return cachedTypefullyToken;
}

// Test hook: reset the cached token between tests.
function resetTypefullyCredentialCache(): void {
  cachedTypefullyToken = undefined;
  secretsClient = null;
}

// Production fetch-backed Typefully client. Reads the bearer token from
// TYPEFULLY_API_KEY (local) or TYPEFULLY_API_KEY_SECRET_NAME (deployed).
// Never sends publish_at. Redacts all error output.
export class FetchTypefullyDraftClient implements TypefullyDraftClient {
 async createSavedDraft(input: TypefullySavedDraftInput): Promise<TypefullyDraftResult> {
    if (!input.socialSetId || !Number.isInteger(input.socialSetId) || input.socialSetId <= 0) {
      throw new TypefullyRequestError({ code: 'missing-social-set', summary: 'A valid Typefully social set id is required', retryable: false });
    }
    const apiKey = await resolveTypefullyApiKey();
    if (!apiKey) {
      throw new TypefullyRequestError({ code: 'missing-credentials', summary: 'Typefully API credentials are not configured', retryable: false });
    }

    const requestBody = buildCreateDraftRequest(input.draft, input.platforms);
    const url = `${typefullyBaseUrl()}/v2/social-sets/${input.socialSetId}/drafts`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'network error';
      throw new TypefullyRequestError({
        code: 'network-error',
        summary: containsSecret(message) ? 'Typefully request failed with a redacted network error' : 'Could not reach Typefully',
        retryable: true,
      });
    }

    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      const error = payload && typeof payload.error === 'object' ? payload.error as Record<string, unknown> : {};
      const rawMessage = isNonEmptyString(error.message) ? error.message : isNonEmptyString(payload?.message) ? payload.message : '';
      throw new TypefullyRequestError(classifyHttpError(response.status, rawMessage));
    }

    const rawId = payload?.id !== undefined ? payload.id : payload?.draft_id;
    return {
      id: rawId !== undefined && rawId !== null ? String(rawId) : '',
      status: isNonEmptyString(payload?.status) ? payload.status : undefined,
      privateUrl: isNonEmptyString(payload?.private_url) ? payload.private_url : undefined,
      shareUrl: isNonEmptyString(payload?.share_url) ? payload.share_url : null,
      socialSetId: input.socialSetId,
      platforms: input.platforms,
      preview: isNonEmptyString(payload?.preview) ? payload.preview : undefined,
      draftTitle: isNonEmptyString(payload?.draft_title) ? payload.draft_title : undefined,
    };
  }
}

// In-process fake Typefully client for local/test verification with no real
// token and no external write. Records calls and returns configurable results
// so tests can assert the no-publish_at invariant and proof creation.
export class FakeTypefullyDraftClient implements TypefullyDraftClient {
  private calls: TypefullySavedDraftInput[] = [];
  private result: TypefullyDraftResult;
  private error: TypefullyClientError | null = null;
  private resultSequence: TypefullyDraftResult[] = [];
  private seqIndex = 0;

  constructor(options: { result?: TypefullyDraftResult; results?: TypefullyDraftResult[]; error?: TypefullyClientError } = {}) {
    this.result = options.result || {
      id: 'fake-typefully-draft',
      status: 'draft',
      privateUrl: 'https://typefully.example/draft/fake',
      shareUrl: null,
      socialSetId: 0,
      platforms: ['x', 'linkedin'],
      preview: 'fake preview',
    };
    if (options.results) this.resultSequence = options.results;
    if (options.error) this.error = options.error;
  }

  async createSavedDraft(input: TypefullySavedDraftInput): Promise<TypefullyDraftResult> {
    if (isPublishAtAttempt(input)) {
      throw new TypefullyRequestError({
        code: 'publish-at-rejected',
        summary: 'publish_at is not allowed: Typefully integration creates saved drafts only',
        retryable: false,
      });
    }
    this.calls.push(input);
    if (this.error) throw new TypefullyRequestError(this.error);
    if (this.resultSequence.length > 0) {
      const item = this.resultSequence[this.seqIndex] || this.resultSequence[this.resultSequence.length - 1];
      this.seqIndex += 1;
      return { ...item, socialSetId: input.socialSetId, platforms: input.platforms };
    }
    return { ...this.result, socialSetId: input.socialSetId, platforms: input.platforms };
  }

  recordedCalls(): readonly TypefullySavedDraftInput[] {
    return this.calls;
  }

  callCount(): number {
    return this.calls.length;
  }
}

export { DEFAULT_TYPEFULLY_BASE_URL, resetTypefullyCredentialCache };
