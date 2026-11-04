import { randomUUID } from 'node:crypto';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { resolveInteractiveActor } from '../identity/actor';
import { getTaskConsistent, TaskVersionConflictError, updateTask } from '../db/tasks';
import {
  deliverRenderedEmail,
  SPONSOR_DOC_EMAIL_CC,
  SPONSOR_DOC_EMAIL_FROM,
  type SponsorDocEmailDelivery,
} from '../sponsorDocs/emailDelivery';
import {
  KnowledgeEmailTemplateError,
  loadKnowledgeEmailTemplate,
  renderKnowledgeEmailTemplate,
  type KnowledgeEmailTemplate,
  type RenderedKnowledgeEmail,
} from '../sponsorDocs/knowledgeEmailTemplate';
import { noStoreJson, parseJsonObjectEventOrEmpty } from '../http';
import type { LambdaEvent, LambdaResponse } from '../types';

const SEND_PATH = '/api/email-templates/send';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emailTemplateValues(raw: unknown, recipientName: string): Record<string, string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Z][A-Z0-9_-]{0,63}$/.test(key) || key === 'SENDER_NAME' || key === 'RECIPIENT_NAME') return null;
    if (typeof value !== 'string' || value.length > 10000) return null;
    values[key] = value;
  }
  values.SENDER_NAME = 'Orin';
  if (recipientName) values.RECIPIENT_NAME = recipientName;
  return values;
}

async function recordEmailOnTask(
  client: DynamoDBDocumentClient,
  taskId: string,
  templateId: string,
  delivery: SponsorDocEmailDelivery,
): Promise<void> {
  if (delivery.state !== 'sent' || !delivery.messageId) return;
  const noteText = `Templated email sent (${templateId}; Gmail message ID: ${delivery.messageId})`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const task = await getTaskConsistent(client, taskId);
    if (!task) throw new Error(`Task ${taskId} not found after email send`);
    if ((task.notesLog || []).some((note) => note.text === noteText)) return;
    const now = new Date().toISOString();
    try {
      await updateTask(client, task.id, {
        currentTask: task,
        expectedVersion: task.version,
        patch: {
          notesLog: [...(task.notesLog || []), {
            id: randomUUID(),
            text: noteText,
            authorId: 'system:templated-email',
            createdAt: now,
          }],
        },
        historyEvents: [{
          id: randomUUID(),
          taskId: task.id,
          ...(task.cardId ? { cardId: task.cardId } : {}),
          action: 'noted',
          actorId: 'system:templated-email',
          note: noteText,
          createdAt: now,
        }],
        actorId: 'system:templated-email',
        triggerKind: 'templated-email-sent',
      });
      return;
    } catch (error) {
      if (!(error instanceof TaskVersionConflictError) || attempt === 2) throw error;
    }
  }
}

export async function handleEmailTemplateRoutes(
  reqPath: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  if (reqPath !== SEND_PATH) return null;
  if (method.toUpperCase() !== 'POST') return noStoreJson(405, { error: 'Method not allowed' });
  const actor = await resolveInteractiveActor(client, event, 'work-write');
  if (!actor.ok) return actor.response;

  const body = parseJsonObjectEventOrEmpty(event);
  if (!body) return noStoreJson(400, { error: 'Invalid JSON body' });
  const templateId = typeof body.templateId === 'string' ? body.templateId.trim() : '';
  const sectionHeading = typeof body.sectionHeading === 'string' ? body.sectionHeading.trim() : '';
  const recipientEmail = typeof body.recipientEmail === 'string' ? body.recipientEmail.trim().toLowerCase() : '';
  const recipientName = typeof body.recipientName === 'string' ? body.recipientName.trim() : '';
  const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
  const subjectVariant = typeof body.subjectVariant === 'string' ? body.subjectVariant.trim() : undefined;

  if (!/^[a-z0-9][a-z0-9._-]{1,127}$/.test(templateId)) return noStoreJson(400, { error: 'A valid templateId is required' });
  if (!sectionHeading || sectionHeading.length > 200 || /[\r\n\x00-\x1f]/.test(sectionHeading)) {
    return noStoreJson(400, { error: 'A valid sectionHeading is required' });
  }
  if (subjectVariant && (subjectVariant.length > 100 || /[\r\n\x00-\x1f]/.test(subjectVariant))) {
    return noStoreJson(400, { error: 'Invalid subjectVariant' });
  }
  if (!EMAIL.test(recipientEmail)) return noStoreJson(400, { error: 'A valid recipientEmail is required' });
  if (recipientEmail === 'grace@datatalks.club') {
    return noStoreJson(422, { error: 'Emails are never sent to grace@datatalks.club', code: 'blocked_recipient' });
  }
  if (!taskId || taskId.length > 128) return noStoreJson(400, { error: 'An owning taskId is required' });
  const values = emailTemplateValues(body.values, recipientName);
  if (!values) return noStoreJson(400, { error: 'values must map uppercase placeholder names to strings; sender and recipient names are server-owned' });

  const task = await getTaskConsistent(client, taskId);
  if (!task) return noStoreJson(404, { error: `Task ${taskId} not found` });

  let template: KnowledgeEmailTemplate;
  try {
    template = await loadKnowledgeEmailTemplate(templateId);
  } catch (error) {
    if (error instanceof KnowledgeEmailTemplateError) return noStoreJson(404, { error: error.message, code: 'email_template_not_found' });
    return noStoreJson(503, { error: 'The private knowledge template is unavailable', code: 'email_template_unavailable' });
  }

  let draft: RenderedKnowledgeEmail;
  try {
    draft = renderKnowledgeEmailTemplate(template, { sectionHeading, subjectVariant, values });
  } catch (error) {
    if (error instanceof KnowledgeEmailTemplateError) return noStoreJson(422, { error: error.message, code: 'email_template_render_failed' });
    throw error;
  }

  const emailDelivery = await deliverRenderedEmail(client, {
    draft,
    recipientEmail,
    recipientName: recipientName || null,
    taskId,
  });
  const delivery = {
    ...emailDelivery,
    templateId: template.id,
    templateRevision: template.revision,
    ...(emailDelivery.state === 'sent' ? { taskId } : {}),
  };
  if (delivery.state === 'sent') await recordEmailOnTask(client, taskId, template.id, delivery);
  return noStoreJson(200, {
    emailDelivery: delivery,
    sender: SPONSOR_DOC_EMAIL_FROM,
    cc: [SPONSOR_DOC_EMAIL_CC],
  });
}
