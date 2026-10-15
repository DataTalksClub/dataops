/**
 * Safe team directory and safe user projections.
 *
 * `GET /api/users` is the account-management surface: it carries email and
 * other account fields and stays reserved for the Admin/Users screen. Routine
 * work views need a purpose-built projection instead, so this module is the
 * only place that turns a stored `User` into something a work API may return.
 *
 * A projection carries a stable id, a display name, the supported role, and
 * honest availability. It never carries email, password or session material,
 * private profile data, or an external avatar URL.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getFormerUser, getUser, listFormerUsers, listUsers } from '../db/users';
import type { FormerUser, User, UserRole } from '../types';
import { SUPPORTED_ROLES } from './actor';

export interface SafeUserProjection {
  /** Stable user id. Routine UI resolves a label from this projection. */
  id: string;
  /**
   * Display name, or null when the reference resolves to nothing. A deleted
   * account still has its name here (it left a former-user record), so
   * history that cites it reads as a person.
   */
  name: string | null;
  /** Supported role, or null for a missing or unsupported-role reference. */
  role: UserRole | null;
  /** True when the reference is a usable assignment/ownership target. */
  active: boolean;
  /** True when the user exists but is disabled. */
  disabled: boolean;
  /** False when the reference has no account: never existed, or deleted. */
  available: boolean;
}

function supportedRole(user: User): UserRole | null {
  return user.role && SUPPORTED_ROLES.has(user.role) ? user.role : null;
}

/** Project one resolved (or unresolved) user reference. */
export function safeUserProjection(id: string, user: User | null, former: FormerUser | null = null): SafeUserProjection {
  if (!user) {
    return { id, name: former?.name || null, role: null, active: false, disabled: false, available: false };
  }
  const role = supportedRole(user);
  return {
    id: user.id,
    name: user.name,
    role,
    active: role !== null && user.disabled !== true,
    disabled: user.disabled === true,
    available: true,
  };
}

/**
 * Request-scoped user cache. A single request resolves each referenced id at
 * most once, and list routes load the whole directory once instead of reading
 * one user per record.
 */
export class TeamDirectory {
  private readonly cache = new Map<string, User | null>();
  private readonly formerCache = new Map<string, FormerUser | null>();
  private loadedAll = false;

  constructor(private readonly client: DynamoDBDocumentClient) {}

  /** Load every user once; later `project` calls are then synchronous. */
  async loadAll(): Promise<void> {
    if (this.loadedAll) return;
    for (const user of await listUsers(this.client)) {
      this.cache.set(user.id, user);
    }
    for (const former of await listFormerUsers(this.client)) {
      this.formerCache.set(former.id, former);
    }
    this.loadedAll = true;
  }

  /** The name a deleted account left behind, for a reference with no account. */
  private async resolveFormer(id: string): Promise<FormerUser | null> {
    if (this.formerCache.has(id)) return this.formerCache.get(id) as FormerUser | null;
    const former = this.loadedAll ? null : await getFormerUser(this.client, id);
    this.formerCache.set(id, former);
    return former;
  }

  async resolve(id: string): Promise<User | null> {
    if (!id) return null;
    if (this.cache.has(id)) return this.cache.get(id) as User | null;
    const user = this.loadedAll ? null : await getUser(this.client, id);
    this.cache.set(id, user);
    return user;
  }

  /** Resolve and project one reference. */
  async project(id: string): Promise<SafeUserProjection> {
    const user = await this.resolve(id);
    return safeUserProjection(id, user, user || !id ? null : await this.resolveFormer(id));
  }

  /** Resolve and project several references, preserving first-seen order. */
  async projectMany(ids: Iterable<string>): Promise<SafeUserProjection[]> {
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      unique.push(id);
    }
    const projections: SafeUserProjection[] = [];
    for (const id of unique) projections.push(await this.project(id));
    return projections;
  }

  /**
   * The safe team-member list: every workspace member with a supported role.
   * Disabled members are retained so historical ownership stays resolvable.
   */
  async members(): Promise<SafeUserProjection[]> {
    await this.loadAll();
    const members: SafeUserProjection[] = [];
    for (const user of this.cache.values()) {
      if (!user || !supportedRole(user)) continue;
      members.push(safeUserProjection(user.id, user));
    }
    return members.sort((left, right) => (left.name || '').localeCompare(right.name || ''));
  }

  /** Ids of members who may currently be assigned or own work. */
  async activeMemberIds(): Promise<Set<string>> {
    return new Set((await this.members()).filter((member) => member.active).map((member) => member.id));
  }
}

/** Display names for publication actors (user ids, deleted accounts included); unnamed ids are left out. */
export async function userDisplayNames(client: DynamoDBDocumentClient, ids: string[]): Promise<Record<string, string>> {
  const projections = await new TeamDirectory(client).projectMany(ids);
  return Object.fromEntries(projections.filter((user) => user.name).map((user) => [user.id, user.name as string]));
}
