/**
 * Shared-issuer JWT authentication for the DataOps MCP server.
 *
 * The only accepted credential is an RS256 access token minted by the DTC
 * shared OAuth issuer (`oauth.dtcdev.click`), audience-bound to this MCP
 * resource (RFC 8707). Opaque portal tokens are never accepted here: the
 * issuer owns issuing, refreshing and revoking, and this module owns local
 * verification against the issuer's published JWKS. Nothing is forwarded
 * for validation and no credential is minted, stored or logged.
 */
import { createPublicKey, verify as verifySignature } from 'node:crypto';

export const DEFAULT_ISSUER = 'https://oauth.dtcdev.click';

/** Scopes the shared issuer can grant; mirrored from its discovery document. */
export const ISSUER_SCOPES = Object.freeze([
  'openid',
  'email',
  'profile',
  'offline_access',
  'mcp',
  'admin',
  'read',
  'write',
  'claudeai',
]);

const JWKS_CACHE_MS = 10 * 60_000;
const CLOCK_SKEW_SECONDS = 30;

export function issuerUrl(env = process.env) {
  return String(env.OAUTH_ISSUER_URL || DEFAULT_ISSUER).replace(/\/$/, '');
}

/** The RFC 8707 resource identifier a caller at this origin must hold. */
export function resourceForRequest(requestUrl) {
  const url = new URL(requestUrl, 'http://localhost');
  const origin = `${url.protocol}//${url.host}`;
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${origin}${path}`;
}

/** Absolute request URL, derived from proxy headers when the target lacks one. */
export function requestUrl(req) {
  const host = String(req.headers?.['x-forwarded-host'] || req.headers?.host || 'localhost');
  const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '');
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  const proto = forwardedProto || (loopback ? 'http' : 'https');
  return new URL(req.url || '/', `${proto}://${host}`).href;
}

/** RFC 9728 protected-resource metadata for one MCP resource identifier. */
export function protectedResourceMetadata(resource, issuer = issuerUrl()) {
  return {
    resource,
    resource_name: 'DataOps MCP',
    authorization_servers: [issuer],
    scopes_supported: ISSUER_SCOPES,
    bearer_methods_supported: ['header'],
  };
}

/** RFC 6750 bearer challenge pointing OAuth-aware clients at the metadata. */
export function bearerChallengeHeaders(resource, { error } = {}) {
  const metadata = `${resource.replace(/\/mcp$/, '')}/.well-known/oauth-protected-resource/mcp`;
  const suffix = error ? `, error="${error}"` : '';
  return { 'WWW-Authenticate': `Bearer resource_metadata="${metadata}"${suffix}` };
}

function parseBearer(authorization) {
  const match = /^Bearer\s+(\S+)$/i.exec(String(authorization || ''));
  return match ? match[1] : null;
}

function decodeSegment(part, label) {
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw new TypeError(`invalid_token_${label}`);
  }
  if (!decoded || typeof decoded !== 'object') throw new TypeError(`invalid_token_${label}`);
  return decoded;
}

function splitJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) throw new TypeError('invalid_token_format');
  return parts;
}

let jwksCache = null;

export function resetJwksCache() {
  jwksCache = null;
}

async function fetchJwks(issuer, { force = false } = {}) {
  const now = Date.now();
  if (!force && jwksCache && jwksCache.issuer === issuer && jwksCache.expiresAt > now) return jwksCache.keys;
  const response = await fetch(`${issuer}/.well-known/jwks.json`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new TypeError('jwks_unavailable');
  const body = await response.json();
  const keys = Array.isArray(body?.keys) ? body.keys : [];
  if (keys.length === 0) throw new TypeError('jwks_invalid');
  jwksCache = { issuer, keys, expiresAt: now + JWKS_CACHE_MS };
  return keys;
}

function signingKeyFor(keys, header) {
  return keys.find(
    (key) =>
      key.kid === header.kid
      && (!key.alg || key.alg === 'RS256')
      && (!key.use || key.use === 'sig'),
  );
}

/**
 * Verify signature and issuer/time claims; returns the JWT claims. Throws a
 * TypeError carrying the RFC 6750 error code for the bearer challenge.
 */
export async function verifyJwt(token, { issuer = issuerUrl(), nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  const [headPart, claimPart, signaturePart] = splitJwt(token);
  const header = decodeSegment(headPart, 'header');
  const claims = decodeSegment(claimPart, 'claims');
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
    throw new TypeError('invalid_token');
  }
  let key = signingKeyFor(await fetchJwks(issuer), header);
  if (!key) key = signingKeyFor(await fetchJwks(issuer, { force: true }), header);
  if (!key) throw new TypeError('invalid_token');
  let valid = false;
  try {
    valid = verifySignature(
      'RSA-SHA256',
      Buffer.from(`${headPart}.${claimPart}`),
      createPublicKey({ key, format: 'jwk' }),
      Buffer.from(signaturePart, 'base64url'),
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new TypeError('invalid_token');
  if (claims.iss !== issuer) throw new TypeError('invalid_issuer');
  if (!Number.isFinite(claims.exp) || nowSeconds >= claims.exp) throw new TypeError('invalid_token');
  if (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > nowSeconds + CLOCK_SKEW_SECONDS)) {
    throw new TypeError('invalid_token');
  }
  return claims;
}

function audienceIncludes(claims, resource) {
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  return audiences.includes(resource);
}

/**
 * Authenticate one MCP request: parse the bearer JWT, verify it against the
 * shared issuer and require this request's resource in `aud`. Returns
 * `{ token, claims, resource }`, or null when the header is absent.
 */
export async function authenticateRequest(authorization, url, options = {}) {
  const resource = options.resource ?? resourceForRequest(url);
  const token = parseBearer(authorization);
  if (!token) return null;
  const claims = await verifyJwt(token, options);
  if (!audienceIncludes(claims, resource)) throw new TypeError('invalid_target');
  return { token, claims, resource };
}
