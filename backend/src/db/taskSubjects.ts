import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import type { Task, TaskSubject, TaskSubjectType } from '../types';
import { getTuitionAgreement } from './tuition';
import { getCrmRecord } from './sponsorCrm';
import { listTasksByStatus } from './tasks';

/**
 * A Task's subject: the sponsor relationship or tuition agreement, for a Task
 * that belongs to no Card. A Task has a Card or a subject, never both.
 */

const SUBJECT_KINDS: Record<TaskSubjectType, string> = {
  'sponsor-deal': 'deal',
  'sponsor-company': 'organization',
  'sponsor-person': 'contact',
  'tuition-agreement': 'tuition',
};
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type ProjectedTaskSubject = TaskSubject & { label: string; href: string };

function isSubjectType(value: unknown): value is TaskSubjectType {
  return typeof value === 'string' && Object.hasOwn(SUBJECT_KINDS, value);
}

function subjectHref(subject: TaskSubject): string {
  if (subject.type === 'tuition-agreement') return `/bookkeeping?view=tuition&agreement=${encodeURIComponent(subject.id)}`;
  if (subject.type === 'sponsor-person') return `/sponsors/people?search=${encodeURIComponent(subject.id)}`;
  const family = subject.type === 'sponsor-deal' ? 'deals' : 'companies';
  return `/sponsors/${family}/${encodeURIComponent(subject.id)}`;
}

/**
 * Normalize a subject to its stored shape. The referenced record must exist
 * and be active where the domain supports archiving.
 */
export async function parseTaskSubject(
  client: DynamoDBDocumentClient,
  value: unknown,
): Promise<{ subject: TaskSubject } | { error: string; statusCode: number }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'subject must be an object with type and id', statusCode: 400 };
  }
  const { type, id } = value as Record<string, unknown>;
  if (!isSubjectType(type)) {
    return { error: `subject.type must be one of: ${Object.keys(SUBJECT_KINDS).join(', ')}`, statusCode: 400 };
  }
  if (typeof id !== 'string' || !ID.test(id)) return { error: 'subject.id must be a record id', statusCode: 400 };
  const record = type === 'tuition-agreement' ? await getTuitionAgreement(client, id) : await getCrmRecord(client, SUBJECT_KINDS[type], id);
  if (!record || ('archivedAt' in record && record.archivedAt)) return { error: `subject ${type} ${id} not found`, statusCode: 404 };
  return { subject: { type, id } };
}

/** Add each subject's display label and portal path to the Tasks that have one. */
export async function attachSubjects<T extends Task>(client: DynamoDBDocumentClient, tasks: T[]): Promise<T[]> {
  const records = new Map<string, Promise<Record<string, unknown> | null>>();
  const load = (kind: string, id: string) => {
    const key = `${kind}#${id}`;
    if (!records.has(key)) records.set(key, getCrmRecord(client, kind, id));
    return records.get(key)!;
  };
  const companyName = async (id: unknown) => {
    const company = typeof id === 'string' && id ? await load('organization', id) : null;
    return company ? String(company.displayName || '') : '';
  };
  return Promise.all(tasks.map(async (task) => {
    const subject = task.subject;
    if (!subject || !isSubjectType(subject.type)) return task;
    let label = '';
    if (subject.type === 'tuition-agreement') {
      const agreement = await getTuitionAgreement(client, subject.id);
      label = agreement ? `${agreement.studentName} · ${agreement.title}` : 'Tuition agreement';
    } else if (subject.type === 'sponsor-company') {
      label = await companyName(subject.id);
    } else if (subject.type === 'sponsor-person') {
      const contact = await load('contact', subject.id);
      label = contact ? String(contact.name || '') : 'Person';
    } else {
      const deal = await load('deal', subject.id);
      label = deal ? await companyName(deal.organizationId) : '';
    }
    const projected: ProjectedTaskSubject = {
      type: subject.type,
      id: subject.id,
      label: label || (subject.type === 'sponsor-deal' ? 'Sponsor deal' : subject.type === 'sponsor-person' ? 'Person' : 'Sponsor'),
      href: subjectHref(subject),
    };
    return { ...task, subject: projected };
  }));
}

/** Open Tasks (todo or waiting) about sponsor deals, grouped by deal id, earliest date first. */
export async function listOpenDealTasks(client: DynamoDBDocumentClient): Promise<Map<string, Task[]>> {
  const open = [
    ...await listTasksByStatus(client, 'todo'),
    ...await listTasksByStatus(client, 'waiting'),
  ];
  const byDeal = new Map<string, Task[]>();
  for (const task of open) {
    if (task.subject?.type !== 'sponsor-deal') continue;
    const list = byDeal.get(task.subject.id) || [];
    list.push(task);
    byDeal.set(task.subject.id, list);
  }
  for (const list of byDeal.values()) list.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.id.localeCompare(b.id));
  return byDeal;
}
