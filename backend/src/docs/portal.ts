/**
 * Portal layer for the consolidated single-origin backend.
 *
 * Ports the Basic-auth gate, login/logout flow, static frontend serving, and
 * `/content/*` serving from `lambda-functions/.../full_app_handler.py` so that
 * one TypeScript origin serves the frontend, the docs content API, and the work
 * APIs together. The cross-service `/work/api` proxy is replaced by an in-process
 * path rewrite (`/work/api/* -> /api/*`).
 *
 * Active only when {@link isDocsDomainEnabled} is true; the work-engine routes
 * and their tests are untouched while the flag is off.
 */

import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

import type { LambdaEvent, LambdaResponse } from '../types';
import { handleDocsRoutes, isDocsRoute } from './contentApi';
import { createGithubStore, githubStoreConfigFromEnv, type ContentsApiGithubStore } from './githubStore';

/** Result of the portal pre-processing pass. */
export interface PortalOutcome {
  /** A finished response (login/frontend/content/docs/401/302), if handled. */
  response?: LambdaResponse;
  /** True when the request carried valid portal credentials (or auth is open). */
  authorized: boolean;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

let secretsClient: SecretsManagerClient | null = null;
let contentStore: ContentsApiGithubStore | null = null;

function frontendRoot(): string {
  if (process.env.FRONTEND_ROOT) return resolve(process.env.FRONTEND_ROOT);
  // src/docs -> src -> work-engine -> repo root -> frontend
  return resolve(__dirname, '..', '..', '..', 'frontend');
}

function store(): ContentsApiGithubStore {
  if (contentStore === null) contentStore = createGithubStore(githubStoreConfigFromEnv());
  return contentStore;
}

/** Inject a content store (tests). */
export function configurePortalStore(s: ContentsApiGithubStore | null): void {
  contentStore = s;
}

// ── Headers / auth primitives ─────────────────────────────────────────────────

function headerValue(event: LambdaEvent, name: string): string {
  const headers = event.headers || {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) return String(value);
  }
  return '';
}

function constantTimeEquals(actual: string, expected: string): boolean {
  if (!actual || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function secretString(secretName: string): Promise<string> {
  secretsClient ||= new SecretsManagerClient({});
  const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
  return result.SecretString || (result.SecretBinary ? Buffer.from(result.SecretBinary).toString('utf-8') : '');
}

async function basicAuthPassword(): Promise<string> {
  const password = process.env.BASIC_AUTH_PASSWORD || '';
  const secretName = process.env.BASIC_AUTH_PASSWORD_SECRET_NAME || '';
  if (password || !secretName) return password;
  return secretString(secretName);
}

function basicAuthUsername(): string {
  return process.env.BASIC_AUTH_USERNAME || 'admin';
}

function sessionToken(password: string): string {
  if (!password) return '';
  return createHmac('sha256', password).update('dataops-session').digest('hex');
}

function validSessionCookie(event: LambdaEvent, password: string): boolean {
  const expected = sessionToken(password);
  if (!expected) return false;
  const cookie = headerValue(event, 'cookie');
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'dtc_auth' && rest.length && constantTimeEquals(rest.join('='), expected)) return true;
  }
  return false;
}

function validBasicAuth(event: LambdaEvent, password: string): boolean {
  if (!password) return false;
  const header = headerValue(event, 'authorization');
  if (!header.startsWith('Basic ')) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf-8');
  } catch {
    return false;
  }
  const idx = decoded.indexOf(':');
  if (idx === -1) return false;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  return constantTimeEquals(user, basicAuthUsername()) && constantTimeEquals(pass, password);
}

// ── Login / logout ────────────────────────────────────────────────────────────

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loginPage(error: string): LambdaResponse {
  const errorHtml = error ? `<p class="error">${htmlEscape(error)}</p>` : '';
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>DataOps Login</title>
    <style>
      :root { color-scheme: light dark; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f6f5f1; color: #23231f; }
      form { width: min(360px, calc(100vw - 32px)); display: grid; gap: 12px; }
      h1 { margin: 0 0 8px; font-size: 24px; }
      label { display: grid; gap: 6px; font-size: 13px; color: #55524a; }
      input { box-sizing: border-box; width: 100%; padding: 11px 12px; border: 1px solid #cbc8bd;
        border-radius: 6px; font: inherit; background: #fff; color: #23231f; }
      button { padding: 11px 14px; border: 0; border-radius: 6px; font: inherit; font-weight: 650;
        background: #256f6c; color: white; cursor: pointer; }
      .error { margin: 0; color: #a33; font-size: 13px; }
    </style>
  </head>
  <body>
    <form method="post" action="/login">
      <h1>DataOps</h1>
      ${errorHtml}
      <label>Username <input name="username" autocomplete="username" autofocus></label>
      <label>Password <input name="password" type="password" autocomplete="current-password"></label>
      <label class="check"><input name="remember" type="checkbox" value="1" checked> Remember me</label>
      <button type="submit">Sign in</button>
    </form>
  </body>
</html>`;
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    body: html,
  };
}

function rawBody(event: LambdaEvent): string {
  const raw = event.body || '';
  if (event.isBase64Encoded && typeof raw === 'string') return Buffer.from(raw, 'base64').toString('utf-8');
  return String(raw);
}

async function handleLogin(event: LambdaEvent): Promise<LambdaResponse> {
  const username = basicAuthUsername();
  const password = await basicAuthPassword();
  const body = rawBody(event);
  const contentType = headerValue(event, 'content-type');
  let suppliedUser = '';
  let suppliedPassword = '';
  let remember = false;
  if (contentType.includes('application/json')) {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      payload = {};
    }
    suppliedUser = String(payload.username || '');
    suppliedPassword = String(payload.password || '');
    remember = Boolean(payload.remember);
  } else {
    const params = new URLSearchParams(body);
    suppliedUser = params.get('username') || '';
    suppliedPassword = params.get('password') || '';
    remember = ['1', 'true', 'on', 'yes'].includes((params.get('remember') || '').toLowerCase());
  }

  if (password && constantTimeEquals(suppliedUser, username) && constantTimeEquals(suppliedPassword, password)) {
    const maxAge = remember ? '; Max-Age=15552000' : '';
    return {
      statusCode: 302,
      headers: {
        location: '/',
        'set-cookie': `dtc_auth=${sessionToken(password)}; Path=/${maxAge}; HttpOnly; Secure; SameSite=Lax`,
        'cache-control': 'no-store',
      },
      body: '',
    };
  }
  return loginPage('Invalid username or password.');
}

function logoutResponse(): LambdaResponse {
  return {
    statusCode: 302,
    headers: {
      location: '/login',
      'set-cookie': 'dtc_auth=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
      'cache-control': 'no-store',
    },
    body: '',
  };
}

function redirectToLogin(): LambdaResponse {
  return { statusCode: 302, headers: { location: '/login', 'cache-control': 'no-store' }, body: '' };
}

function authChallenge(): LambdaResponse {
  return {
    statusCode: 401,
    headers: {
      'www-authenticate': 'Basic realm="DataOps"',
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
    body: 'Authentication required',
  };
}

// ── Static frontend + content serving ─────────────────────────────────────────

function extOf(p: string): string {
  const name = p.split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

function guessType(p: string): string {
  return CONTENT_TYPES[extOf(p)] || 'application/octet-stream';
}

function fileResponse(bytes: Buffer, contentType: string): LambdaResponse {
  const isText = contentType.startsWith('text/') || contentType.startsWith('application/javascript') || contentType.startsWith('application/json');
  if (isText) {
    return { statusCode: 200, headers: { 'content-type': contentType, 'cache-control': 'no-store' }, body: bytes.toString('utf-8') };
  }
  return {
    statusCode: 200,
    headers: { 'content-type': contentType, 'cache-control': 'no-store' },
    body: bytes.toString('base64'),
    isBase64Encoded: true,
  };
}

function resolveUnder(root: string, rel: string): string | null {
  if (rel.split('/').includes('..')) return null;
  const target = resolve(root, rel);
  if (target !== root && !target.startsWith(root + sep)) return null;
  if (!existsSync(target) || !statSync(target).isFile()) return null;
  return target;
}

function serveIndex(): LambdaResponse | null {
  const index = resolve(frontendRoot(), 'index.html');
  if (!existsSync(index)) return null;
  return fileResponse(readFileSync(index), 'text/html; charset=utf-8');
}

function serveFrontend(event: LambdaEvent, method: string, path: string): LambdaResponse | null {
  if (method !== 'GET') return null;

  if (path === '/' || path === '/index.html') return serveIndex();

  // Static assets (e.g. /src/app.js, /src/styles.css, favicon).
  if (path.startsWith('/src/') || extOf(path)) {
    const target = resolveUnder(frontendRoot(), path.replace(/^\/+/, ''));
    if (target) return fileResponse(readFileSync(target), guessType(target));
  }

  // SPA fallback: extensionless or markdown routes render the app shell.
  if (!extOf(path) || path.endsWith('.md')) return serveIndex();

  return null;
}

async function serveContent(path: string): Promise<LambdaResponse> {
  const repoPath = path.replace(/^\/+/, '');
  try {
    const bytes = await store().readBytes(repoPath);
    return fileResponse(Buffer.from(bytes), guessType(repoPath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { statusCode: 404, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'Not found' }) };
    }
    throw err;
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

function isDataPath(path: string): boolean {
  return (
    path.startsWith('/api/') ||
    path === '/api' ||
    isDocsRoute(path) ||
    path.startsWith('/content/')
  );
}

/**
 * Pre-process a request for the single-origin portal. Returns a finished
 * response for login/frontend/content/docs routes, or `{ authorized }` to let
 * the work-engine routes handle `/api/*` once credentials are verified.
 */
export async function handlePortal(event: LambdaEvent): Promise<PortalOutcome> {
  const method = (event.httpMethod || 'GET').toUpperCase();
  const path = event.path || '/';

  // Public auth routes.
  if (path === '/login' && method === 'GET') return { response: loginPage(''), authorized: false };
  if (path === '/login' && method === 'POST') return { response: await handleLogin(event), authorized: false };
  if (path === '/logout') return { response: logoutResponse(), authorized: false };

  // Auth gate. When no password is configured the portal runs open (local dev).
  const password = await basicAuthPassword();
  const authorized = !password || validSessionCookie(event, password) || validBasicAuth(event, password);
  if (!authorized) {
    return { response: isDataPath(path) ? authChallenge() : redirectToLogin(), authorized: false };
  }

  // Replace the old cross-service /work/api proxy with an in-process rewrite.
  if (path === '/work/health') {
    event.path = '/api/health';
    return { authorized: true };
  }
  if (path.startsWith('/work/api/')) {
    event.path = path.slice('/work'.length);
    return { authorized: true };
  }
  if ((path === '/work' || path.startsWith('/work/')) && method === 'GET') {
    const index = serveIndex();
    if (index) return { response: index, authorized: true };
  }

  // Docs content API.
  if (isDocsRoute(path)) {
    const result = await handleDocsRoutes(event);
    if (result) return { response: result, authorized: true };
  }

  // Markdown / image content from the GitHub store cache.
  if (method === 'GET' && path.startsWith('/content/')) {
    return { response: await serveContent(path), authorized: true };
  }

  // Static frontend + SPA shell.
  const fe = serveFrontend(event, method, path);
  if (fe) return { response: fe, authorized: true };

  // Not a portal-owned route — let the work-engine routes proceed (authorized).
  return { authorized: true };
}
