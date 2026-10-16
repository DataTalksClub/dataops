/**
 * `/api/workspace-settings`: the admin-set workspace settings.
 *
 * GET returns every setting with its version. PUT changes the settings that
 * have no route of their own; the default assignee keeps
 * `PUT /api/team-members/default-assignee`, which checks the person.
 */

import { getClient } from '../db/client';
import {
  getWorkspaceSettings,
  MAX_NEWSLETTER_CARD_LEAD_DAYS,
  MAX_SPONSOR_MATERIALS_REMINDERS,
  MAX_SPONSOR_SETTING_DAYS,
  updateWorkspaceSettings,
  WorkspaceSettingsConflictError,
  type WorkspaceSettingsChanges,
} from '../db/workspaceSettings';
import { resolveInteractiveActor, workAdminForbidden } from '../identity/actor';
import type { LambdaEvent, LambdaResponse } from '../types';

export const WORKSPACE_SETTINGS_PATH = '/api/workspace-settings';
const EDITABLE = new Set(['newsletterCardLeadDays', 'sponsorMaterialsReminderDays', 'sponsorFollowUpDays']);

const isDayCount = (value: unknown, max: number) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= max;

function json(statusCode: number, body: unknown): LambdaResponse {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function parseBody(event: LambdaEvent): Record<string, unknown> | null {
  if (!event.body) return null;
  try {
    const parsed = typeof event.body === 'object' ? event.body : JSON.parse(String(event.body));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function handleWorkspaceSettingsRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
): Promise<LambdaResponse | null> {
  if (path !== WORKSPACE_SETTINGS_PATH && path !== `${WORKSPACE_SETTINGS_PATH}/`) return null;
  if (method !== 'GET' && method !== 'PUT') return json(405, { error: 'Method not allowed' });
  const client = await getClient();
  const resolution = await resolveInteractiveActor(client, event, 'team-read');
  if (!resolution.ok) return resolution.response;
  if (method === 'GET') return json(200, await getWorkspaceSettings(client));

  if (!resolution.actor.isAdmin) return workAdminForbidden('Changing workspace settings requires an admin');
  const body = parseBody(event);
  if (!body) return json(400, { error: 'Request body is required' });
  const { expectedVersion, ...requested } = body;
  if (!Number.isInteger(expectedVersion) || Number(expectedVersion) < 0) {
    return json(400, { error: 'expectedVersion must be the settings version you read (0 before the first save)' });
  }
  const unknown = Object.keys(requested).find((name) => !EDITABLE.has(name));
  if (unknown) return json(400, { error: `${unknown} is not a setting this route changes` });
  if (!Object.keys(requested).length) return json(400, { error: 'Name a setting to change' });
  const changes: WorkspaceSettingsChanges = {};
  if (Object.hasOwn(requested, 'newsletterCardLeadDays')) {
    const days = requested.newsletterCardLeadDays;
    if (!Number.isInteger(days) || Number(days) < 0 || Number(days) > MAX_NEWSLETTER_CARD_LEAD_DAYS) {
      return json(400, { error: `newsletterCardLeadDays must be a whole number of days from 0 to ${MAX_NEWSLETTER_CARD_LEAD_DAYS}` });
    }
    changes.newsletterCardLeadDays = Number(days);
  }
  if (Object.hasOwn(requested, 'sponsorMaterialsReminderDays')) {
    const days = requested.sponsorMaterialsReminderDays;
    if (
      !Array.isArray(days)
      || days.length > MAX_SPONSOR_MATERIALS_REMINDERS
      || !days.every((day) => isDayCount(day, MAX_SPONSOR_SETTING_DAYS))
    ) {
      return json(400, {
        error: `sponsorMaterialsReminderDays must be a list of at most ${MAX_SPONSOR_MATERIALS_REMINDERS} whole numbers of days from 0 to ${MAX_SPONSOR_SETTING_DAYS}`,
      });
    }
    changes.sponsorMaterialsReminderDays = [...new Set(days.map(Number))].sort((a, b) => b - a);
  }
  if (Object.hasOwn(requested, 'sponsorFollowUpDays')) {
    const days = requested.sponsorFollowUpDays;
    if (!isDayCount(days, MAX_SPONSOR_SETTING_DAYS) || Number(days) < 1) {
      return json(400, { error: `sponsorFollowUpDays must be a whole number of days from 1 to ${MAX_SPONSOR_SETTING_DAYS}` });
    }
    changes.sponsorFollowUpDays = Number(days);
  }
  try {
    return json(200, await updateWorkspaceSettings(client, {
      changes,
      expectedVersion: Number(expectedVersion),
      actorId: resolution.actor.id || undefined,
    }));
  } catch (error) {
    if (error instanceof WorkspaceSettingsConflictError) {
      return json(409, {
        error: 'Workspace settings changed since you read them; reload and try again',
        code: 'version_conflict',
        current: await getWorkspaceSettings(client),
      });
    }
    throw error;
  }
}
