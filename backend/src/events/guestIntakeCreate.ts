import { loadAssignmentPolicy } from '../db/workspaceSettings';
import { createHash } from 'node:crypto';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getCardConsistent } from '../db/cards';
import { listTasksByCardConsistent } from '../db/tasks';
import { berlinToday } from '../calendar/ownerCalendarOverlay';
import type { Template, Task, Card } from '../types';
import { APPROVED_GUEST_EVENT_TYPES } from './guestIntakePolicy';
import { resolveGuestContact, GuestContactInputError } from './guestContact';
import { getGuestIntakeJob, guestIntakeKey, type GuestIntakeJob } from './guestIntakeStore';
import { putNew, type PlannedWrite } from '../db/plannedWrite';
import { TABLE_ARTIFACTS } from '../db/tableNames';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'creationKey').sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => [k, canonical(value)]));
  return v;
}
export async function prepareGuestIntake(db: DynamoDBDocumentClient, actorId: string, template: Template, body: Record<string, unknown>) {
  if (!APPROVED_GUEST_EVENT_TYPES.has(template.type || '') || !template.guestIntake?.enabled) return null;
  const names = Array.isArray(body.people) ? body.people as string[] : [];
  const hasGuest = body.guestEmail !== undefined || body.guestPersonId || body.guestContactId || body.guestReference || body.guestName || names.length;
  if (!hasGuest) return null;
  if (body.skipEmail !== undefined && typeof body.skipEmail !== 'boolean') throw new Error('skipEmail must be boolean');
  const guest = await resolveGuestContact(db, { ...body, guestName: body.guestName || names[0] });
  for (const key of ['timeZone', 'guestTimezone'] as const) if (body[key] !== undefined && body[key] !== '') {
    if (typeof body[key] !== 'string') throw new Error(`${key} must be an IANA time zone`);
    try { new Intl.DateTimeFormat('en', { timeZone: body[key] as string }); } catch { throw new Error(`${key} must be an IANA time zone`); }
  }
  if (body.time !== undefined && (typeof body.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time))) throw new Error('time must be HH:MM');
  if (body.time && !body.anchorDate) throw new Error('An explicit time requires anchorDate');
  if (body.window !== undefined && (typeof body.window !== 'string' || !Object.hasOwn(template.eventPolicy?.windows || (template.base?.eventPolicy as import('./policy').EventPolicy | undefined)?.windows || {}, body.window))) throw new Error('window must name a configured event window');
  const fingerprint = hash(JSON.stringify(canonical({ ...body, templateId: template.id, guestEmail: guest.email, guestName: guest.name })));
  const creationKey = typeof body.creationKey === 'string' && body.creationKey.trim() ? body.creationKey.trim() : `auto:${fingerprint}`;
  if (creationKey.length > 200) throw new Error('creationKey is too long');
  const id = hash(`${actorId}:${template.id}:${creationKey}`);
  const existing = await getGuestIntakeJob(db, id);
  if (existing && existing.fingerprint !== fingerprint) throw new Error('creationKey already belongs to a different Card request');
  const contactDefinition = template.taskDefinitions?.find(d => template.guestIntake?.firstContactTaskRefs?.includes(d.refId));
  const assignment = await loadAssignmentPolicy(db, [contactDefinition?.assigneeId]);
  const intakeAssigneeId = assignment.assigneeFor(contactDefinition?.assigneeId);
  const now = new Date().toISOString();
  const job: GuestIntakeJob = existing || {
    id, cardId: '', taskId: `guest-intake-${id}`, actorId, type: template.type!, creationKey, fingerprint,
    status: guest.email ? 'queued' : 'contact-pending', guestEmail: guest.email, guestName: guest.name,
    topic: typeof body.topic === 'string' && body.topic.trim() ? body.topic.trim() : undefined,
    skipEmail: body.skipEmail === true,
    requestedDate: typeof body.anchorDate === 'string' ? body.anchorDate : undefined,
    requestedTime: typeof body.time === 'string' ? body.time : undefined,
    timeZone: typeof body.timeZone === 'string' ? body.timeZone : 'Europe/Berlin',
    guestTimezone: typeof body.guestTimezone === 'string' && body.guestTimezone ? body.guestTimezone : undefined,
    requestedWindow: typeof body.window === 'string' ? body.window : undefined,
    policy: template.guestIntake, createdAt: now, updatedAt: now,
  };
  async function replay() {
    const stored = await getGuestIntakeJob(db, id);
    if (!stored) return null;
    if (stored.fingerprint !== fingerprint) throw new GuestContactInputError('creationKey already belongs to a different Card request', 409, 'creation_key_conflict');
    const card = await getCardConsistent(db, stored.cardId);
    if (!card) throw new Error('Saved guest intake has no Card');
    return { ok: true as const, card, tasks: await listTasksByCardConsistent(db, card.id), template };
  }
  return {
    job, replay,
    marker: { jobId: id, taskId: job.taskId, status: job.status, skipEmail: job.skipEmail, ...(guest.email ? { recipient: guest.email } : {}) },
    title: job.topic || (job.guestName ? `${job.guestName}: ${template.name}` : template.name),
    companions(card: Card): PlannedWrite[] {
      job.cardId = card.id;
      return [putNew(TABLE_ARTIFACTS, guestIntakeKey(id), Object.fromEntries(Object.entries(job).filter(([,v]) => v !== undefined)))];
    },
    tasks(card: Card): Task[] {
      return [{ id: job.taskId, cardId: card.id, version: 1, taskHistory: [], createdAt: now, updatedAt: now,
        date: berlinToday(), status: 'todo', source: 'guest-event-intake', ...(intakeAssigneeId ? { assigneeId: intakeAssigneeId } : {}),
        description: guest.email ? 'Prepare and send the guest invitation' : 'Add the guest contact email',
        instructionDocId: 'system.programs-and-community.shared-event-operations',
        comment: guest.email ? 'Invitation preparation is queued automatically after Card creation.' : 'The selected guest has no saved email. Add a verified contact email before sending.',
      }];
    },
  };
}
