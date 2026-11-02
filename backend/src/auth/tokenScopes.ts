import { isDocsRoute } from '../docs';
import { LambdaEvent } from '../types';
import { headerValue } from '../httpHeaders';

export const API_TOKEN_SCOPES = [
  'kb:read',
  'kb:write',
  'templates:read',
  'templates:write',
  'cards:read',
  'cards:write',
  'newsletter:read',
  'newsletter:write',
] as const;

export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

const VALID_SCOPE_SET = new Set<string>(API_TOKEN_SCOPES);

export function parseApiTokenScopes(raw: unknown): ApiTokenScope[] | null {
  let parts: string[];
  if (typeof raw === 'string') {
    parts = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (Array.isArray(raw)) {
    if (!raw.every((item) => typeof item === 'string')) return null;
    parts = raw
      .flatMap((s) => s.split(','))
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    return null;
  }

  if (parts.length === 0) return null;

  const deduped: ApiTokenScope[] = [];
  for (const part of parts) {
    if (!VALID_SCOPE_SET.has(part)) return null;
    const scope = part as ApiTokenScope;
    if (!deduped.includes(scope)) {
      deduped.push(scope);
    }
  }
  return deduped;
}

function hasDomainRead(scopes: ReadonlySet<string>, domain: 'kb' | 'templates' | 'cards' | 'newsletter'): boolean {
  return scopes.has(`${domain}:read`) || scopes.has(`${domain}:write`);
}

function hasDomainWrite(scopes: ReadonlySet<string>, domain: 'kb' | 'templates' | 'cards' | 'newsletter'): boolean {
  return scopes.has(`${domain}:write`);
}

function matchesPrefix(cleanPath: string, prefix: string): boolean {
  return cleanPath === prefix || cleanPath.startsWith(`${prefix}/`);
}

export function isScopedTokenRequestAllowed(
  scopesList: readonly string[],
  method: string,
  rawPath: string,
): boolean {
  const scopes = new Set(scopesList);
  const upperMethod = method.toUpperCase();
  const isRead = upperMethod === 'GET' || upperMethod === 'HEAD';
  const cleanPath = (rawPath.split('?')[0] || '/').replace(/\/+$/, '') || '/';

  if (isRead && cleanPath === '/api/me') return true;
  if (upperMethod === 'DELETE' && cleanPath === '/api/tokens/self') return true;
  if (isRead && (matchesPrefix(cleanPath, '/api/team-members') || matchesPrefix(cleanPath, '/api/resources'))) {
    return true;
  }

  // Never allow token management, user management, or secrets via scoped tokens
  if (
    matchesPrefix(cleanPath, '/api/tokens') ||
    matchesPrefix(cleanPath, '/api/users') ||
    matchesPrefix(cleanPath, '/api/secrets')
  ) {
    return false;
  }

  // Knowledge base routes (/docs/*, /content/*, /knowledge-files/*, /api/operating-model)
  if (
    isDocsRoute(cleanPath) ||
    matchesPrefix(cleanPath, '/content') ||
    matchesPrefix(cleanPath, '/knowledge-files') ||
    matchesPrefix(cleanPath, '/api/operating-model')
  ) {
    return isRead ? hasDomainRead(scopes, 'kb') : hasDomainWrite(scopes, 'kb');
  }

  // Templates routes (/api/templates*)
  if (matchesPrefix(cleanPath, '/api/templates')) {
    if (isRead) {
      return (
        hasDomainRead(scopes, 'templates') ||
        hasDomainRead(scopes, 'cards') ||
        hasDomainRead(scopes, 'newsletter') ||
        hasDomainRead(scopes, 'kb')
      );
    }
    return hasDomainWrite(scopes, 'templates');
  }

  // Shared sponsor-docs routes (/api/sponsor-docs*) used by both cards and newsletter
  if (matchesPrefix(cleanPath, '/api/sponsor-docs')) {
    if (isRead) {
      return hasDomainRead(scopes, 'cards') || hasDomainRead(scopes, 'newsletter');
    }
    return hasDomainWrite(scopes, 'cards') || hasDomainWrite(scopes, 'newsletter');
  }

  // Newsletter routes
  if (
    matchesPrefix(cleanPath, '/api/newsletter-issues') ||
    matchesPrefix(cleanPath, '/api/sponsor-crm/newsletters')
  ) {
    return isRead ? hasDomainRead(scopes, 'newsletter') : hasDomainWrite(scopes, 'newsletter');
  }

  if (
    isRead &&
    (matchesPrefix(cleanPath, '/api/workspace-settings') ||
      matchesPrefix(cleanPath, '/api/sponsor-crm/organizations'))
  ) {
    return hasDomainRead(scopes, 'newsletter') || hasDomainRead(scopes, 'cards');
  }

  // Cards & tasks routes
  if (
    matchesPrefix(cleanPath, '/api/cards') ||
    matchesPrefix(cleanPath, '/api/tasks') ||
    matchesPrefix(cleanPath, '/api/card-documents') ||
    matchesPrefix(cleanPath, '/api/documents') ||
    matchesPrefix(cleanPath, '/api/campaign-calendar') ||
    matchesPrefix(cleanPath, '/api/files') ||
    matchesPrefix(cleanPath, '/api/artifacts') ||
    matchesPrefix(cleanPath, '/api/events') ||
    matchesPrefix(cleanPath, '/api/event-records') ||
    matchesPrefix(cleanPath, '/api/people') ||
    matchesPrefix(cleanPath, '/api/books') ||
    matchesPrefix(cleanPath, '/api/podcast-episodes') ||
    matchesPrefix(cleanPath, '/api/podcast-first-contact') ||
    matchesPrefix(cleanPath, '/api/calendar-holds') ||
    matchesPrefix(cleanPath, '/api/calendar-items')
  ) {
    if (isRead) {
      if (
        (matchesPrefix(cleanPath, '/api/cards') || matchesPrefix(cleanPath, '/api/tasks')) &&
        hasDomainRead(scopes, 'kb')
      ) {
        return true;
      }
      return hasDomainRead(scopes, 'cards');
    }
    return hasDomainWrite(scopes, 'cards');
  }

  return false;
}

export function getRequestTokenScopes(event: LambdaEvent): string[] | null {
  const raw = headerValue(event.headers, 'x-token-scopes');
  if (!raw) return null;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : null;
}

export function hasTokenScope(event: LambdaEvent, scope: ApiTokenScope): boolean {
  const scopes = getRequestTokenScopes(event);
  if (!scopes) return false;
  return scopes.includes(scope);
}
