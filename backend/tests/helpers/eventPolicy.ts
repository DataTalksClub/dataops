import type { EventPolicy } from '../../src/events/policy';

/** Public-safe policies demonstrate that the interpreter never selects by type. */
export function policy(type = 'podcast'): EventPolicy {
  return {
    timeZone: 'Europe/Berlin', durationMinutes: type === 'workshop' ? 90 : 60,
    windows: type === 'workshop' ? { midday: '12:00', evening: '16:30' } : { midday: '12:30', evening: '17:00' },
    expiresDays: 7,
    titles: { proposed: `(Proposal) ${type}: {title}`, approved: `${type}: {title}` },
    description: '{topic}', inviteText: '{zoomUrl}',
    guests: { proposal: true, approved: true, requiredEmails: ['internal@example.invalid'], leadMinutes: 5 },
    zoom: type === 'workshop' ? { enabled: false } : { enabled: true, url: 'https://zoom.us/j/123456789' },
    calendarAcceptance: { enabled: true, quorum: 'any' },
    notifications: {
      propose: { calendar: 'all', emails: [] },
      approve: { calendar: 'all', emails: [{ to: 'guests', subject: 'Approved {title}', body: '{date} {time} {timeZone}' }] },
      reschedule: { calendar: 'all', emails: [] }, release: { calendar: 'all', emails: [] },
    },
  };
}

