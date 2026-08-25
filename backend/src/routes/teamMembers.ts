/**
 * `GET /api/team-members` — the safe work directory.
 *
 * This is the projection routine work views use to label an assignee, a Card
 * owner, or a history actor. `GET /api/users` stays reserved for the
 * Admin/Users account surface because it carries email and other account
 * fields that work views must not load.
 */

import { getClient } from '../db/client';
import { resolveInteractiveActor } from '../identity/actor';
import { TeamDirectory } from '../identity/directory';
import type { LambdaEvent, LambdaResponse } from '../types';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

function json(statusCode: number, body: unknown): LambdaResponse {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

export async function handleTeamMemberRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
): Promise<LambdaResponse | null> {
  if (path !== '/api/team-members' && path !== '/api/team-members/') return null;
  if (method !== 'GET') return json(405, { error: 'Method not allowed' });

  const client = await getClient();
  const resolution = await resolveInteractiveActor(client, event, 'team-read');
  if (!resolution.ok) return resolution.response;

  const directory = new TeamDirectory(client);
  return json(200, { teamMembers: await directory.members() });
}
