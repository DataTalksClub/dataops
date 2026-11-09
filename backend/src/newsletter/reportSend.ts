/**
 * `dataops newsletter report --send`: reply to the sponsor in the Gmail thread
 * of the booking's `email-sponsor` send, from Orin's mailbox, then close the
 * slot's `send-performance-to-sponsor` Task with the Gmail message id. The
 * route comes only from the booking; a missing route stops the send.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import type { NewsletterIssue, NewsletterSlotPosition } from '../db/newsletterIssues';
import { getTaskConsistent, listTasksByCardConsistent, updateTask } from '../db/tasks';
import { deliverRenderedEmail, SPONSOR_DOC_EMAIL_FROM } from '../sponsorDocs/emailDelivery';
import { buildSponsorStatsReport } from './statsReport';
import { requireSponsorRoute, ROUTE_SEND_TASK_REFS, SponsorRouteError } from './sponsorRoute';

export class ReportSendError extends Error {
  constructor(readonly statusCode: number, message: string, readonly code: string, readonly detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ReportSendError';
  }
}

export async function sendIssueReport(
  client: DynamoDBDocumentClient,
  issue: NewsletterIssue,
  options: { slot: NewsletterSlotPosition; contactName: string; actorId: string },
) {
  const { slot: position, contactName, actorId } = options;
  const where = `The ${position} slot of ${issue.id}`;
  const slot = issue.slots?.[position];
  if (!slot?.sponsor) throw new ReportSendError(422, `${where} has no booked sponsor`, 'slot_not_booked');
  if (!contactName.trim()) throw new ReportSendError(400, 'contactName is required to send the report', 'contact_required');
  const report = buildSponsorStatsReport(issue, position, { contactName });
  if (!report.recordedAt) throw new ReportSendError(422, `${where} has no recorded stats; record them before sending the report`, 'stats_missing');

  let route;
  try {
    route = requireSponsorRoute(slot.route, where);
  } catch (error) {
    if (error instanceof SponsorRouteError) throw new ReportSendError(422, error.message, 'sponsor_route_missing');
    throw error;
  }
  if (route.sender !== SPONSOR_DOC_EMAIL_FROM) {
    throw new ReportSendError(422, `${where} route sender is ${route.sender}; reports are sent from ${SPONSOR_DOC_EMAIL_FROM}`, 'sponsor_route_sender');
  }
  if (!issue.cardId) throw new ReportSendError(422, `${issue.id} has no Card, so there is no send task to close`, 'no_card');
  const ref = ROUTE_SEND_TASK_REFS[position][0];
  const task = (await listTasksByCardConsistent(client, issue.cardId)).find((item) => item.templateTaskRef === ref);
  if (!task) throw new ReportSendError(422, `Card ${issue.cardId} has no ${ref} task`, 'send_task_missing');
  if (task.status === 'done') throw new ReportSendError(409, `Task ${task.id} (${ref}) is already done; the report was not sent again`, 'already_sent');

  const delivery = await deliverRenderedEmail(client, {
    draft: { subject: 'Newsletter performance', body: report.message },
    recipientEmail: route.to,
    taskId: task.id,
    cc: route.cc,
    threadId: route.threadRef,
  });
  if (delivery.state !== 'sent' || !delivery.messageId) {
    console.error(JSON.stringify({ level: 'ERROR', message: 'sponsor report not sent', issueId: issue.id, slot: position, reason: delivery.reason, detail: delivery.message }));
    throw new ReportSendError(502, delivery.message || `The report was not sent (${delivery.reason || delivery.state})`, delivery.reason || 'not_sent', { emailDelivery: delivery });
  }

  const current = await getTaskConsistent(client, task.id);
  if (!current) throw new ReportSendError(500, `Task ${task.id} vanished after the report was sent (Gmail message ${delivery.messageId})`, 'task_missing', { emailDelivery: delivery });
  const now = new Date().toISOString();
  const comment = `Sponsor report sent in thread ${route.threadRef} to ${route.to} (Gmail message ID: ${delivery.messageId})`;
  try {
    await updateTask(client, current.id, {
      currentTask: current,
      expectedVersion: current.version,
      actorId,
      triggerKind: 'sponsor-report-sent',
      patch: { status: 'done', completedAt: now, completedBy: actorId, comment, externalStatus: `Gmail message ${delivery.messageId}` },
    });
  } catch (error) {
    console.error(JSON.stringify({ level: 'ERROR', message: 'sponsor report sent but task not closed', taskId: task.id, gmailMessageId: delivery.messageId, reason: (error as Error).message }));
    throw new ReportSendError(500, `The report was sent (Gmail message ${delivery.messageId}) but Task ${task.id} was not closed: ${(error as Error).message}`, 'task_not_closed', { emailDelivery: delivery });
  }
  return { emailDelivery: delivery, taskId: task.id, route };
}
