import { isDocsRoute } from '../docs';

export const API_TOKEN_SCOPES = [
  'kb:write',
  'templates:write',
  'cards:write',
  'newsletter:write',
] as const;

export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

const VALID_SCOPES = new Set<string>(API_TOKEN_SCOPES);

export function parseApiTokenScopes(raw: unknown): ApiTokenScope[] | null {
  let parts: string[];
  if (typeof raw === 'string') {
    parts = raw.split(',').map((part) => part.trim()).filter(Boolean);
  } else if (Array.isArray(raw) && raw.every((item) => typeof item === 'string')) {
    parts = raw.flatMap((part) => part.split(',')).map((part) => part.trim()).filter(Boolean);
  } else {
    return null;
  }

  if (parts.length === 0 || parts.some((part) => !VALID_SCOPES.has(part))) return null;
  return [...new Set(parts)] as ApiTokenScope[];
}

function matchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function cleanPath(rawPath: string): string {
  return (rawPath.split('?')[0] || '/').replace(/\/+$/, '') || '/';
}

function has(scopes: ReadonlySet<string>, scope: ApiTokenScope): boolean {
  return scopes.has(scope);
}

function allowsRead(scopes: ReadonlySet<string>, ...required: ApiTokenScope[]): boolean {
  return required.some((scope) => has(scopes, scope));
}

/**
 * Keep scoped agents inside the work areas the administrator granted. A
 * write scope includes read access to that same area so read-before-write CLI
 * commands can operate; unrelated administration and finance routes stay
 * closed.
 */
export function isScopedTokenRequestAllowed(
  scopesList: readonly string[],
  method: string,
  rawPath: string,
): boolean {
  const scopes = new Set(scopesList);
  const upperMethod = method.toUpperCase();
  const isRead = upperMethod === 'GET' || upperMethod === 'HEAD';
  const path = cleanPath(rawPath);

  if (isRead && path === '/api/me') return true;
  if (upperMethod === 'DELETE' && path === '/api/tokens/self') return true;
  if (matchesPrefix(path, '/api/tokens') || matchesPrefix(path, '/api/users') || matchesPrefix(path, '/api/secrets')) {
    return false;
  }

  if (
    isDocsRoute(path)
    || matchesPrefix(path, '/content')
    || matchesPrefix(path, '/knowledge-files')
    || matchesPrefix(path, '/api/operating-model')
  ) {
    return has(scopes, 'kb:write');
  }

  if (matchesPrefix(path, '/api/templates')) {
    return isRead
      ? allowsRead(scopes, 'templates:write', 'cards:write', 'newsletter:write')
      : has(scopes, 'templates:write');
  }

  if (matchesPrefix(path, '/api/sponsor-docs')) {
    return isRead
      ? allowsRead(scopes, 'cards:write', 'newsletter:write')
      : has(scopes, 'newsletter:write');
  }

  if (matchesPrefix(path, '/api/email-templates')) {
    return has(scopes, 'newsletter:write');
  }

  if (
    matchesPrefix(path, '/api/newsletter-issues')
    || matchesPrefix(path, '/api/sponsor-crm/newsletters')
  ) {
    return has(scopes, 'newsletter:write');
  }

  if (
    isRead
    && (matchesPrefix(path, '/api/workspace-settings') || matchesPrefix(path, '/api/sponsor-crm/organizations'))
  ) {
    return allowsRead(scopes, 'cards:write', 'newsletter:write');
  }

  if (isRead && (matchesPrefix(path, '/api/team-members') || matchesPrefix(path, '/api/resources'))) {
    return allowsRead(scopes, 'templates:write', 'cards:write', 'newsletter:write');
  }

  if (
    matchesPrefix(path, '/api/cards')
    || matchesPrefix(path, '/api/tasks')
    || matchesPrefix(path, '/api/card-documents')
    || matchesPrefix(path, '/api/documents')
    || matchesPrefix(path, '/api/campaign-calendar')
    || matchesPrefix(path, '/api/files')
    || matchesPrefix(path, '/api/artifacts')
    || matchesPrefix(path, '/api/events')
    || matchesPrefix(path, '/api/event-records')
    || matchesPrefix(path, '/api/people')
    || matchesPrefix(path, '/api/books')
    || matchesPrefix(path, '/api/podcast-episodes')
    || matchesPrefix(path, '/api/podcast-first-contact')
    || matchesPrefix(path, '/api/calendar-holds')
    || matchesPrefix(path, '/api/calendar-items')
  ) {
    return has(scopes, 'cards:write');
  }

  return false;
}
