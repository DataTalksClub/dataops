/**
 * Docs content API seam.
 *
 * Route handlers for the docs domain, ported from
 * `lambda-functions/src/lambda_functions/{api_handler,search_handler}.py`:
 * `/docs`, `/images`, `/folders`, `/lint`, `/health`, `/search`.
 *
 * Every handler is a STUB that returns HTTP 501 with a TODO payload. Issue #87
 * wires these to {@link GithubStore}, {@link SopEngine}, and {@link SearchIndex}.
 *
 * Registration is opt-in via {@link isDocsDomainEnabled} (env flag) so the
 * existing work-engine routes and tests are unaffected.
 */

import type { LambdaEvent, LambdaResponse } from '../types';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

/** Issue that fills in these handlers. */
const IMPLEMENTING_ISSUE = '#87';

/**
 * Path prefixes owned by the docs content API. A request path matches a route
 * when it equals the prefix or continues with `/`.
 */
export const DOCS_ROUTE_PREFIXES = [
  '/docs',
  '/images',
  '/folders',
  '/lint',
  '/health',
  '/search',
] as const;

export type DocsRoutePrefix = (typeof DOCS_ROUTE_PREFIXES)[number];

/** True when `path` belongs to the docs content API. */
export function isDocsRoute(path: string): boolean {
  return DOCS_ROUTE_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/**
 * Feature flag: only register/serve docs routes when explicitly enabled. Off by
 * default so the seam ships without changing existing behavior. Issue #87/#88
 * turn this on as the docs domain becomes real.
 */
export function isDocsDomainEnabled(): boolean {
  const value = process.env.DATAOPS_DOCS_DOMAIN;
  return value === 'true' || value === '1';
}

function notImplemented(route: DocsRoutePrefix, event: LambdaEvent): LambdaResponse {
  return {
    statusCode: 501,
    headers: JSON_HEADERS,
    body: JSON.stringify({
      error: 'Not Implemented',
      todo: `Docs content API route ${route} is a seam stub`,
      route,
      method: event.httpMethod || 'GET',
      path: event.path || '',
      issue: IMPLEMENTING_ISSUE,
    }),
  };
}

// ── Per-route stub handlers (issue #87 implements) ────────────────────────────

/** `/docs` — list/read/create/update/delete docs + registry/resolve/backlinks. */
export function handleDocsApi(event: LambdaEvent): LambdaResponse {
  return notImplemented('/docs', event);
}

/** `/images` — upload/serve content images. */
export function handleImagesApi(event: LambdaEvent): LambdaResponse {
  return notImplemented('/images', event);
}

/** `/folders` — delete/rename content folders. */
export function handleFoldersApi(event: LambdaEvent): LambdaResponse {
  return notImplemented('/folders', event);
}

/** `/lint` — corpus / single-doc SOP lint. */
export function handleLintApi(event: LambdaEvent): LambdaResponse {
  return notImplemented('/lint', event);
}

/** `/health` — docs-domain health check. */
export function handleHealthApi(event: LambdaEvent): LambdaResponse {
  return notImplemented('/health', event);
}

/** `/search` — docs/content search over the {@link SearchIndex}. */
export function handleSearchApi(event: LambdaEvent): LambdaResponse {
  return notImplemented('/search', event);
}

/**
 * Dispatch a docs-domain request. Returns `null` when the path is not a docs
 * route so the caller can fall through to other handlers. Returns a 501 stub
 * response for matched routes until issue #87 implements them.
 */
export async function handleDocsRoutes(event: LambdaEvent): Promise<LambdaResponse | null> {
  const path = event.path || '/';

  if (path === '/docs' || path.startsWith('/docs/')) return handleDocsApi(event);
  if (path === '/images' || path.startsWith('/images/')) return handleImagesApi(event);
  if (path === '/folders' || path.startsWith('/folders/')) return handleFoldersApi(event);
  if (path === '/lint' || path.startsWith('/lint/')) return handleLintApi(event);
  if (path === '/health' || path.startsWith('/health/')) return handleHealthApi(event);
  if (path === '/search' || path.startsWith('/search/')) return handleSearchApi(event);

  return null;
}
