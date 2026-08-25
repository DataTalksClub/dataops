/**
 * One shared verified interactive actor resolver.
 *
 * Interactive Task/Card/team requests must all reach the same authorization
 * decision from the same place. The router (and the portal layer above it)
 * establishes identity from a browser cookie session, a bearer session, or an
 * API token and then propagates it as the internal `x-user-id` header; a
 * client-supplied header is stripped before that. This module turns that
 * propagated id into the current `User` and fails closed for a deleted,
 * disabled, missing-role, or unsupported-role actor before any team read or
 * Task/Card write happens.
 *
 * It never falls back to `system`, `portal-admin`, a requested owner, or a
 * Task assignee: an interactive route without a resolvable active user is
 * refused, not silently attributed to somebody else.
 *
 * The one exception is the explicit `NODE_ENV=test` + `SKIP_AUTH=true` test
 * bypass, which already disables authentication for the whole `/api/*` surface
 * in `src/router.ts`. Inside that bypass an unknown actor id is a synthetic
 * test actor rather than a real identity claim; a *known* user is still
 * resolved and still fails closed, so authorization can be exercised under the
 * bypass as well.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getUser } from '../db/users';
import type { LambdaEvent, LambdaResponse, User, UserRole } from '../types';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

/** The workspace supports exactly these two roles. */
const SUPPORTED_ROLES = new Set<UserRole>(['admin', 'operator']);

/** Why the actor is being resolved; selects the stable denial code. */
export type ActorPurpose = 'team-read' | 'work-read' | 'work-write';

export interface VerifiedActor {
  /** Stable actor id used for attribution and ownership comparisons. */
  id: string;
  /** The current user record, or null for the synthetic test-bypass actor. */
  user: User | null;
  role: UserRole | null;
  isAdmin: boolean;
  /** True only for the explicit unauthenticated test bypass. */
  testBypass: boolean;
}

export type ActorResolution =
  | { ok: true; actor: VerifiedActor }
  | { ok: false; response: LambdaResponse };

function json(statusCode: number, body: unknown): LambdaResponse {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

export function isTestAuthBypass(): boolean {
  return process.env.NODE_ENV === 'test' && process.env.SKIP_AUTH === 'true';
}

function propagatedActorId(event: LambdaEvent): string {
  const headers = event.headers || {};
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === 'x-user-id');
  return match && typeof match[1] === 'string' ? match[1].trim() : '';
}

/** The session middleware's refusal shape: no resource or role detail. */
export function unauthorizedResponse(): LambdaResponse {
  return json(401, { error: 'Unauthorized' });
}

/** Stable denial for a forbidden Task/Card administration write. */
export function workAdminForbidden(
  message = 'This action requires the record owner or an admin',
): LambdaResponse {
  return json(403, { error: message, code: 'work_admin_forbidden' });
}

/** Stable denial for a team/identity read the actor may not perform. */
export function teamReadForbidden(
  message = 'Team access requires an active admin or operator role',
): LambdaResponse {
  return json(403, { error: message, code: 'team_read_forbidden' });
}

function roleDenial(purpose: ActorPurpose): LambdaResponse {
  return purpose === 'work-write'
    ? workAdminForbidden('Work mutations require an active admin or operator role')
    : teamReadForbidden();
}

/**
 * Resolve the verified interactive actor for this request, or return the
 * response that refuses it.
 */
export async function resolveInteractiveActor(
  client: DynamoDBDocumentClient,
  event: LambdaEvent,
  purpose: ActorPurpose,
): Promise<ActorResolution> {
  const actorId = propagatedActorId(event);
  const bypass = isTestAuthBypass();

  if (!actorId) {
    if (bypass) {
      return { ok: true, actor: { id: '', user: null, role: null, isAdmin: true, testBypass: true } };
    }
    return { ok: false, response: unauthorizedResponse() };
  }

  const user = await getUser(client, actorId);
  if (!user) {
    // A deleted user, `portal-admin`, or any other non-user id is not an
    // interactive actor. Only the explicit test bypass may continue.
    if (bypass) {
      return { ok: true, actor: { id: actorId, user: null, role: null, isAdmin: true, testBypass: true } };
    }
    return { ok: false, response: unauthorizedResponse() };
  }
  if (user.disabled) return { ok: false, response: unauthorizedResponse() };
  if (!user.role || !SUPPORTED_ROLES.has(user.role)) {
    return { ok: false, response: roleDenial(purpose) };
  }

  return {
    ok: true,
    actor: {
      id: user.id,
      user,
      role: user.role,
      isAdmin: user.role === 'admin',
      testBypass: false,
    },
  };
}

/** True when this actor may perform an admin-only Task/Card administration. */
export function hasAdminAuthority(actor: VerifiedActor): boolean {
  return actor.isAdmin;
}

export { SUPPORTED_ROLES };
