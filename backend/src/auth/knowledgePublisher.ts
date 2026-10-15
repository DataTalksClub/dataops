/**
 * The knowledge repository's GitHub Actions publisher, authenticated by the
 * workflow's own GitHub OIDC token. Nothing is stored: GitHub signs a
 * short-lived token per job, and this verifies it against GitHub's published
 * keys and the configured repository, branch and workflow file.
 *
 * The principal is not an interactive user. It may read the knowledge
 * manifest and publish knowledge files, nothing else, and its publication
 * actor and message name the verified commit rather than anything the
 * request body claims.
 */
import { createPublicKey, verify as verifySignature, type JsonWebKey } from 'node:crypto';

import { handleDocsRoutes } from '../docs/contentApi';
import type { LambdaEvent, LambdaResponse } from '../types';

export const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
export const KNOWLEDGE_PUBLISHER_AUDIENCE = 'dataops-knowledge-publish';
/** The workflow file in the knowledge repository allowed to publish. */
export const KNOWLEDGE_PUBLISHER_WORKFLOW = '.github/workflows/validate.yml';
const JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
const ALLOWED_EVENTS = new Set(['push', 'workflow_dispatch']);
const CLOCK_SKEW_SECONDS = 60;

type Jwk = JsonWebKey & { kid?: string; alg?: string; use?: string };
export interface GitHubOidcClaims {
  iss: string; aud: string | string[]; exp: number; nbf?: number; iat?: number;
  repository: string; ref: string; sha: string; workflow_ref: string; event_name: string;
}

let jwksCache: { expiresAt: number; keys: Jwk[] } | null = null;

const response = (statusCode: number, body: unknown): LambdaResponse => ({
  statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

function bearer(event: LambdaEvent): string {
  const header = Object.entries(event.headers || {}).find(([key]) => key.toLowerCase() === 'authorization')?.[1] || '';
  return /^Bearer\s+(\S+)$/i.exec(header)?.[1] || '';
}

function decodePart<T>(part: string): T | null {
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T; } catch { return null; }
}

/** True when the bearer token claims to be a GitHub Actions OIDC token (unverified). */
export function isGitHubOidcToken(token: string): boolean {
  const parts = token.split('.');
  return parts.length === 3 && decodePart<{ iss?: unknown }>(parts[1])?.iss === GITHUB_OIDC_ISSUER;
}

async function fetchJwks(force: boolean): Promise<Jwk[]> {
  const now = Date.now();
  if (!force && jwksCache && jwksCache.expiresAt > now) return jwksCache.keys;
  const res = await fetch(JWKS_URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error('GitHub OIDC JWKS request failed');
  const body = await res.json() as { keys?: Jwk[] };
  if (!Array.isArray(body.keys) || body.keys.length === 0) throw new Error('GitHub OIDC JWKS response invalid');
  jwksCache = { keys: body.keys, expiresAt: now + 300_000 };
  return body.keys;
}

async function signingKey(kid: string): Promise<Jwk | undefined> {
  const pick = (keys: Jwk[]) => keys.find((key) => key.kid === kid && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig'));
  return pick(await fetchJwks(false)) || pick(await fetchJwks(true));
}

/** The publisher policy from deployment configuration; disabled when unset. */
export function publisherPolicy(): { repository: string; ref: string; workflowRef: string } | null {
  const repository = process.env.KNOWLEDGE_PUBLISHER_REPOSITORY || '';
  const branch = process.env.KNOWLEDGE_PUBLISHER_BRANCH || 'main';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return null;
  const ref = `refs/heads/${branch}`;
  return { repository, ref, workflowRef: `${repository}/${KNOWLEDGE_PUBLISHER_WORKFLOW}@${ref}` };
}

/** Verify signature, issuer, audience, lifetime and the repository/branch/workflow binding. */
export async function verifyPublisherToken(token: string, now = Date.now()): Promise<GitHubOidcClaims> {
  const policy = publisherPolicy();
  if (!policy) throw new Error('Knowledge publisher is not configured');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token');
  const header = decodePart<{ alg?: string; kid?: string }>(parts[0]);
  const claims = decodePart<GitHubOidcClaims>(parts[1]);
  if (!header || !claims || header.alg !== 'RS256' || !header.kid) throw new Error('Invalid token');
  const key = await signingKey(header.kid);
  if (!key) throw new Error('Signing key not found');
  const signed = verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  if (!signed) throw new Error('Invalid token signature');
  const seconds = Math.floor(now / 1000);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== GITHUB_OIDC_ISSUER || !audience.includes(KNOWLEDGE_PUBLISHER_AUDIENCE)) throw new Error('Invalid token claims');
  if (typeof claims.exp !== 'number' || claims.exp <= seconds - CLOCK_SKEW_SECONDS) throw new Error('Expired token');
  if (claims.nbf !== undefined && claims.nbf > seconds + CLOCK_SKEW_SECONDS) throw new Error('Token not yet valid');
  if (claims.repository !== policy.repository || claims.ref !== policy.ref || claims.workflow_ref !== policy.workflowRef) {
    throw new Error('Token is not from the knowledge publish workflow');
  }
  if (!ALLOWED_EVENTS.has(claims.event_name) || !/^[0-9a-f]{40}$/.test(claims.sha)) throw new Error('Invalid token claims');
  return claims;
}

/**
 * Handle a request carrying a GitHub Actions OIDC bearer token, or return
 * null so every other credential continues through the normal middleware.
 */
export async function handleKnowledgePublisher(event: LambdaEvent): Promise<LambdaResponse | null> {
  const token = bearer(event);
  if (!token || !isGitHubOidcToken(token)) return null;
  let claims: GitHubOidcClaims;
  try {
    claims = await verifyPublisherToken(token);
  } catch (error) {
    console.warn('Knowledge publisher token refused:', (error as Error).message);
    return response(401, { error: 'Unauthorized' });
  }
  const method = (event.httpMethod || 'GET').toUpperCase();
  const path = event.path || '/';
  const allowed = (method === 'GET' && path === '/knowledge/manifest') || (method === 'POST' && path === '/knowledge/publish');
  if (!allowed) return response(403, { error: 'Knowledge publisher may only read the manifest and publish knowledge files' });
  const repo = claims.repository.split('/')[1];
  const result = await handleDocsRoutes(event, `git:${repo}@${claims.sha.slice(0, 12)}`, `Publish ${repo} ${claims.sha}`);
  return result || response(404, { error: 'Not found' });
}

/** Test-only reset for deterministic JWKS refresh assertions. */
export function resetKnowledgePublisherCaches(): void { jwksCache = null; }
