/**
 * Podcast recording slots: next free operational window for episode/Card create.
 *
 * Distinct from releaseSlots (Friday 19:00 release cadence). A recording slot is
 * one midday or evening operational window in Europe/Berlin. Preference for
 * podcasts (Alexey / Orin t1050u):
 *   1) midday first (~12:00)
 *   2) evening fallback labeled ~17:00 (Mon/Tue only, matching owner overlay)
 * Never treat the workshop evening preferStart 16:30 as the podcast default.
 *
 * Occupancy (hard):
 *   - active CalendarHolds (tentative|confirmed) on date+window
 *   - non-cancelled episodes with recordingDate (date blocks both windows)
 *   - event Cards (webinar/workshop/…) with anchorDate (date blocks both)
 *
 * Owner Google overlay is optional soft input: when available-slot ids are
 * provided, a window must also appear free there. Google broker deferred →
 * callers may omit ownerFreeWindows.
 */

export type RecordingWindow = 'midday' | 'evening';

export const RECORDING_TIME_ZONE = 'Europe/Berlin';
export const RECORDING_MIDDAY_LOCAL = '12:00';
/** Podcast evening label (~17:00); not workshop preferStart 16:30. */
export const RECORDING_EVENING_LOCAL = '17:00';
export const DEFAULT_RECORDING_HORIZON_DAYS = 60;
export const MAX_NEXT_RECORDING_SLOT_COUNT = 52;

export interface RecordingSlot {
  date: string;
  window: RecordingWindow;
  /** Preferred wall-clock start for this window (Europe/Berlin). */
  localTime: string;
  timezone: typeof RECORDING_TIME_ZONE;
  label: string;
}

export interface NextRecordingSlotsInput {
  /** Inclusive Berlin calendar date to start scanning (usually today). */
  fromDate: string;
  episodes: Array<{ status?: string | null; recordingDate?: string | null }>;
  holds: Array<{ status?: string | null; date: string; window: RecordingWindow | string }>;
  /** Event Card anchor dates (workshop/webinar/…) that occupy a day. */
  eventCardDates?: string[];
  /**
   * Optional owner-calendar free windows as `YYYY-MM-DD#midday|evening`.
   * When provided and non-empty, only those windows are offered.
   */
  ownerFreeWindows?: Iterable<string>;
  count?: number;
  horizonDays?: number;
}

export interface NextRecordingSlotsResult {
  timezone: typeof RECORDING_TIME_ZONE;
  preference: { primary: 'midday'; fallback: 'evening'; eveningLocalTime: string; note: string };
  slots: RecordingSlot[];
  takenDates: string[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

/** ISO weekday Mon=1 .. Sun=7 for a calendar date (noon UTC proxy). */
export function isoWeekday(date: string): number {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: RECORDING_TIME_ZONE,
    weekday: 'short',
  }).format(new Date(`${date}T12:00:00Z`));
  return ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as Record<string, number>)[weekday] ?? 0;
}

export function takenRecordingDates(
  episodes: Array<{ status?: string | null; recordingDate?: string | null }>,
  eventCardDates: string[] = [],
): Set<string> {
  const taken = new Set<string>();
  for (const episode of episodes) {
    if (episode.status === 'cancelled') continue;
    if (episode.recordingDate && DATE.test(episode.recordingDate)) taken.add(episode.recordingDate);
  }
  for (const date of eventCardDates) {
    if (DATE.test(date)) taken.add(date);
  }
  return taken;
}

export function heldWindows(
  holds: Array<{ status?: string | null; date: string; window: RecordingWindow | string }>,
): Set<string> {
  const held = new Set<string>();
  for (const hold of holds) {
    if (hold.status !== 'tentative' && hold.status !== 'confirmed') continue;
    if (hold.window !== 'midday' && hold.window !== 'evening') continue;
    if (!DATE.test(hold.date)) continue;
    held.add(`${hold.date}#${hold.window}`);
  }
  return held;
}

function slotLabel(date: string, window: RecordingWindow, localTime: string): string {
  return `${date} ${window} ${localTime} ${RECORDING_TIME_ZONE}`;
}

function makeSlot(date: string, window: RecordingWindow): RecordingSlot {
  const localTime = window === 'midday' ? RECORDING_MIDDAY_LOCAL : RECORDING_EVENING_LOCAL;
  return {
    date,
    window,
    localTime,
    timezone: RECORDING_TIME_ZONE,
    label: slotLabel(date, window, localTime),
  };
}

/**
 * Next free recording slots preferring midday, then evening ~17:00.
 * Scans weekdays chronologically; on each day tries midday before evening.
 */
export function nextRecordingSlots(input: NextRecordingSlotsInput): NextRecordingSlotsResult {
  const count = Math.max(1, Math.min(MAX_NEXT_RECORDING_SLOT_COUNT, input.count ?? 1));
  const horizon = Math.max(1, Math.min(366, input.horizonDays ?? DEFAULT_RECORDING_HORIZON_DAYS));
  if (!DATE.test(input.fromDate)) {
    throw new Error('fromDate must be YYYY-MM-DD');
  }
  const taken = takenRecordingDates(input.episodes, input.eventCardDates || []);
  const held = heldWindows(input.holds);
  const ownerList = input.ownerFreeWindows ? [...input.ownerFreeWindows] : null;
  const owner = ownerList && ownerList.length ? new Set(ownerList) : null;

  const slots: RecordingSlot[] = [];
  for (let i = 0; i < horizon && slots.length < count; i += 1) {
    const date = addDays(input.fromDate, i);
    const dow = isoWeekday(date);
    if (dow < 1 || dow > 5) continue; // weekends never
    if (taken.has(date)) continue;

    const tryWindow = (window: RecordingWindow): boolean => {
      if (window === 'evening' && dow !== 1 && dow !== 2) return false; // Mon/Tue only
      const key = `${date}#${window}`;
      if (held.has(key)) return false;
      if (owner && !owner.has(key)) return false;
      slots.push(makeSlot(date, window));
      return true;
    };

    // Prefer midday on this day before evening.
    if (tryWindow('midday')) continue;
    tryWindow('evening');
  }

  return {
    timezone: RECORDING_TIME_ZONE,
    preference: {
      primary: 'midday',
      fallback: 'evening',
      eveningLocalTime: RECORDING_EVENING_LOCAL,
      note: 'Podcasts prefer midday (~12:00 Europe/Berlin); evening fallback is ~17:00 (not workshop 16:30).',
    },
    slots,
    takenDates: [...taken].sort(),
  };
}

/** Convenience: the single next slot, or null when the horizon is exhausted. */
export function nextRecordingSlot(input: Omit<NextRecordingSlotsInput, 'count'>): RecordingSlot | null {
  return nextRecordingSlots({ ...input, count: 1 }).slots[0] || null;
}
