import { createHash, createPublicKey, randomBytes, verify as verifySignature, type JsonWebKey } from 'node:crypto';
import { DeleteCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_SESSIONS } from '../db/setup';
import { createBrowserSession, deleteSession, getSession } from '../db/sessions';
import { getUser, getUsersByNormalizedEmail } from '../db/users';
import type { LambdaEvent, LambdaResponse, User } from '../types';

const SESSION_COOKIE = 'dataops_session';
const TRANSACTION_COOKIE = 'dataops_oauth_tx';
const TRANSACTION_LIFETIME_SECONDS = 600;
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

interface AuthConfig {
  baseUrl: string;
  issuer: string;
  jwksUrl: string;
  clientId: string;
  callbackUrl: string;
  logoutUrl: string;
  sessionLifetimeSeconds: number;
}

interface OAuthTransaction {
  stateHash: string;
  bindingHash: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  expiresAt: string;
  ttl: number;
}

interface JwtHeader { alg?: string; kid?: string }
interface JwtClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean | string;
  token_use?: string;
}
interface Jwk extends JsonWebKey { kid?: string; alg?: string; use?: string }
interface Jwks { keys: Jwk[] }

let jwksCache: { expiresAt: number; keys: Jwk[] } | null = null;

function authConfig(): AuthConfig {
  const issuer = (process.env.AUTH_ISSUER || '').replace(/\/$/, '');
  const lifetime = Number(process.env.AUTH_SESSION_LIFETIME_SECONDS || '28800');
  return {
    baseUrl: (process.env.AUTH_BASE_URL || '').replace(/\/$/, ''),
    issuer,
    jwksUrl: process.env.AUTH_JWKS_URL || `${issuer}/.well-known/jwks.json`,
    clientId: process.env.AUTH_CLIENT_ID || '',
    callbackUrl: process.env.AUTH_CALLBACK_URL || '',
    logoutUrl: process.env.AUTH_LOGOUT_URL || '',
    sessionLifetimeSeconds: Number.isFinite(lifetime) && lifetime >= 300 ? lifetime : 28800,
  };
}

export function browserAuthConfigured(): boolean {
  const c = authConfig();
  return Boolean(c.baseUrl && c.issuer && c.clientId && c.callbackUrl && c.logoutUrl);
}

function base64url(input: Buffer): string { return input.toString('base64url'); }
function sha256(value: string): string { return createHash('sha256').update(value).digest('base64url'); }
function randomValue(bytes = 32): string { return base64url(randomBytes(bytes)); }

function headerValue(event: LambdaEvent, name: string): string {
  return Object.entries(event.headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] || '';
}

function cookieValue(event: LambdaEvent, name: string): string {
  for (const part of headerValue(event, 'cookie').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return '';
}

function secureCookie(name: string, value: string, maxAge?: number): string {
  const age = maxAge === undefined ? '' : `; Max-Age=${maxAge}`;
  return `${name}=${value}; Path=/${age}; HttpOnly; Secure; SameSite=Lax`;
}

function containsUnsafeUrlCharacters(value: string): boolean {
  return /[\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value);
}

function decodedForms(value: string): string[] | null {
  const forms = [value];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(forms[forms.length - 1]);
    } catch {
      return null;
    }
    if (decoded === forms[forms.length - 1]) return forms;
    forms.push(decoded);
  }
  // Do not accept a target whose normalization needs an unreasonable number
  // of passes; nested encoding is unnecessary for a portal return path.
  return null;
}

function safeReturnTo(value: string | undefined): string {
  if (!value || value.length > 2048 || !value.startsWith('/') || value.startsWith('//')) return '/';
  const forms = decodedForms(value);
  if (!forms) return '/';

  try {
    const callback = new URL(authConfig().callbackUrl);
    for (const form of forms) {
      if (containsUnsafeUrlCharacters(form) || form.startsWith('//')) return '/';
      const normalizedForm = new URL(form, callback.origin);
      if (normalizedForm.origin !== callback.origin) return '/';
      const normalizedPath = normalizedForm.pathname.toLowerCase();
      if (normalizedPath === '/login' || normalizedPath === '/logout' || normalizedPath === '/auth' || normalizedPath.startsWith('/auth/')) return '/';
    }
    const target = new URL(value, callback.origin);
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return '/';
  }
}

const ERROR_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

/** Render only on the clean route; callback URLs must never contain this HTML. */
export function authErrorPage(): LambdaResponse {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Sign-in issue · DataOps</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #242424; background: #f7f7f5; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #f7f7f5; }
    .panel { width: min(100%, 460px); padding: 32px; border: 1px solid #e6e5e1; border-radius: 12px; background: #fff; box-shadow: 0 18px 60px rgb(15 15 15 / 10%); }
    .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 28px; }
    .mark { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 8px; color: #fff; background: #1f6f64; font-weight: 750; }
    .brand strong { display: block; font-size: 16px; }
    .brand span { color: #6f6e69; font-size: 12px; }
    .status { width: 44px; height: 44px; display: grid; place-items: center; margin-bottom: 18px; border-radius: 50%; color: #a14225; background: #f8ebe6; font-size: 22px; font-weight: 700; }
    h1 { margin: 0 0 10px; font-size: 26px; line-height: 1.2; letter-spacing: -0.02em; }
    p { margin: 0; color: #6f6e69; font-size: 14px; line-height: 1.55; }
    .actions { margin-top: 26px; }
    a { display: inline-flex; min-height: 44px; align-items: center; justify-content: center; padding: 0 18px; border-radius: 6px; color: #fff; background: #1f6f64; font-size: 14px; font-weight: 650; text-decoration: none; }
    a:hover { background: #195c53; }
    a:focus-visible, h1:focus-visible { outline: 3px solid rgb(31 111 100 / 32%); outline-offset: 3px; }
  </style>
</head>
<body>
  <main class="panel" aria-labelledby="auth-error-title">
    <div class="brand" aria-label="DataOps by DataTalks.Club"><div class="mark" aria-hidden="true">D</div><div><strong>DataOps</strong><span>DataTalks.Club operations workspace</span></div></div>
    <div class="status" aria-hidden="true">!</div>
    <h1 id="auth-error-title" tabindex="-1" autofocus>We couldn’t sign you in</h1>
    <p>Your sign-in could not be completed. Please try again. If the issue continues, contact the DataOps administrator.</p>
    <div class="actions"><a href="/login">Try signing in again</a></div>
  </main>
</body>
</html>`;
  return { statusCode: 403, headers: ERROR_HEADERS, body: html };
}

function callbackFailure(): LambdaResponse {
  return {
    statusCode: 303,
    headers: {
      location: '/auth/error',
      'set-cookie': secureCookie(TRANSACTION_COOKIE, '', 0),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
    body: '',
  };
}

function configurationError(): LambdaResponse {
  return { statusCode: 503, headers: ERROR_HEADERS, body: authErrorPage().body };
}

async function storeTransaction(client: DynamoDBDocumentClient, state: string, transaction: OAuthTransaction): Promise<void> {
  const key = sha256(state);
  await client.send(new PutCommand({
    TableName: TABLE_SESSIONS,
    Item: { PK: `OAUTH#${key}`, SK: `OAUTH#${key}`, ...transaction },
    ConditionExpression: 'attribute_not_exists(PK)',
  }));
}

async function consumeTransaction(client: DynamoDBDocumentClient, state: string): Promise<OAuthTransaction | null> {
  const key = sha256(state);
  const result = await client.send(new DeleteCommand({
    TableName: TABLE_SESSIONS,
    Key: { PK: `OAUTH#${key}`, SK: `OAUTH#${key}` },
    ReturnValues: 'ALL_OLD',
  }));
  if (!result.Attributes) return null;
  const { PK: _pk, SK: _sk, ...transaction } = result.Attributes;
  return transaction as unknown as OAuthTransaction;
}

export async function startLogin(event: LambdaEvent, client: DynamoDBDocumentClient, now = new Date()): Promise<LambdaResponse> {
  if (!browserAuthConfigured()) return configurationError();
  const config = authConfig();
  const state = randomValue();
  const binding = randomValue();
  const nonce = randomValue();
  const verifier = randomValue(64);
  const expiresAt = new Date(now.getTime() + TRANSACTION_LIFETIME_SECONDS * 1000);
  await storeTransaction(client, state, {
    stateHash: sha256(state),
    bindingHash: sha256(binding),
    nonce,
    verifier,
    returnTo: safeReturnTo(event.queryStringParameters?.return_to),
    expiresAt: expiresAt.toISOString(),
    ttl: Math.floor(expiresAt.getTime() / 1000),
  });
  const authorize = new URL(`${config.baseUrl}/oauth2/authorize`);
  authorize.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: sha256(verifier),
    code_challenge_method: 'S256',
  }).toString();
  return {
    statusCode: 302,
    headers: {
      location: authorize.toString(),
      'set-cookie': secureCookie(TRANSACTION_COOKIE, binding, TRANSACTION_LIFETIME_SECONDS),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
    body: '',
  };
}

async function fetchJwks(force = false): Promise<Jwk[]> {
  const now = Date.now();
  if (!force && jwksCache && jwksCache.expiresAt > now) return jwksCache.keys;
  const response = await fetch(authConfig().jwksUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('JWKS request failed');
  const body = await response.json() as Jwks;
  if (!Array.isArray(body.keys) || body.keys.length === 0) throw new Error('JWKS response invalid');
  jwksCache = { keys: body.keys, expiresAt: now + 300_000 };
  return body.keys;
}

function parsePart<T>(part: string): T { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T; }

async function validateIdToken(token: string, expectedNonce: string, now = new Date()): Promise<JwtClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token');
  const header = parsePart<JwtHeader>(parts[0]);
  const claims = parsePart<JwtClaims>(parts[1]);
  if (header.alg !== 'RS256' || !header.kid) throw new Error('Invalid token algorithm');
  let keys = await fetchJwks();
  let key = keys.find((candidate) => candidate.kid === header.kid && (!candidate.alg || candidate.alg === 'RS256') && (!candidate.use || candidate.use === 'sig'));
  if (!key) {
    keys = await fetchJwks(true);
    key = keys.find((candidate) => candidate.kid === header.kid && (!candidate.alg || candidate.alg === 'RS256') && (!candidate.use || candidate.use === 'sig'));
  }
  if (!key) throw new Error('Signing key not found');
  let valid = verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  if (!valid) {
    const refreshed = await fetchJwks(true);
    const refreshedKey = refreshed.find((candidate) => candidate.kid === header.kid && (!candidate.alg || candidate.alg === 'RS256') && (!candidate.use || candidate.use === 'sig'));
    valid = Boolean(refreshedKey && verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: refreshedKey!, format: 'jwk' }), Buffer.from(parts[2], 'base64url')));
  }
  if (!valid) throw new Error('Invalid token signature');
  const config = authConfig();
  const seconds = Math.floor(now.getTime() / 1000);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== config.issuer || !audience.includes(config.clientId)) throw new Error('Invalid token claims');
  if (!claims.exp || claims.exp <= seconds || (claims.nbf !== undefined && claims.nbf > seconds + 30)) throw new Error('Expired token');
  if (claims.nonce !== expectedNonce || claims.token_use !== 'id') throw new Error('Invalid token claims');
  if (!claims.email || !(claims.email_verified === true || claims.email_verified === 'true')) throw new Error('Unverified email');
  return claims;
}

async function exchangeCode(code: string, verifier: string): Promise<string> {
  const config = authConfig();
  const response = await fetch(`${config.baseUrl}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: config.clientId, code, redirect_uri: config.callbackUrl, code_verifier: verifier }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Token exchange failed');
  const body = await response.json() as { id_token?: string };
  if (!body.id_token) throw new Error('ID token missing');
  return body.id_token;
}

export async function handleCallback(event: LambdaEvent, client: DynamoDBDocumentClient, now = new Date()): Promise<LambdaResponse> {
  const query = event.queryStringParameters || {};
  if (!query.state) return callbackFailure();
  const transaction = await consumeTransaction(client, query.state);
  const binding = cookieValue(event, TRANSACTION_COOKIE);
  if (!transaction || transaction.stateHash !== sha256(query.state) || transaction.bindingHash !== sha256(binding) || Date.parse(transaction.expiresAt) <= now.getTime()) {
    return callbackFailure();
  }
  if (query.error || !query.code) return callbackFailure();
  try {
    const claims = await validateIdToken(await exchangeCode(query.code, transaction.verifier), transaction.nonce, now);
    const users = await getUsersByNormalizedEmail(client, claims.email!);
    if (users.length !== 1 || users[0].disabled) return callbackFailure();
    const session = await createBrowserSession(client, users[0].id, { now, lifetimeSeconds: authConfig().sessionLifetimeSeconds });
    return {
      statusCode: 302,
      headers: {
        location: transaction.returnTo,
        'set-cookie': secureCookie(SESSION_COOKIE, session.token, authConfig().sessionLifetimeSeconds),
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      },
      body: '',
    };
  } catch {
    return callbackFailure();
  }
}

export async function browserUser(event: LambdaEvent, client: DynamoDBDocumentClient, now = new Date()): Promise<User | null> {
  const token = cookieValue(event, SESSION_COOKIE);
  if (!token) return null;
  const session = await getSession(client, token, now);
  if (!session || session.sessionType !== 'browser') return null;
  const user = await getUser(client, session.userId);
  return user && !user.disabled ? user : null;
}

export async function logout(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const token = cookieValue(event, SESSION_COOKIE);
  if (token) await deleteSession(client, token);
  const config = authConfig();
  if (!browserAuthConfigured()) {
    return {
      statusCode: 302,
      headers: { location: '/', 'set-cookie': secureCookie(SESSION_COOKIE, '', 0), 'cache-control': 'no-store' },
      body: '',
    };
  }
  const url = new URL(`${config.baseUrl}/logout`);
  url.search = new URLSearchParams({ client_id: config.clientId, logout_uri: config.logoutUrl }).toString();
  return {
    statusCode: 302,
    headers: { location: url.toString(), 'set-cookie': secureCookie(SESSION_COOKIE, '', 0), 'cache-control': 'no-store' },
    body: '',
  };
}

export function unauthenticatedApi(): LambdaResponse {
  return { statusCode: 401, headers: JSON_HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) };
}

/** Test-only reset for deterministic JWKS refresh assertions. */
export function resetBrowserAuthCaches(): void { jwksCache = null; }
