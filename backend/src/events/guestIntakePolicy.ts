import { PODCAST_GUEST_OBSERVER_CC, normalizePodcastGuestCc } from '../podcast/firstContact';

export const APPROVED_GUEST_EVENT_TYPES = new Set(['podcast', 'webinar', 'workshop']);
export interface GuestIntakePolicy {
  enabled: boolean;
  emailTemplateId: string;
  formTemplate: 'podcast' | 'webinar' | 'workshop';
  weekdays?: number[];
  minimumNoticeDays?: number;
  preferredWindows?: string[];
  followUpDays: number;
  firstContactTaskRefs?: string[];
  cc?: string[];
}
export function guestFirstContactCc(type: string, policyCc?: readonly string[], recipientEmail?: string): string[] {
  if (type === 'podcast') return normalizePodcastGuestCc(policyCc, recipientEmail);
  return policyCc ? policyCc.map(v => String(v || '').trim().toLowerCase()).filter(Boolean) : [];
}
export function guestIntakePolicyIssues(raw: unknown, type: string): string[] {
  if (raw === undefined) return [];
  const p = raw as GuestIntakePolicy;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['guestIntake must be an object'];
  const issues: string[] = [];
  for (const key of Object.keys(p)) if (!['enabled','emailTemplateId','formTemplate','weekdays','minimumNoticeDays','preferredWindows','followUpDays','firstContactTaskRefs','cc'].includes(key)) issues.push(`guestIntake.${key} is not supported`);
  if (p.enabled && p.formTemplate !== type) issues.push('guestIntake.formTemplate must match the event type');
  if (typeof p.enabled !== 'boolean') issues.push('guestIntake.enabled must be boolean');
  if (p.enabled && !APPROVED_GUEST_EVENT_TYPES.has(type)) issues.push('Guest intake is approved only for podcast, webinar and workshop');
  if (!/^[a-z0-9][a-z0-9._-]+$/.test(p.emailTemplateId || '')) issues.push('guestIntake.emailTemplateId is required');
  if (!['podcast', 'webinar', 'workshop'].includes(p.formTemplate)) issues.push('guestIntake.formTemplate is invalid');
  if (!Number.isInteger(p.followUpDays) || p.followUpDays < 1 || p.followUpDays > 90) issues.push('guestIntake.followUpDays must be 1..90');
  if (p.weekdays && (!Array.isArray(p.weekdays) || !p.weekdays.length || p.weekdays.some(v => !Number.isInteger(v) || v < 0 || v > 6))) issues.push('guestIntake.weekdays must contain weekday numbers 0..6');
  if (p.minimumNoticeDays !== undefined && (!Number.isInteger(p.minimumNoticeDays) || p.minimumNoticeDays < 0 || p.minimumNoticeDays > 180)) issues.push('guestIntake.minimumNoticeDays must be 0..180');
  for (const key of ['preferredWindows', 'firstContactTaskRefs'] as const) if (p[key] && (!Array.isArray(p[key]) || p[key]!.some(v => typeof v !== 'string' || !v))) issues.push(`guestIntake.${key} must be string values`);
  if (p.cc !== undefined) {
    if (!Array.isArray(p.cc) || p.cc.some(v => typeof v !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()))) {
      issues.push('guestIntake.cc must be valid email addresses');
    } else if (type === 'podcast' && (p.cc.length !== 1 || p.cc[0].trim().toLowerCase() !== PODCAST_GUEST_OBSERVER_CC)) {
      issues.push(`guestIntake.cc for podcast must be [${PODCAST_GUEST_OBSERVER_CC}]`);
    }
  }
  return issues;
}
