/**
 * An episode's status as its Card says it is.
 *
 * Ticking a stage's Task on the episode's podcast Card moves the episode to
 * that stage; nobody marks it by hand. The Card never writes to the episode
 * (see recordCardLink.ts): the status is derived on every read from the
 * stored status and the Card's done Tasks, and the furthest stage wins.
 * A cancelled episode stays cancelled.
 *
 * Which Task marks which stage is authored on the Template (a task's
 * `episode_stage`) and captured in the Card's Template snapshot as
 * `episodeStages`, so a renamed Task carries its stage with it.
 */

/** Stages a Template Task can mark, in the order an episode reaches them. */
export const EPISODE_STAGES = ['recorded', 'edited', 'scheduled', 'published'] as const;
export type EpisodeStage = (typeof EPISODE_STAGES)[number];

/** For each stage, the Template task ref whose completion means the episode reached it. */
export type EpisodeStageRefs = Partial<Record<EpisodeStage, string>>;

const ORDER = ['booked', ...EPISODE_STAGES] as const;

export function isEpisodeStage(value: unknown): value is EpisodeStage {
  return typeof value === 'string' && (EPISODE_STAGES as readonly string[]).includes(value);
}

/** Statuses a Card can still move forward; others never need the Card's Tasks. */
export function cardCanAdvance(status: string): boolean {
  const index = ORDER.indexOf(status as (typeof ORDER)[number]);
  return index >= 0 && index < ORDER.length - 1;
}

/**
 * The furthest of `stored` and the stages in `stageRefs` (the Card's Template
 * snapshot) whose Task is done in `doneRefs` (the `templateTaskRef`s of the
 * Card's done Tasks).
 */
export function statusFromCard(
  stored: string,
  stageRefs: EpisodeStageRefs,
  doneRefs: ReadonlySet<string>,
): string {
  if (!cardCanAdvance(stored)) return stored;
  let furthest = ORDER.indexOf(stored as (typeof ORDER)[number]);
  for (const stage of EPISODE_STAGES) {
    const ref = stageRefs[stage];
    if (ref && doneRefs.has(ref)) furthest = Math.max(furthest, ORDER.indexOf(stage));
  }
  return ORDER[furthest];
}
