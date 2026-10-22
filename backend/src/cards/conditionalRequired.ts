/**
 * Conditional requiredness for checklist steps, driven by Template config.
 *
 * A Task definition may declare `validation.requiredWhen` to make an
 * otherwise optional step required when an external release signal fires:
 *
 *   validation:
 *     optional: true
 *     requiredWhen:
 *       signal: podcast-release-previous-week
 *       windowDays: 7
 *
 * The rule itself lives on the Template (editable through the Templates API
 * or the workflow-template YAML, no code change); this module is only the
 * generic mechanism that evaluates the named signals. Unknown signal names
 * fail loudly so a typo can never silently leave a required step optional.
 *
 * Evaluation happens when Tasks materialize from the Template (Card creation
 * and Card Template updates), and the outcome is stored on the Task's own
 * `validation` (`optional`, plus `requiredReason`/`optionalNote` for the UI),
 * so the portal labels required/optional from Task data without recomputing.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { listPodcastEpisodes } from '../db/podcastEpisodes';
import type { TaskDefinition, Template } from '../types';

/** Release signals the Template config may point at. */
export const CONDITIONAL_REQUIRED_SIGNALS = ['podcast-release-previous-week'] as const;

export type ConditionalRequiredSignal = (typeof CONDITIONAL_REQUIRED_SIGNALS)[number];

export interface RequiredWhenConfig {
  signal: string;
  windowDays: number;
}

export interface RequiredWhenOutcome {
  required: boolean;
  reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The `validation.requiredWhen` declaration of a Task definition, or null
 * when the step is unconditionally what its `optional` flag says. `enabled`
 * is the off switch: `enabled: false` leaves the declaration in place but
 * unevaluated. Malformed declarations are reported, never ignored.
 */
export function readRequiredWhen(validation: unknown): { config: RequiredWhenConfig | null; error: string | null } {
  if (!isRecord(validation)) return { config: null, error: null };
  const raw = validation.requiredWhen;
  if (raw === undefined) return { config: null, error: null };
  if (!isRecord(raw)) return { config: null, error: 'requiredWhen must be an object' };
  if (raw.enabled === false) return { config: null, error: null };
  if (typeof raw.signal !== 'string' || raw.signal.trim().length === 0) {
    return { config: null, error: 'requiredWhen.signal must be a non-empty string' };
  }
  if (raw.windowDays !== undefined && (!Number.isInteger(raw.windowDays) || (raw.windowDays as number) < 1)) {
    return { config: null, error: 'requiredWhen.windowDays must be a positive integer' };
  }
  const windowDays = raw.windowDays === undefined ? 7 : (raw.windowDays as number);
  return { config: { signal: raw.signal.trim(), windowDays }, error: null };
}

function isoDay(value: string): string {
  return String(value || '').slice(0, 10);
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

/**
 * Whether a podcast episode released in the `windowDays` before `anchorDate`.
 * Only published episodes count: a scheduled-but-unreleased episode has not
 * released yet, and an episode without a release date cannot be placed.
 */
async function podcastReleasedPreviousWeek(
  client: DynamoDBDocumentClient,
  anchorDate: string,
  windowDays: number,
): Promise<RequiredWhenOutcome> {
  const anchor = isoDay(anchorDate);
  const from = addDays(anchor, -windowDays);
  const episodes = await listPodcastEpisodes(client, { from, to: anchor });
  const released = episodes.filter((episode) => {
    if (episode.status !== 'published') return false;
    const day = episode.releaseDate ? isoDay(episode.releaseDate) : '';
    return day >= from && day < anchor;
  });
  if (released.length > 0) return { required: true, reason: 'Podcast released last week' };
  return { required: false, reason: 'No podcast release last week' };
}

export async function evaluateRequiredWhenSignal(
  client: DynamoDBDocumentClient,
  signal: string,
  context: { anchorDate: string; windowDays: number },
): Promise<RequiredWhenOutcome> {
  switch (signal) {
    case 'podcast-release-previous-week':
      return podcastReleasedPreviousWeek(client, context.anchorDate, context.windowDays);
    default:
      throw new Error(`Unknown conditional-required signal: '${signal}'`);
  }
}

/**
 * The Task `validation` with the `requiredWhen` outcome applied, or null
 * when the definition declares no (enabled) conditional rule. A fired signal
 * marks the step required with its reason and drops the N/A skip path, so
 * the UI no longer offers "no podcast this week"; a quiet signal keeps the
 * Template's optional flag and records why.
 */
export async function resolveConditionalValidation(
  client: DynamoDBDocumentClient,
  definition: Pick<TaskDefinition, 'refId' | 'validation'>,
  anchorDate: string,
): Promise<Record<string, unknown> | null> {
  const base = definition.validation;
  if (!isRecord(base)) return null;
  const { config, error } = readRequiredWhen(base);
  if (error) throw new Error(`Task '${definition.refId}': ${error}`);
  if (!config) return null;
  const outcome = await evaluateRequiredWhenSignal(client, config.signal, {
    anchorDate,
    windowDays: config.windowDays,
  });
  const next: Record<string, unknown> = { ...base };
  if (outcome.required) {
    next.optional = false;
    next.requiredReason = outcome.reason;
    delete next.optionalNote;
    if (isRecord(next.skipClosure)) delete next.skipClosure;
  } else {
    next.optional = true;
    next.optionalNote = outcome.reason;
    delete next.requiredReason;
  }
  return next;
}

/**
 * The Template with every `requiredWhen` declaration resolved for
 * `anchorDate`. Returns the Template untouched when no definition declares a
 * rule, so the common path pays for one scan and no reads.
 */
export async function resolveTemplateConditionalValidation<T extends Pick<Template, 'taskDefinitions'>>(
  client: DynamoDBDocumentClient,
  template: T,
  anchorDate: string,
): Promise<T> {
  const definitions = template.taskDefinitions || [];
  if (!definitions.some((definition) => readRequiredWhen(definition.validation).config)) return template;
  const resolved = await Promise.all(definitions.map(async (definition) => {
    const validation = await resolveConditionalValidation(client, definition, anchorDate);
    return validation ? { ...definition, validation } : definition;
  }));
  return { ...template, taskDefinitions: resolved };
}
