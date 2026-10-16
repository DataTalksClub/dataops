/**
 * One-off migration: every sponsor deal's stored `nextAction` becomes an open
 * Task about the deal (no Card), and the deal loses the field.
 *
 * `POST /api/admin/sponsor-next-action-tasks` with `{ "apply": false }` reports
 * the plan; `{ "apply": true }` writes it. `overrides` maps a deal id to the
 * `description` and/or `date` its Task should get instead of the stored note,
 * for next actions that were placeholders. The Task id is derived from the
 * deal, so a rerun never makes a second Task. Admin only.
 * Delete this file and its router line once the migration has run.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getCrmRecord, listCrmRecords, updateDealAtomic, type CrmRecord } from '../db/sponsorCrm';
import { createTask, getTask } from '../db/tasks';
import { resolveDefaultAssigneeId } from '../db/workspaceSettings';
import { resolveInteractiveActor, workAdminForbidden } from '../identity/actor';
import { TeamDirectory } from '../identity/directory';
import type { LambdaEvent, LambdaResponse } from '../types';

const ROUTE = '/api/admin/sponsor-next-action-tasks';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function json(statusCode: number, body: unknown): LambdaResponse {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

type NextAction = { type?: unknown; due?: unknown; owner?: unknown; note?: unknown };
type Override = { description?: string; date?: string };

export const nextActionTaskId = (dealId: string) => `sponsor-next-action-${dealId}`;

function humanize(type: unknown): string {
  const text = String(type || 'follow_up').replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function parseOverrides(value: unknown): Record<string, Override> | string {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'overrides must map deal ids to {description, date}';
  const overrides: Record<string, Override> = {};
  for (const [dealId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `override for ${dealId} must be an object`;
    const { description, date } = raw as Record<string, unknown>;
    if (description !== undefined && (typeof description !== 'string' || !description.trim() || description.length > 500)) {
      return `override description for ${dealId} must be 1-500 characters`;
    }
    if (date !== undefined && (typeof date !== 'string' || !DATE.test(date))) return `override date for ${dealId} must be YYYY-MM-DD`;
    overrides[dealId] = {
      ...(typeof description === 'string' ? { description: description.trim() } : {}),
      ...(typeof date === 'string' ? { date } : {}),
    };
  }
  return overrides;
}

async function planDeal(deal: CrmRecord, override: Override | undefined, directory: TeamDirectory, defaultAssigneeId: string | null) {
  const action = deal.nextAction as NextAction;
  const owner = typeof action.owner === 'string' ? action.owner : '';
  const ownerActive = owner ? (await directory.project(owner)).active : false;
  const note = typeof action.note === 'string' ? action.note.trim() : '';
  const due = typeof action.due === 'string' && DATE.test(action.due) ? action.due : new Date().toISOString().slice(0, 10);
  const assigneeId = ownerActive ? owner : defaultAssigneeId || undefined;
  return {
    dealId: deal.id,
    dealVersion: deal.version,
    status: String(deal.status || ''),
    nextAction: action,
    overridden: Boolean(override),
    task: {
      id: nextActionTaskId(deal.id),
      description: override?.description || note || humanize(action.type),
      date: override?.date || due,
      ...(assigneeId ? { assigneeId } : {}),
      subject: { type: 'sponsor-deal' as const, id: deal.id },
    },
    assignee: ownerActive ? 'stored owner' : assigneeId ? 'default assignee' : 'unassigned',
  };
}

export async function handleSponsorNextActionTasksMigration(
  path: string,
  method: string,
  rawBody: string | null,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  if (path !== ROUTE) return null;
  if (method !== 'POST') return json(405, { error: 'Method not allowed' });
  const resolution = await resolveInteractiveActor(client, event, 'work-write');
  if (!resolution.ok) return resolution.response;
  if (!resolution.actor.isAdmin) return workAdminForbidden('The sponsor next action migration requires an admin');
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }
  if (typeof body.apply !== 'boolean') return json(400, { error: 'apply must be a boolean' });
  const overrides = parseOverrides(body.overrides);
  if (typeof overrides === 'string') return json(400, { error: overrides });

  const deals = (await listCrmRecords(client, 'deal'))
    .filter((deal) => deal.nextAction && typeof deal.nextAction === 'object')
    .sort((left, right) => left.id.localeCompare(right.id));
  const unknownOverrides = Object.keys(overrides).filter((dealId) => !deals.some((deal) => deal.id === dealId));
  if (unknownOverrides.length > 0) return json(400, { error: 'Overrides name deals without a next action', unknownOverrides });

  const directory = new TeamDirectory(client);
  const defaultAssigneeId = await resolveDefaultAssigneeId(client);
  const plans = [];
  for (const deal of deals) plans.push(await planDeal(deal, overrides[deal.id], directory, defaultAssigneeId));
  if (!body.apply) return json(200, { apply: false, dealCount: deals.length, plans });

  const actorId = resolution.actor.id || 'system:sponsor-next-action-migration';
  const results = [];
  for (const plan of plans) {
    try {
      const existing = await getTask(client, plan.task.id);
      if (!existing) await createTask(client, { ...plan.task, status: 'todo', source: 'manual', createdBy: actorId }, { actorId });
      const current = await getCrmRecord(client, 'deal', plan.dealId);
      if (current?.nextAction) await updateDealAtomic(client, current, { nextAction: undefined }, actorId);
      results.push({ dealId: plan.dealId, taskId: plan.task.id, status: existing ? 'task-existed' : 'applied' });
    } catch (error) {
      results.push({ dealId: plan.dealId, taskId: plan.task.id, status: 'failed', error: (error as Error).name });
    }
  }
  return json(results.some(({ status }) => status === 'failed') ? 207 : 200, { apply: true, dealCount: deals.length, plans, results });
}
