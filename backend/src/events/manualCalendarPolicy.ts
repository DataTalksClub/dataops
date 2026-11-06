import { HOLD_INVITE_LEAD_MINUTES, HOLD_REQUIRED_ATTENDEES, HOLD_ZOOM_LOCATION } from '../calendar/holds';
import type { EventPolicy } from './policy';
/** Explicit manual blocker policy. No event-type inference or first-contact email is involved. */
export function manualCalendarPolicy(duration: unknown, timeZone = 'Europe/Berlin'): EventPolicy {
  if (!Number.isInteger(duration) || Number(duration) < 1 || Number(duration) > 1440) throw new Error('An unconfigured Card needs an explicit --duration in minutes');
  try { new Intl.DateTimeFormat('en', { timeZone }); } catch { throw new Error('timeZone must be an IANA time zone'); }
  return { timeZone, durationMinutes: Number(duration), windows: {}, expiresDays: 7,
    titles: { proposed: '[Proposed] {title}', approved: '{title}' },
    description: 'Event: {date} at {time} {timeZone}\nGuest: {guestNames}\nGuest form: {documentUrl}', inviteText: 'Zoom: {zoomUrl}',
    guests: { proposal: true, approved: true, requiredEmails: [...HOLD_REQUIRED_ATTENDEES], leadMinutes: HOLD_INVITE_LEAD_MINUTES },
    zoom: { enabled: true, url: HOLD_ZOOM_LOCATION }, calendarAcceptance: { enabled: true, quorum: 'any' },
    notifications: { propose: { calendar: 'all', emails: [] }, approve: { calendar: 'all', emails: [] }, reschedule: { calendar: 'all', emails: [] }, release: { calendar: 'all', emails: [] } } };
}
