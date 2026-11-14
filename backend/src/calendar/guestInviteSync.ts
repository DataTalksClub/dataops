import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createNotification } from '../db/notifications';
import { listTasksByCardConsistent, updateTask } from '../db/tasks';
import { taskRequiresCalendarInvite } from '../routes/taskValidation';
import {
  createHoldGoogleEvents,
  updateHoldGoogleEvents,
  type HoldGoogleDeps,
  type HoldGoogleEvent,
  type HoldGoogleResult,
} from './holdGoogleSync';
import { GuestInviteValidationError, validateGuestInviteReadback, type GuestInvite } from './guestInvite';

/**
 * The one place a guest invite is written to Google: create or update, then
 * read the event back and validate it against the canonical invite. A deferred
 * write is returned as-is; a synced write that does not read back canonical
 * throws GuestInviteValidationError — never a success.
 */
export async function writeGuestInvite(
  invite: GuestInvite,
  existingEventIds: Record<string, string>,
  deps: HoldGoogleDeps,
  extras: Pick<HoldGoogleEvent, 'extendedProperties' | 'resetAttendeeResponses'> = {},
  options: { validate?: boolean } = {},
): Promise<HoldGoogleResult> {
  const { calendars: _calendars, ...payload } = invite;
  const event: HoldGoogleEvent = { ...payload, ...extras };
  const sync = Object.keys(existingEventIds).length
    ? await updateHoldGoogleEvents(existingEventIds, event, deps)
    : await createHoldGoogleEvents(event, deps);
  if (sync.state !== 'synced' || options.validate === false) return sync;
  // Read back with the calendars the write actually targeted.
  const problems = await validateGuestInviteReadback(invite, sync.eventIds, deps);
  if (problems.length) throw new GuestInviteValidationError(invite.eventKey, problems);
  return sync;
}

/**
 * Loud failure for an invite that did not read back canonical: notify Orin
 * through the DataOps notification path and mark the Card's open invite Tasks
 * failed (a Task comment — there is no separate failed status — keeps them
 * open). Reporting never throws; the caller still throws the validation error.
 */
export async function reportGuestInviteFailure(
  client: DynamoDBDocumentClient,
  error: GuestInviteValidationError,
  context: { cardId?: string; actorId: string },
): Promise<void> {
  try {
    await createNotification(client, {
      type: 'automation-failure',
      message: `Guest calendar invite FAILED validation: ${error.message}`,
      ...(context.cardId ? { cardId: context.cardId } : {}),
      metadata: { guard: 'guest-invite-readback', eventKey: error.eventKey, problems: error.problems, recipient: 'orin' },
    });
  } catch (err) {
    console.error(`Guest invite failure notification failed: ${(err as Error)?.message || 'unknown error'}`);
  }
  if (!context.cardId) return;
  try {
    for (const task of await listTasksByCardConsistent(client, context.cardId)) {
      if (!taskRequiresCalendarInvite(task as unknown as Record<string, unknown>) || !['todo', 'waiting'].includes(task.status)) continue;
      await updateTask(client, task.id, {
        currentTask: task, expectedVersion: task.version, actorId: context.actorId, triggerKind: 'guest-invite-failed',
        patch: { comment: `FAILED: the Google Calendar invite does not match the canonical format (${error.problems.join('; ')}). Fix and re-run before reporting the invite as sent.` },
      });
    }
  } catch (err) {
    console.error(`Guest invite failure task update failed: ${(err as Error)?.message || 'unknown error'}`);
  }
}
