/**
 * Portal layer for the consolidated single-origin backend.
 *
 * Implements shared browser auth, static frontend serving, and
 * `/content/*` serving from `lambda-functions/.../full_app_handler.py` so that
 * one TypeScript origin serves the frontend, the docs content API, and the work
 * APIs together. The cross-service `/work/api` proxy is replaced by an in-process
 * path rewrite (`/work/api/* -> /api/*`).
 *
 * Active only when {@link isDocsDomainEnabled} is true; the work-engine routes
 * and their tests are untouched while the flag is off.
 */

import { Buffer } from 'node:buffer';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { authErrorPage, browserAuthConfigured, browserUser, handleCallback, logout, startLogin, unauthenticatedApi } from '../auth/browserAuth';
import type { LambdaEvent, LambdaResponse } from '../types';
import { handleDocsRoutes, isDocsRoute } from './contentApi';
import { createGithubStore, githubStoreConfigFromEnv, type ContentsApiGithubStore } from './githubStore';

/** Result of the portal pre-processing pass. */
export interface PortalOutcome {
  /** A finished response (login/frontend/content/docs/401/302), if handled. */
  response?: LambdaResponse;
  /** True when the request carried valid portal credentials (or auth is open). */
  authorized: boolean;
  /** The mapped local user for an OAuth browser session. */
  userId?: string;
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

function redirectToLogin(): LambdaResponse {
  return { statusCode: 302, headers: { location: '/login', 'cache-control': 'no-store' }, body: '' };
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
export async function handlePortal(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<PortalOutcome> {
  const method = (event.httpMethod || 'GET').toUpperCase();
  const path = event.path || '/';

  // Shared Cognito browser auth. Local development remains open when the
  // non-secret relying-party configuration is intentionally absent.
  if (path === '/login' && method === 'GET') return { response: await startLogin(event, client), authorized: false };
  if (path === '/auth/callback' && method === 'GET') return { response: await handleCallback(event, client), authorized: false };
  if (path === '/auth/error' && method === 'GET') return { response: authErrorPage(), authorized: false };
  if (path === '/logout' && (method === 'GET' || method === 'POST')) return { response: await logout(event, client), authorized: false };
  if (path === '/api/auth/login') return { response: { statusCode: 404, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify({ error: 'Not found' }) }, authorized: false };
  if (path === '/api/health') return { authorized: false };

  const authEnabled = browserAuthConfigured();
  const user = authEnabled ? await browserUser(event, client) : null;
  const authorized = !authEnabled || Boolean(user);
  if (!authorized) {
    // Existing non-browser bearer clients continue through the router's own
    // server-side session validation, but a bearer token never serves a page.
    if (isDataPath(path) && /^Bearer\s+\S+$/i.test(headerValue(event, 'authorization'))) return { authorized: false };
    return { response: isDataPath(path) ? unauthenticatedApi() : redirectToLogin(), authorized: false };
  }

  // Replace the old cross-service /work/api proxy with an in-process rewrite.
  if (path === '/work/health') {
    event.path = '/api/health';
    return { authorized: true, userId: user?.id };
  }
  if (path.startsWith('/work/api/')) {
    event.path = path.slice('/work'.length);
    return { authorized: true, userId: user?.id };
  }
  if ((path === '/work' || path.startsWith('/work/')) && method === 'GET') {
    const index = serveIndex();
    if (index) return { response: index, authorized: true, userId: user?.id };
  }

  // Docs content API.
  if (isDocsRoute(path)) {
    const result = await handleDocsRoutes(event);
    if (result) return { response: result, authorized: true, userId: user?.id };
  }

  // Markdown / image content from the GitHub store cache.
  if (method === 'GET' && path.startsWith('/content/')) {
    return { response: await serveContent(path), authorized: true, userId: user?.id };
  }

  // Work/API routes are handled by the router after this authentication pass;
  // never let the SPA fallback turn an API response into HTML.
  if (isDataPath(path)) return { authorized: true, userId: user?.id };

  // Static frontend + SPA shell.
  const fe = serveFrontend(event, method, path);
  if (fe) return { response: fe, authorized: true, userId: user?.id };

  // Not a portal-owned route — let the work-engine routes proceed (authorized).
  return { authorized: true, userId: user?.id };
}
