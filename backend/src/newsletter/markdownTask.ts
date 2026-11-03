/**
 * The stand-alone newsletter Markdown step.
 *
 * The `newsletter-standalone` Template carries a step along the lines of
 * "Prepare and store standalone newsletter Markdown": write the issue text
 * and store it with `PUT /api/newsletter-issues/:id/markdown`. When the
 * sponsor supplies the text themselves (e.g. a Snowplow stand-alone whose
 * copy was written by the sponsor and scheduled straight in Mailchimp),
 * that step has nothing to do and must not sit open in the today/overdue
 * queue. The Template lives in the private knowledge repository, so this
 * module is the runtime mechanism, not a Template edit:
 *
 * - a Card tagged `sponsor-written` means the sponsor supplied the text;
 *   the step is skipped with that reason;
 * - a stand-alone issue already `scheduled` or `sent` in Mailchimp is past
 *   the point of preparing Markdown; the step is skipped with that reason;
 * - stored issue Markdown (`issue.markdown.issue`) is the step's own
 *   completion proof; the step is marked done.
 *
 * Done and skipped Tasks both leave the overdue queue (only `todo`/`waiting`
 * Tasks are ever overdue). The step is matched by its Markdown description,
 * not by a Template ref: the authored ref is private-repo data this package
 * cannot name. Never fails the calling write: sync problems are logged and
 * reported as `open`, like the metrics auto-close in
 * `routes/newsletterIssues.ts`.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getCardConsistent } from '../db/cards';
import type { NewsletterIssue } from '../db/newsletterIssues';
import { listTasksByCardConsistent, updateTask } from '../db/tasks';
import type { Card, Task } from '../types';

/** Card tag marking a stand-alone Card whose text the sponsor supplied. */
export const SPONSOR_WRITTEN_TAG = 'sponsor-written';

/**
 * The Template step this module resolves, matched case-insensitively: the
 * authored description is private-repo data ("Prepare and store standalone
 * newsletter Markdown"), so the shared word it always carries is the match.
 */
export const STANDALONE_MARKDOWN_STEP_PATTERN = /markdown/i;

/** Issue statuses past the point of preparing Markdown. */
const PAST_MARKDOWN_STATUSES = new Set(['scheduled', 'sent']);

const isOpen = (task: Task) => task.status === 'todo' || task.status === 'waiting';

/** Whether the Card is flagged as sponsor-supplied text. */
export function isSponsorWrittenCard(card: Pick<Card, 'tags'>): boolean {
  return (card.tags || []).some((tag) => String(tag || '').trim().toLowerCase() === SPONSOR_WRITTEN_TAG);
}

/** An open Task of the Markdown step, on any Card. */
export function isStandaloneMarkdownTask(task: Task): boolean {
  return isOpen(task) && STANDALONE_MARKDOWN_STEP_PATTERN.test(String(task.description || ''));
}

export type MarkdownTaskSync = 'closed' | 'skipped' | 'open' | 'none';

/**
 * Resolve the stand-alone issue Card's open Markdown steps: mark them done
 * when issue Markdown is stored, skip them when the sponsor supplied the
 * text (the `sponsor-written` Card tag) or the issue is already scheduled
 * or sent. Non-stand-alone issues and issues without a Card are untouched.
 */
export async function syncStandaloneMarkdownTask(
  client: DynamoDBDocumentClient,
  issue: NewsletterIssue,
  actorId: string,
): Promise<MarkdownTaskSync> {
  if (issue.kind !== 'standalone' || !issue.cardId) return 'none';
  try {
    const card = await getCardConsistent(client, issue.cardId);
    if (!card) return 'none';
    const open = (await listTasksByCardConsistent(client, card.id)).filter(isStandaloneMarkdownTask);
    if (!open.length) return 'none';
    const now = new Date().toISOString();
    if (String(issue.markdown?.issue || '').trim()) {
      for (const task of open) {
        await updateTask(client, task.id, {
          expectedVersion: task.version,
          currentTask: task,
          actorId,
          triggerKind: 'newsletter-markdown-stored',
          patch: {
            status: 'done',
            externalStatus: `Newsletter Markdown stored in DataOps${issue.status ? ` (issue ${issue.status})` : ''}`,
            completedBy: actorId,
            completedAt: now,
          },
        });
      }
      return 'closed';
    }
    const skipReason = isSponsorWrittenCard(card)
      ? 'Sponsor supplied the text; Markdown step not needed (card tagged sponsor-written)'
      : PAST_MARKDOWN_STATUSES.has(String(issue.status || '').toLowerCase())
        ? `Issue ${issue.status}; sponsor-supplied text already scheduled, Markdown step not needed`
        : null;
    if (!skipReason) return 'open';
    for (const task of open) {
      await updateTask(client, task.id, {
        expectedVersion: task.version,
        currentTask: task,
        actorId,
        triggerKind: 'newsletter-markdown-skipped',
        patch: {
          status: 'skipped',
          skipReason,
          skippedAt: now,
          skippedBy: actorId,
        },
      });
    }
    return 'skipped';
  } catch (failure) {
    console.error('Newsletter Markdown step sync failed:', failure);
    return 'open';
  }
}
