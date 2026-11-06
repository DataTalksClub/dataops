import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getTextTemplatesRecord } from '../db/textTemplates';
import { renderTextTemplate } from '../textTemplates/render';
import { PODCAST_FIRST_CONTACT_FROM, formatSlotLabel } from '../podcast/firstContact';
import { APPROVED_GUEST_EVENT_TYPES } from './guestIntakePolicy';

export interface GuestFirstContactInput {
  type: string; templateId: string; guestName?: string; topic?: string;
  startIso: string; guestTimezone?: string; formUrl: string; accessCode: string;
}
export function guestFirstContactValues(input: GuestFirstContactInput): Record<string, string> {
  if (!APPROVED_GUEST_EVENT_TYPES.has(input.type)) throw new Error('This event type has no enabled guest invitation');
  const firstName = input.guestName?.trim().split(/\s+/)[0] || '';
  const topic = input.topic?.trim() || '';
  for (const value of [firstName, topic, input.accessCode]) if (/[\r\n]/.test(value)) throw new Error('Invitation values must be single-line');
  if (!input.accessCode || !/^https:\/\//.test(input.formUrl)) throw new Error('A guest form URL and access code are required');
  const instant = new Date(input.startIso);
  if (!Number.isFinite(instant.getTime())) throw new Error('A saved proposal instant is required');
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(instant).replace(',', '');
  let time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' }).format(instant);
  if (input.guestTimezone && input.guestTimezone !== 'Europe/Berlin') time += ` (${formatSlotLabel(input.startIso, input.guestTimezone)} in ${input.guestTimezone})`;
  return { GREETING: firstName ? `Hi ${firstName},` : 'Hi,', FIRST_NAME_SUBJECT_PREFIX: firstName ? `${firstName} at ` : '',
    TOPIC_CLAUSE: topic ? `${input.type === 'workshop' ? ' on ' : ' to discuss '}${topic}` : '',
    WEEKDAY_DATE: date, TIME_TIMEZONE: time, GUEST_FORM_URL: input.formUrl, ACCESS_CODE: input.accessCode,
    FIRST_NAME: firstName, TOPIC: topic };
}
export function renderGuestFirstContact(template: string, input: GuestFirstContactInput) {
  const rendered = renderTextTemplate(template, guestFirstContactValues(input));
  if (rendered.missing.length) throw new Error(`Invitation template is missing values: ${rendered.missing.join(', ')}`);
  const match = /^Subject: ([^\r\n]+)\r?\n\r?\n([\s\S]+)$/.exec(rendered.text);
  if (!match || !match[1].trim() || !match[2].trim()) throw new Error('Invitation template must contain Subject: followed by a blank line and body');
  return { from: PODCAST_FIRST_CONTACT_FROM, subject: match[1], body: match[2].replace(/\r\n/g, '\n').replace(/\n$/, ''), formUrl: input.formUrl, topicSeed: input.topic || '', accessCode: input.accessCode };
}
export async function loadGuestFirstContact(db: DynamoDBDocumentClient, input: GuestFirstContactInput) {
  const record = await getTextTemplatesRecord(db);
  const item = record.templates.find(t => t.id === input.templateId);
  if (!item) throw new Error(`Invitation text template ${input.templateId} is not configured`);
  return { ...renderGuestFirstContact(item.body, input), templateId: item.id, templateUpdatedAt: item.updatedAt };
}
