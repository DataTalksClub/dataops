/**
 * `GET /api/team-members` — the safe work directory.
 *
 * This is the projection routine work views use to label an assignee, a Card
 * owner, or a history actor. `GET /api/users` stays reserved for the
 * Admin/Users account surface because it carries email and other account
 * fields that work views must not load.
 *
 * The directory also names the workspace default assignee, which an admin
 * changes with `PUT /api/team-members/default-assignee`.
 */

import { getClient } from '../db/client';
import {
  getWorkspaceSettings,
  setDefaultAssignee,
  WorkspaceSettingsConflictError,
} from '../db/workspaceSettings';
import { resolveInteractiveActor, workAdminForbidden } from '../identity/actor';
import { TeamDirectory } from '../identity/directory';
import type { LambdaEvent, LambdaResponse } from '../types';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };
const DEFAULT_ASSIGNEE_PATH = '/api/team-members/default-assignee';

function json(statusCode: number, body: unknown): LambdaResponse {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function parseBody(event: LambdaEvent): Record<string, unknown> | null {
  if (!event.body) return null;
  if (typeof event.body === 'object') return event.body as Record<string, unknown>;
  try {
    const parsed = JSON.parse(event.body);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function handleTeamMemberRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
): Promise<LambdaResponse | null> {
  const isDirectory = path === '/api/team-members' || path === '/api/team-members/';
  if (!isDirectory && path !== DEFAULT_ASSIGNEE_PATH) return null;
  if (isDirectory && method !== 'GET') return json(405, { error: 'Method not allowed' });
  if (!isDirectory && method !== 'GET' && method !== 'PUT') return json(405, { error: 'Method not allowed' });

  const client = await getClient();
  const resolution = await resolveInteractiveActor(client, event, 'team-read');
  if (!resolution.ok) return resolution.response;

  if (isDirectory) {
    const directory = new TeamDirectory(client);
    const settings = await getWorkspaceSettings(client);
    return json(200, {
      teamMembers: await directory.members(),
      defaultAssigneeId: settings.defaultAssigneeId,
    });
  }

  if (method === 'GET') return json(200, await getWorkspaceSettings(client));

  const actor = resolution.actor;
  if (!actor.isAdmin) return workAdminForbidden('Changing the default assignee requires an admin');
  const body = parseBody(event);
  if (!body) return json(400, { error: 'Request body is required' });
  const expectedVersion = body.expectedVersion;
  if (!Number.isInteger(expectedVersion) || Number(expectedVersion) < 0) {
    return json(400, { error: 'expectedVersion must be the settings version you read (0 before the first save)' });
  }
  if (!Object.hasOwn(body, 'defaultAssigneeId')) {
    return json(400, { error: 'defaultAssigneeId is required (a team member id, or null to clear it)' });
  }
  const requested = body.defaultAssigneeId;
  if (requested !== null && (typeof requested !== 'string' || !requested.trim())) {
    return json(400, { error: 'defaultAssigneeId must be a team member id or null' });
  }
  const defaultAssigneeId = requested === null ? null : String(requested).trim();
  if (defaultAssigneeId && !(await new TeamDirectory(client).project(defaultAssigneeId)).active) {
    return json(400, { error: 'defaultAssigneeId must reference an active team member' });
  }

  try {
    return json(200, await setDefaultAssignee(client, {
      defaultAssigneeId,
      expectedVersion: Number(expectedVersion),
      actorId: actor.id || undefined,
    }));
  } catch (error) {
    if (error instanceof WorkspaceSettingsConflictError) {
      return json(409, {
        error: 'The default assignee changed since you read it; reload and try again',
        code: 'version_conflict',
        current: await getWorkspaceSettings(client),
      });
    }
    throw error;
  }
}
