/** Resolve a local wall time using IANA rules. Ambiguous or missing DST times
 * are rejected instead of silently moving a guest's appointment. */
export function cardEventInterval(at: unknown, duration: unknown = 60, zone: unknown = 'Europe/Berlin') {
  if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/.test(at)) {
    throw new Error('at must be YYYY-MM-DD HH:MM');
  }
  if (typeof zone !== 'string' || !zone.trim()) throw new Error('A valid IANA time zone is required');
  const timeZone = zone.trim();
  const durationMinutes = Number(duration);
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440) {
    throw new Error('duration must be an integer from 1 to 1440 minutes');
  }
  const target = at.replace('T', ' ');
  const naive = Date.parse(target.replace(' ', 'T') + ':00Z');
  if (!Number.isFinite(naive)) throw new Error('Invalid event date');
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const wall = (ms: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(ms).map(p => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  };
  // Sample the nearby offsets (including both sides of a DST transition).
  const offsets = new Set<number>();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const instant = naive + hours * 3600000;
    offsets.add(Date.parse(wall(instant).replace(' ', 'T') + ':00Z') - instant);
  }
  const candidates = [...offsets].map(offset => naive - offset).filter(ms => wall(ms) === target);
  if (candidates.length !== 1) throw new Error('Event time is nonexistent or ambiguous in this time zone; choose another time');
  const start = candidates[0];
  return { startIso: new Date(start).toISOString(), endIso: new Date(start + durationMinutes * 60000).toISOString(), timeZone, durationMinutes };
}
