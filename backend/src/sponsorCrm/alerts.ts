import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createNotification, dismissNotification, listAllNotifications } from '../db/notifications';
import { listCrmRecords } from '../db/sponsorCrm';

type Rule = { code: string; dueDate: string; message: string };
const dayDiff = (from: string, to: string) => Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
function rulesFor(booking: Record<string, unknown>, today: string): Rule[] {
  if (booking.status === 'cancelled' || booking.status === 'complete') return [];
  const rules: Rule[] = [], publication = String(booking.plannedPublicationDate || ''), deadline = String(booking.materialDeadline || ''), hasMaterials = Array.isArray(booking.artifactUrls) && booking.artifactUrls.length > 0;
  if (booking.status === 'confirmed' && !booking.primaryContactId) rules.push({ code: 'confirmed-missing-primary-contact', dueDate: today, message: 'Confirmed sponsor booking needs a primary contact' });
  if (publication && ['confirmed','materials-pending'].includes(String(booking.status)) && !hasMaterials) {
    const days = dayDiff(today, publication); if ([14,10,3].includes(days)) rules.push({ code: `materials-missing-${days}d`, dueDate: publication, message: `Sponsor booking materials are missing ${days} days before publication` });
  }
  if (deadline && deadline < today && !hasMaterials) rules.push({ code: 'materials-deadline-overdue', dueDate: deadline, message: 'Sponsor booking material deadline is overdue' });
  if (['scheduled','published'].includes(String(booking.status)) && (!booking.bundleId || !booking.requiredLinkUrl)) rules.push({ code: 'newsletter-workflow-incomplete', dueDate: publication || today, message: 'Sponsor booking is missing its newsletter workflow or required link' });
  if (booking.status === 'published' && publication && dayDiff(publication, today) >= 7) rules.push({ code: 'performance-follow-up-due', dueDate: publication, message: 'Sponsor booking performance follow-up is due' });
  return rules;
}

export async function evaluateSponsorBookingAlerts(client: DynamoDBDocumentClient, today = new Date().toISOString().slice(0,10)) {
  const bookings = await listCrmRecords(client, 'booking'), existing = await listAllNotifications(client), active = new Set<string>(), created: string[] = [];
  for (const booking of bookings) for (const rule of rulesFor(booking, today)) {
    const fingerprint = `${booking.id}#${rule.code}#${rule.dueDate}`; active.add(fingerprint);
    const found = existing.find(item => !item.dismissed && (item.metadata as any)?.sponsorAlertFingerprint === fingerprint);
    if (!found) { const notification = await createNotification(client, { type: 'follow-up-due', message: rule.message, dueAt: rule.dueDate, metadata: { sponsorBookingId: booking.id, sponsorAlertRule: rule.code, sponsorAlertFingerprint: fingerprint, href: `#/sponsors?bookingId=${encodeURIComponent(booking.id)}` } }); created.push(notification.id); }
  }
  let resolved = 0;
  for (const notification of existing) { const fingerprint = (notification.metadata as any)?.sponsorAlertFingerprint; if (fingerprint && !notification.dismissed && !active.has(fingerprint)) { await dismissNotification(client, notification.id); resolved++; } }
  return { created, resolved };
}
