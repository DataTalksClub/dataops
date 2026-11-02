import { createPublicKey, verify as verifySignature, type JsonWebKey } from 'node:crypto';

/**
 * Shared-issuer access tokens (RFC 9068-shaped RS256 JWTs from the DTC
 * shared OAuth server at oauth.dtcdev.click) are the only machine
 * credentials this API accepts. Humans sign in through the issuer's device
 * or authorization-code flow (client `dtc-cli`) and hold tokens bound to
 * this API resource; deployment-managed services hold `client_credentials`
 * tokens bound to the same resource with issuer-registered scopes. Opaque
 * API tokens and static service secrets are gone: the issuer owns issuing,
 * refreshing and revoking; this module owns local verification against its
 * published JWKS.
 */
export const DEFAULT_SHARED_ISSUER = 'https://oauth.dtcdev.click';
export const DATAOPS_API_RESOURCE = 'https://ops.dtcdev.click';

/** MCP resources that forward their callers' tokens to this API. */
const DATAOPS_MCP_RESOURCES: readonly string[] = Object.freeze([
  'https://frzdkakcapcyf6ywflhieyimgu0vtclr.lambda-url.eu-west-1.on.aws/mcp',
  'https://mcp.ops.dtcdev.click/mcp',
  'https://ops.dtcdev.click/mcp',
]);

/**
 * Deployment-managed service principals and the only scopes the issuer can
 * grant them; mirrors the issuer's service-client catalog.
 */
export const SERVICE_CLIENTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'dataops-invoice-reader': Object.freeze(['invoice:read']),
  'dataops-automation-service': Object.freeze(['dataops:read', 'dataops:write']),
});

export interface SharedIssuerClaims {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  client_id?: string;
  email?: string | null;
  email_verified?: boolean | string | null;
  scope?: string;
  token_use?: string;
  grant_type?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
}

interface JwtHeader { alg?: string; kid?: string }
interface Jwk extends JsonWebKey { kid?: string; alg?: string; use?: string }
interface Jwks { keys?: Jwk[] }

interface SharedIssuerConfig {
  issuer: string;
  jwksUrl: string;
  audiences: readonly string[];
}

export function sharedIssuerConfig(): SharedIssuerConfig {
  const issuer = (process.env.OAUTH_ISSUER_URL || DEFAULT_SHARED_ISSUER).replace(/\/$/, '');
  const audiences = process.env.OAUTH_ALLOWED_RESOURCES
    ? process.env.OAUTH_ALLOWED_RESOURCES.split(',').map((value) => value.trim()).filter(Boolean)
    : [DATAOPS_API_RESOURCE, ...DATAOPS_MCP_RESOURCES];
  return {
    issuer,
    jwksUrl: process.env.OAUTH_JWKS_URL || `${issuer}/.well-known/jwks.json`,
    audiences,
  };
}

let jwksCache: { expiresAt: number; keys: Jwk[] } | null = null;

export function resetSharedIssuerCaches(): void {
  jwksCache = null;
}

async function fetchJwks(force = false): Promise<Jwk[]> {
  const now = Date.now();
  if (!force && jwksCache && jwksCache.expiresAt > now) return jwksCache.keys;
  const response = await fetch(sharedIssuerConfig().jwksUrl, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('JWKS request failed');
  const body = await response.json() as Jwks;
  if (!Array.isArray(body.keys) || body.keys.length === 0) throw new Error('JWKS response invalid');
  jwksCache = { keys: body.keys, expiresAt: now + 300_000 };
  return body.keys;
}

function parsePart<T>(part: string): T {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
}

/**
 * Verify one shared-issuer access token: RS256 signature against the
 * issuer's current JWKS, issuer match, unexpired, audience covering one of
 * this API's registered resources. Returns the claims or null when the
 * credential is not a shared-issuer JWT at all (the caller decides whether
 * that is fatal).
 */
export async function verifySharedIssuerJwt(token: string, now = new Date()): Promise<SharedIssuerClaims | null> {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) return null;
  let header: JwtHeader;
  let claims: SharedIssuerClaims;
  try {
    header = parsePart<JwtHeader>(parts[0]);
    claims = parsePart<SharedIssuerClaims>(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || !header.kid) return null;
  const config = sharedIssuerConfig();
  if (claims.iss !== config.issuer) return null;
  const seconds = Math.floor(now.getTime() / 1000);
  if (!Number.isFinite(claims.exp) || seconds >= claims.exp!) return null;
  if (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > seconds + 30)) return null;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud].filter((value): value is string => Boolean(value));
  if (!audiences.some((audience) => config.audiences.includes(audience))) return null;

  let keys = await fetchJwks();
  let key = keys.find((candidate) => candidate.kid === header.kid
    && (!candidate.alg || candidate.alg === 'RS256') && (!candidate.use || candidate.use === 'sig'));
  if (!key) {
    keys = await fetchJwks(true);
    key = keys.find((candidate) => candidate.kid === header.kid
      && (!candidate.alg || candidate.alg === 'RS256') && (!candidate.use || candidate.use === 'sig'));
  }
  if (!key) return null;
  let valid = false;
  try {
    valid = verifySignature(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({ key, format: 'jwk' }),
      Buffer.from(parts[2], 'base64url'),
    );
  } catch {
    valid = false;
  }
  return valid ? claims : null;
}

/** The scopes the issuer registered for a service principal, or null. */
export function serviceClientScopes(claims: SharedIssuerClaims | null): readonly string[] | null {
  if (!claims || claims.token_use !== 'access' || typeof claims.client_id !== 'string') return null;
  if (claims.email !== null && claims.email !== undefined) return null;
  return SERVICE_CLIENTS[claims.client_id] ?? null;
}

export function scopesInclude(scopes: readonly string[] | null, needed: string): boolean {
  return Boolean(scopes && scopes.includes(needed));
}

export function servicePrincipalId(claims: SharedIssuerClaims): string {
  return `service:${claims.client_id}`;
}
