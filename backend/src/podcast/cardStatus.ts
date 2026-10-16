/**
 * An episode's status as its Card says it is.
 *
 * Ticking a stage's Task on the episode's podcast Card moves the episode to
 * that stage; nobody marks it by hand. The Card never writes to the episode
 * (see recordCardLink.ts): the status is derived on every read from the
 * stored status and the Card's done Tasks, and the furthest stage wins.
 * A cancelled episode stays cancelled.
 */

/** The podcast Template Task whose completion means the episode reached a stage. */
export const STAGE_TASK_REFS = Object.freeze({
  recorded: 'actual-stream',
  edited: 'edit-final-podcast-audio',
  scheduled: 'schedule-podcast-spotify',
  published: 'add-podcast-episode-airtable',
} as const);

const ORDER = ['booked', 'recorded', 'edited', 'scheduled', 'published'] as const;

/** Statuses a Card can still move forward; others never need the Card's Tasks. */
export function cardCanAdvance(status: string): boolean {
  const index = ORDER.indexOf(status as (typeof ORDER)[number]);
  return index >= 0 && index < ORDER.length - 1;
}

/**
 * The furthest of `stored` and the stages whose Task is done in `doneRefs`
 * (the `templateTaskRef`s of the Card's done Tasks).
 */
export function statusFromCard(stored: string, doneRefs: ReadonlySet<string>): string {
  if (!cardCanAdvance(stored)) return stored;
  let furthest = ORDER.indexOf(stored as (typeof ORDER)[number]);
  for (const [stage, ref] of Object.entries(STAGE_TASK_REFS)) {
    if (doneRefs.has(ref)) furthest = Math.max(furthest, ORDER.indexOf(stage as (typeof ORDER)[number]));
  }
  return ORDER[furthest];
}
