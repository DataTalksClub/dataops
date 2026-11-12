import { OPERATIONS_SENDER } from '../identity/operatingIdentities';

/** Approved first-contact copy. Rendering creates no records and sends no mail. */
export const PODCAST_FIRST_CONTACT_FROM = OPERATIONS_SENDER;
export const PODCAST_DOCS_URL = 'https://datatalksclub.github.io/docs/activities/podcast/';

const BERLIN_TZ = 'Europe/Berlin';

/** Berlin wall-clock label for a hold instant, e.g. "Tuesday, November 4 at 12:30 CET". */
export function formatSlotLabel(startIso: string, timeZone = BERLIN_TZ): string {
  const instant = Date.parse(startIso);
  if (Number.isNaN(instant)) throw new Error('startIso must be a valid ISO instant');
  const date = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone,
  }).format(new Date(instant)).replace(',', '');
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
    timeZoneName: 'short',
  }).format(new Date(instant));
  return `${date} at ${time}`;
}
