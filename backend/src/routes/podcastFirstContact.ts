/**
 * POST /api/podcast-first-contact/email: render Orin's first-contact email.
 *
 * Pure copy rendering: no hold, no Task, and no Card are created here. The
 * CLI `dataops podcast invite` orchestrates the hold (Google Proposal) and
 * the standalone follow-up Task, then calls this route for the send-ready
 * email the operator sends from Orin's mailbox.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { resolveInteractiveActor } from '../identity/actor';
import type { LambdaEvent, LambdaResponse } from '../types';
import {
  PODCAST_DOCS_URL,
  renderPodcastFirstContactEmail,
} from '../podcast/firstContact';

const json = (statusCode: number, body: unknown): LambdaResponse => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const parse = (event: LambdaEvent): Record<string, unknown> | null => {
  try {
    const value = event.body ? JSON.parse(String(event.body)) : {};
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

export async function handlePodcastFirstContactRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse> {
  if (path !== '/api/podcast-first-contact/email') return json(404, { error: 'Not found' });
  if (method !== 'POST') return json(405, { error: 'Method not allowed' });
  const resolved = await resolveInteractiveActor(client, event, 'work-write');
  if (!resolved.ok) return resolved.response;

  const body = parse(event);
  if (!body) return json(400, { error: 'Invalid JSON' });

  try {
    const email = renderPodcastFirstContactEmail({
      guestFirstName: body.guestFirstName as string,
      slotLabel: body.slotLabel as string,
    });
    return json(200, { ...email, docsPage: PODCAST_DOCS_URL });
  } catch (error) {
    return json(400, { error: (error as Error).message });
  }
}
