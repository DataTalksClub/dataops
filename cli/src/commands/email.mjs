import { UsageError } from '../errors.mjs';
import { optionalString, positional } from '../format.mjs';
import { apiFor } from '../session.mjs';

export const summary = 'Send a rendered private knowledge email template from Orin';

export const help = `dataops email - send a private knowledge email template

Usage
  dataops email send-template <template-id> --section "Template heading" --recipient EMAIL --task TASK-ID
      [--recipient-name NAME] [--subject-variant LABEL] [--value KEY=VALUE ...]

Values replace uppercase placeholders in the selected KB template section. The
sender and CC are fixed by DataOps, each send starts a new Gmail thread, and the
Gmail message ID is written to the owning task.
`;

function valuesFromArgs(raw) {
  const values = {};
  for (const entry of Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]) {
    if (typeof entry !== 'string') throw new UsageError('--value must use KEY=VALUE.');
    const separator = entry.indexOf('=');
    if (separator < 1) throw new UsageError('--value must use KEY=VALUE.');
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1);
    if (!/^[A-Z][A-Z0-9_-]{0,63}$/.test(key) || key === 'SENDER_NAME' || key === 'RECIPIENT_NAME') {
      throw new UsageError('--value keys must be uppercase template placeholders; sender and recipient names are supplied separately.');
    }
    values[key] = value;
  }
  return values;
}

export async function sendTemplate(args, io) {
  const templateId = positional(args, 0, 'dataops email send-template <template-id>');
  const sectionHeading = optionalString(args, 'section');
  const recipientEmail = optionalString(args, 'recipient');
  const taskId = optionalString(args, 'task');
  if (!sectionHeading) throw new UsageError('--section is required.');
  if (!recipientEmail) throw new UsageError('--recipient is required.');
  if (!taskId) throw new UsageError('--task is required.');
  const payload = {
    templateId,
    sectionHeading,
    recipientEmail,
    taskId,
    values: valuesFromArgs(args.value),
  };
  const recipientName = optionalString(args, 'recipientName');
  if (recipientName !== undefined) payload.recipientName = recipientName;
  const subjectVariant = optionalString(args, 'subjectVariant');
  if (subjectVariant !== undefined) payload.subjectVariant = subjectVariant;

  const result = await apiFor(args).post('/api/email-templates/send', payload);
  if (args.json) return result;
  const delivery = result.emailDelivery || {};
  if (delivery.state === 'sent') {
    io.print(`Sent ${delivery.templateId || templateId} email from ${delivery.from} to ${delivery.to} (Gmail message ${delivery.messageId}).`);
  } else {
    io.print(`Email delivery (${delivery.from || 'orin@datatalks.club'}): ${delivery.state || 'unknown'} (${delivery.reason || delivery.code || 'deferred'}) — ${delivery.message || ''}`);
  }
  return result;
}

export const commands = { 'send-template': sendTemplate };
