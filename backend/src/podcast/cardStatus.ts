/**
 * An episode's status as its Card says it is.
 *
 * Ticking a stage's Task on the episode's podcast Card moves the episode to
 * that stage; nobody marks it by hand. The Card never writes to the episode
 * (see recordCardLink.ts): the status is derived on every read from the
 * stored status and the Card's done Tasks, and the furthest stage wins.
 *
 * Scheduled and published keep their evidence gate (publication.ts): a
 * ticked scheduling or verification Task counts only once the episode
 * records that evidence; until then it shows that the audio is at least
 * edited. A cancelled episode stays cancelled.
 */
import { statusGateError, type PodcastPublication } from './publication';

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
export function statusFromCard(
  stored: string,
  doneRefs: ReadonlySet<string>,
  publication: PodcastPublication | null | undefined,
): string {
  if (!cardCanAdvance(stored)) return stored;
  let furthest = ORDER.indexOf(stored as (typeof ORDER)[number]);
  for (const [stage, ref] of Object.entries(STAGE_TASK_REFS)) {
    if (!doneRefs.has(ref)) continue;
    const reached = statusGateError(stage, publication) ? 'edited' : stage;
    furthest = Math.max(furthest, ORDER.indexOf(reached as (typeof ORDER)[number]));
  }
  return ORDER[furthest];
}
