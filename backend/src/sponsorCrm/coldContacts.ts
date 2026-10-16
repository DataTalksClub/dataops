/**
 * Cold-contact reminders: organizations and contacts with no inbound or
 * outbound contact for longer than their relationship stage allows.
 *
 * An organization's last touch is the newest of its `lastInboundAt` /
 * `lastOutboundAt` stamps (kept current by the messages route and by
 * touches). A contact's last touch is its own stamps; a contact that was
 * never stamped is cold by definition, so a stale person is never hidden
 * behind activity with someone else at the same company.
 *
 * Thresholds come from workspace settings (`sponsorColdContactDays`, one
 * entry per relationship stage) unless the caller passes an explicit
 * `--days` override. Reminders are ordinary Tasks with a `sponsor-company`
 * subject — one open cold-contact Task per organization, never duplicates —
 * plus a notification, so re-engagement happens before contacts go cold.
 */
import { createHash } from 'crypto';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import type { CrmRecord } from '../db/sponsorCrm';
import { createCrmRecord, getCrmRecord, updateContactAtomic, updateOrganizationAtomic } from '../db/sponsorCrm';
import { createNotification } from '../db/notifications';
import { createTask, listTasksByStatus } from '../db/tasks';
import { loadAssignmentPolicy } from '../db/workspaceSettings';
import { dayDiff, realDate, relationshipTag } from './model';
import type { Task } from '../types';

export const COLD_TASK_SOURCE = 'sponsor-cold-contact';
export const COLD_TASK_TAG = 'cold-contact';
export const TOUCH_CHANNELS = new Set(['email', 'call', 'meeting', 'linkedin', 'other']);

export type ColdThresholds = {
  talking: number;
  customer: number;
  prospect: number;
  dormant: number;
};

export const DEFAULT_COLD_CONTACT_DAYS: ColdThresholds = Object.freeze({
  talking: 14,
  customer: 30,
  prospect: 30,
  dormant: 90,
}) as ColdThresholds;

/** Relationship stages a cold-contact threshold can be set for. */
export const COLD_STAGES = ['talking', 'customer', 'prospect', 'dormant'] as const;

export type ColdEntry = {
  kind: 'organization' | 'contact';
  id: string;
  organizationId: string;
  name: string;
  relationship: 'customer' | 'talking' | 'dormant' | 'prospect';
  lastInboundAt?: string;
  lastOutboundAt?: string;
  /** Days since the last touch; null when never contacted. */
  daysSince: number | null;
  threshold: number;
};

const stampOf = (record: Record<string, unknown>, name: 'lastInboundAt' | 'lastOutboundAt'): string | null => {
  const value = record[name];
  if (typeof value !== 'string' || !value) return null;
  const day = value.slice(0, 10);
  return realDate(day) ? value : null;
};

/** The newest inbound/outbound stamp on a record, or null when never contacted. */
export function lastTouchOf(record: Record<string, unknown>): string | null {
  const stamps = [stampOf(record, 'lastInboundAt'), stampOf(record, 'lastOutboundAt')].filter(Boolean) as string[];
  if (!stamps.length) return null;
  return stamps.sort().at(-1)!;
}

export function daysSinceTouch(last: string | null, today: string): number | null {
  if (!last) return null;
  return dayDiff(last.slice(0, 10), today);
}

export function thresholdFor(relationship: ColdEntry['relationship'], thresholds: ColdThresholds, overrideDays?: number): number {
  if (overrideDays !== undefined) return overrideDays;
  return thresholds[relationship] ?? DEFAULT_COLD_CONTACT_DAYS[relationship];
}

export function isCold(daysSince: number | null, threshold: number): boolean {
  // Never contacted: cold by definition. Otherwise cold once quiet for the
  // full threshold ("no contact for N days").
  return daysSince === null || daysSince >= threshold;
}

export function listColdEntries(input: {
  organizations: CrmRecord[];
  contacts: CrmRecord[];
  deals: CrmRecord[];
  today: string;
  thresholds: ColdThresholds;
  overrideDays?: number;
}): ColdEntry[] {
  const { organizations, contacts, deals, today, thresholds, overrideDays } = input;
  const dealsByOrg = new Map<string, CrmRecord[]>();
  for (const deal of deals) {
    const orgId = String(deal.organizationId || '');
    dealsByOrg.set(orgId, [...(dealsByOrg.get(orgId) || []), deal]);
  }
  const entries: ColdEntry[] = [];
  const orgById = new Map(organizations.map((org) => [org.id, org]));
  for (const org of organizations) {
    if (org.archivedAt) continue;
    const relationship = relationshipTag(org, dealsByOrg.get(org.id) || [], today);
    const threshold = thresholdFor(relationship, thresholds, overrideDays);
    const daysSince = daysSinceTouch(lastTouchOf(org), today);
    if (!isCold(daysSince, threshold)) continue;
    entries.push({
      kind: 'organization',
      id: org.id,
      organizationId: org.id,
      name: String(org.displayName || ''),
      relationship,
      ...(stampOf(org, 'lastInboundAt') ? { lastInboundAt: stampOf(org, 'lastInboundAt')! } : {}),
      ...(stampOf(org, 'lastOutboundAt') ? { lastOutboundAt: stampOf(org, 'lastOutboundAt')! } : {}),
      daysSince,
      threshold,
    });
  }
  for (const contact of contacts) {
    if (contact.archivedAt) continue;
    const org = orgById.get(String(contact.organizationId));
    if (!org || org.archivedAt) continue;
    const relationship = relationshipTag(org, dealsByOrg.get(org.id) || [], today);
    const threshold = thresholdFor(relationship, thresholds, overrideDays);
    const daysSince = daysSinceTouch(lastTouchOf(contact), today);
    if (!isCold(daysSince, threshold)) continue;
    entries.push({
      kind: 'contact',
      id: contact.id,
      organizationId: org.id,
      name: `${String(contact.name || '')} (${String(org.displayName || '')})`,
      relationship,
      ...(stampOf(contact, 'lastInboundAt') ? { lastInboundAt: stampOf(contact, 'lastInboundAt')! } : {}),
      ...(stampOf(contact, 'lastOutboundAt') ? { lastOutboundAt: stampOf(contact, 'lastOutboundAt')! } : {}),
      daysSince,
      threshold,
    });
  }
  // Coldest first; never-contacted (null) sorts before any day count.
  return entries.sort((a, b) => (b.daysSince ?? Number.MAX_SAFE_INTEGER) - (a.daysSince ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id));
}

const isColdTask = (task: Task) => task.source === COLD_TASK_SOURCE || task.tags?.includes(COLD_TASK_TAG);
const OPEN = new Set(['todo', 'waiting']);

/** Open cold-contact Tasks grouped by organization id. */
export async function openColdTasksByOrg(client: DynamoDBDocumentClient): Promise<Map<string, Task[]>> {
  const open = [...await listTasksByStatus(client, 'todo'), ...await listTasksByStatus(client, 'waiting')];
  const byOrg = new Map<string, Task[]>();
  for (const task of open) {
    if (!isColdTask(task) || task.subject?.type !== 'sponsor-company') continue;
    const list = byOrg.get(task.subject.id) || [];
    list.push(task);
    byOrg.set(task.subject.id, list);
  }
  return byOrg;
}

function coldTaskDescription(orgName: string, stale: ColdEntry[]): string {
  const detail = stale.slice(0, 5).map((entry) => {
    const last = entry.lastInboundAt || entry.lastOutboundAt;
    const quiet = entry.daysSince === null ? 'never contacted' : `quiet ${entry.daysSince}d (last ${String(last).slice(0, 10)})`;
    return entry.kind === 'contact' ? `${entry.name.split(' (')[0]}: ${quiet}` : quiet;
  }).join('; ');
  const extra = stale.length > 5 ? ` (+${stale.length - 5} more)` : '';
  return `Re-engage ${orgName} before the contact goes cold: ${detail}${extra}. Check recent threads, then log the outreach with \`dataops sponsors touch\`.`.slice(0, 500);
}

/**
 * Create one follow-up Task (plus notification) per cold organization that
 * has none open. Idempotent: organizations with an open cold-contact Task
 * are reported as skipped, never duplicated.
 */
export async function remindColdEntries(
  client: DynamoDBDocumentClient,
  entries: ColdEntry[],
  input: { actorId: string; today: string },
): Promise<{ created: Array<{ organizationId: string; taskId: string }>; skipped: string[] }> {
  const byOrg = new Map<string, ColdEntry[]>();
  for (const entry of entries) byOrg.set(entry.organizationId, [...(byOrg.get(entry.organizationId) || []), entry]);
  const open = await openColdTasksByOrg(client);
  const policy = await loadAssignmentPolicy(client, [input.actorId]);
  const created: Array<{ organizationId: string; taskId: string }> = [];
  const skipped: string[] = [];
  for (const [organizationId, stale] of byOrg) {
    if ((open.get(organizationId) || []).length > 0) {
      skipped.push(organizationId);
      continue;
    }
    const organization = await getCrmRecord(client, 'organization', organizationId);
    if (!organization || organization.archivedAt) {
      skipped.push(organizationId);
      continue;
    }
    const task = await createTask(client, {
      description: coldTaskDescription(String(organization.displayName || organizationId), stale),
      date: input.today,
      status: 'todo',
      source: COLD_TASK_SOURCE,
      tags: [COLD_TASK_TAG],
      subject: { type: 'sponsor-company', id: organizationId },
      assigneeId: policy.assigneeFor(input.actorId),
      createdBy: input.actorId,
    }, { actorId: input.actorId, triggerKind: 'sponsor-cold-contact' });
    await createNotification(client, {
      type: 'sponsor-cold-contact',
      message: `Sponsor contact going cold: ${String(organization.displayName || organizationId)}`,
      dueAt: input.today,
      metadata: {
        sponsorCompanyId: organizationId,
        sponsorAlertRule: 'cold-contact-due',
        sponsorAlertFingerprint: `cold-contact#${organizationId}#${input.today}`,
        coldTaskId: task.id,
        href: `/sponsors/companies/${encodeURIComponent(organizationId)}`,
      },
    });
    created.push({ organizationId, taskId: task.id });
  }
  return { created, skipped };
}

export type TouchTarget = { targetType: 'organization' | 'contact'; targetId: string };

/**
 * Log an outreach: stamp `lastOutboundAt` on the target (a contact touch
 * also warms its organization) and file the outbound message alongside the
 * Gmail-synced activity, so the next cold listing sees the contact.
 */
export async function touchTarget(
  client: DynamoDBDocumentClient,
  target: TouchTarget,
  input: { actorId: string; channel: string; note?: string; touchedAt: string },
): Promise<{ organization: CrmRecord; contact?: CrmRecord; messageId: string }> {
  if (!TOUCH_CHANNELS.has(input.channel)) throw Object.assign(new Error('channel must be one of: email, call, meeting, linkedin, other'), { statusCode: 400 });
  const stamp = input.touchedAt;
  const snippet = `${input.channel}: ${(input.note || 'outreach logged').slice(0, 440)}`;
  if (target.targetType === 'contact') {
    const contact = await getCrmRecord(client, 'contact', target.targetId);
    if (!contact || contact.archivedAt) throw Object.assign(new Error('Contact not found'), { statusCode: 404 });
    const organization = await getCrmRecord(client, 'organization', String(contact.organizationId));
    if (!organization || organization.archivedAt) throw Object.assign(new Error('Contact organization is archived'), { statusCode: 422 });
    const [nextContact, nextOrg] = await Promise.all([
      updateContactAtomic(client, contact, { lastOutboundAt: stamp }, input.actorId),
      updateOrganizationAtomic(client, organization, { lastOutboundAt: stamp }, input.actorId, 'touch'),
    ]);
    const message = await fileTouchMessage(client, {
      organizationId: organization.id,
      contactId: contact.id,
      personEmail: Array.isArray(contact.emails) ? String(contact.emails[0] || '') : '',
      snippet,
      sentAt: stamp,
      channel: input.channel,
    });
    return { organization: nextOrg, contact: nextContact, messageId: message.id };
  }
  const organization = await getCrmRecord(client, 'organization', target.targetId);
  if (!organization || organization.archivedAt) throw Object.assign(new Error('Organization not found'), { statusCode: 404 });
  const nextOrg = await updateOrganizationAtomic(client, organization, { lastOutboundAt: stamp }, input.actorId, 'touch');
  const message = await fileTouchMessage(client, {
    organizationId: organization.id,
    snippet,
    sentAt: stamp,
    channel: input.channel,
  });
  return { organization: nextOrg, messageId: message.id };
}

async function fileTouchMessage(
  client: DynamoDBDocumentClient,
  value: { organizationId: string; contactId?: string; personEmail?: string; snippet: string; sentAt: string; channel: string },
) {
  const seed = `${value.organizationId}:${value.contactId || 'org'}:${value.channel}:${value.sentAt}`;
  const threadId = `touch-${createHash('sha256').update(seed).digest('hex').slice(0, 12)}`;
  const { item, duplicate } = await createCrmRecord(client, 'message', {
    organizationId: value.organizationId,
    ...(value.contactId ? { contactId: value.contactId } : {}),
    ...(value.personEmail ? { personEmail: value.personEmail } : {}),
    threadId,
    direction: 'outbound',
    snippet: value.snippet,
    sentAt: value.sentAt,
    sourceType: 'touch',
    sourceKey: `touch:${value.organizationId}:${value.contactId || 'org'}:${value.channel}:${value.sentAt}`,
  });
  void duplicate;
  return item;
}
