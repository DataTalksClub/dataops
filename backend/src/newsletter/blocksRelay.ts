/**
 * Relay newsletter-issue API client for block sync.
 *
 * Two fixed targets, each with its own runtime secret, so a synced issue can
 * only talk to the Relay it was linked to. Every call has a timeout and every
 * failure throws a RelayError naming the call; nothing is retried silently.
 * The API key is only ever sent as a header, never logged or returned.
 */
import { readRuntimeSecret } from '../secrets/reader';
import type { RelayBlock, RelayIssue, RelayTarget } from './blocks';

export const RELAY_TARGET_CONFIG: Record<RelayTarget, { url: string; secret: string; secretField?: string }> = {
  production: { url: 'https://relay.datatalks.club', secret: 'relay-production.dtc-newsletter-api-key' },
  // The dev secret's value is a JSON object of keys; the API key is RELAY_API_KEY.
  dev: { url: 'https://dev.relay.datatalks.club', secret: 'relay-dev.api-keys', secretField: 'RELAY_API_KEY' },
};

export const RELAY_TIMEOUT_MS = 15_000;
/** Relay sits behind CloudFront, whose WAF rejects bodies over ~8 KB with a bare 403. */
export const MAX_RELAY_BODY_BYTES = 7000;

export class RelayError extends Error {
  constructor(message: string, public readonly status = 502, public readonly code = 'relay_error') {
    super(message);
  }
}

export interface RelayDeps {
  fetchImpl: typeof fetch;
  readSecret: (name: string) => Promise<string>;
}

const deps: RelayDeps = { fetchImpl: (...args) => globalThis.fetch(...args), readSecret: readRuntimeSecret };

/** Tests swap the network and the secret store; returns a restore function. */
export function setRelayDepsForTests(next: Partial<RelayDeps>): () => void {
  const previous = { ...deps };
  Object.assign(deps, next);
  return () => Object.assign(deps, previous);
}

async function relayKey(target: RelayTarget): Promise<string> {
  const config = RELAY_TARGET_CONFIG[target];
  let raw: string;
  try {
    raw = await deps.readSecret(config.secret);
  } catch (error) {
    throw new RelayError(
      `Relay ${target} API key unavailable: DataOps secret ${config.secret} could not be read (${(error as Error).message}).`,
      503,
      'relay_credentials_missing',
    );
  }
  let key = raw.trim();
  if (config.secretField) {
    try {
      key = String((JSON.parse(raw) as Record<string, unknown>)[config.secretField] || '').trim();
    } catch {
      key = '';
    }
  }
  if (!key) {
    throw new RelayError(`DataOps secret ${config.secret} has no Relay API key.`, 503, 'relay_credentials_missing');
  }
  return key;
}

export interface RelayClient {
  target: RelayTarget;
  url: string;
  getIssue(issueKey: string): Promise<RelayIssue>;
  getBlock(issueKey: string, blockId: number): Promise<RelayBlock>;
  putBlock(issueKey: string, blockId: number, type: string, data: Record<string, string>): Promise<RelayBlock>;
}

export function relayBodyBytes(type: string, data: Record<string, string>): number {
  return Buffer.byteLength(JSON.stringify({ type, data }), 'utf8');
}

export async function relayClient(target: RelayTarget): Promise<RelayClient> {
  const config = RELAY_TARGET_CONFIG[target];
  if (!config) throw new RelayError(`Unknown Relay target ${target}.`, 400, 'relay_target_unknown');
  const key = await relayKey(target);

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const label = `Relay ${target} ${method} ${path}`;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload && Buffer.byteLength(payload, 'utf8') > MAX_RELAY_BODY_BYTES) {
      throw new RelayError(
        `${label}: body is ${Buffer.byteLength(payload, 'utf8')} bytes, over the ${MAX_RELAY_BODY_BYTES}-byte limit ` +
          "(Relay's CloudFront WAF rejects bodies over ~8 KB). Shorten the block.",
        422,
        'relay_body_too_large',
      );
    }
    let response: Response;
    try {
      response = await deps.fetchImpl(`${config.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${key}`,
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json' } : {}),
        },
        body: payload,
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
    } catch (error) {
      const name = (error as { name?: string })?.name;
      const reason = name === 'TimeoutError' || name === 'AbortError'
        ? `timed out after ${RELAY_TIMEOUT_MS / 1000}s`
        : (error as Error)?.message || 'network error';
      throw new RelayError(`${label} failed: ${reason}.`, 504, 'relay_unreachable');
    }
    const text = await response.text();
    if (!response.ok) {
      const hint = response.status === 403 && !text.trim().startsWith('{') ? ' (a bare 403 usually means the CloudFront WAF body limit)' : '';
      const status = response.status === 404 ? 404 : 502;
      throw new RelayError(`${label} returned HTTP ${response.status}: ${text.slice(0, 300)}${hint}`, status, 'relay_http_error');
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new RelayError(`${label} returned a non-JSON body.`, 502, 'relay_bad_response');
    }
  }

  const issuePath = (issueKey: string) => `/api/newsletter-issues/${encodeURIComponent(issueKey)}`;
  return {
    target,
    url: config.url,
    async getIssue(issueKey) {
      const { issue } = await call<{ issue: RelayIssue }>('GET', issuePath(issueKey));
      if (!issue || !Array.isArray(issue.blocks)) throw new RelayError(`Relay ${target} issue ${issueKey} has no blocks list.`);
      return issue;
    },
    async getBlock(issueKey, blockId) {
      return (await call<{ block: RelayBlock }>('GET', `${issuePath(issueKey)}/blocks/${blockId}`)).block;
    },
    async putBlock(issueKey, blockId, type, data) {
      return (await call<{ block: RelayBlock }>('PUT', `${issuePath(issueKey)}/blocks/${blockId}`, { type, data })).block;
    },
  };
}
