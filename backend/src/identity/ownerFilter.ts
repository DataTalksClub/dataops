/**
 * The `owner=me|team|unassigned|<user-id>` work filter.
 *
 * `me` is resolved from the verified server actor, never from a client-supplied
 * value, so a browser cannot widen its own scope by editing the query string.
 * A concrete reference returns only that owner's records together with an
 * honest availability projection, including for a disabled or missing user, so
 * a deep link never silently degrades into "my work".
 */

import type { VerifiedActor } from './actor';

export type OwnerFilter =
  | { kind: 'me'; userId: string }
  | { kind: 'user'; userId: string }
  | { kind: 'team' }
  | { kind: 'unassigned' };

export type OwnerFilterParse =
  | { ok: true; filter: OwnerFilter | null }
  | { ok: false; error: string };

const MAX_OWNER_REFERENCE_LENGTH = 200;

export function parseOwnerFilter(raw: unknown, actor: VerifiedActor): OwnerFilterParse {
  if (raw === undefined || raw === null) return { ok: true, filter: null };
  if (typeof raw !== 'string') return { ok: false, error: 'owner must be me, team, unassigned, or a user id' };
  const value = raw.trim();
  if (!value) return { ok: false, error: 'owner must be me, team, unassigned, or a user id' };
  if (value === 'me') {
    if (!actor.id) return { ok: false, error: 'owner=me requires a signed-in actor' };
    return { ok: true, filter: { kind: 'me', userId: actor.id } };
  }
  if (value === 'team') return { ok: true, filter: { kind: 'team' } };
  if (value === 'unassigned') return { ok: true, filter: { kind: 'unassigned' } };
  if (value.length > MAX_OWNER_REFERENCE_LENGTH) {
    return { ok: false, error: `owner must be ${MAX_OWNER_REFERENCE_LENGTH} characters or fewer` };
  }
  return { ok: true, filter: { kind: 'user', userId: value } };
}

/** The concrete user reference a filter names, if any. */
export function ownerFilterUserId(filter: OwnerFilter | null): string | null {
  if (!filter) return null;
  return filter.kind === 'me' || filter.kind === 'user' ? filter.userId : null;
}

/**
 * Does one record's owner reference satisfy the filter? `activeMemberIds` is
 * the current set of active workspace members, which is what `team` means.
 */
export function matchesOwnerFilter(
  ownerId: string | undefined | null,
  filter: OwnerFilter | null,
  activeMemberIds: Set<string>,
): boolean {
  if (!filter) return true;
  const owner = typeof ownerId === 'string' && ownerId.trim().length > 0 ? ownerId.trim() : null;
  if (filter.kind === 'unassigned') return owner === null;
  if (filter.kind === 'team') return owner !== null && activeMemberIds.has(owner);
  return owner === filter.userId;
}
