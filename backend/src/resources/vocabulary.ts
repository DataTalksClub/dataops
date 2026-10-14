/**
 * Required resources: the controlled vocabulary for a Task's `requires`.
 *
 * A resource is an external system a Task cannot be done without (YouTube,
 * Luma, Mailchimp, ...). Listing them on the Task lets an agent that lacks one
 * leave the Task for an agent or person who has it, instead of attempting it.
 *
 * The list lives in `requiredResources.json` so the private knowledge
 * repository's template validator reads the same ids as the backend.
 */
import vocabulary from './requiredResources.json';

export interface RequiredResource {
  id: string;
  name: string;
  /** DataOps stroke-glyph name drawn by the frontend. */
  icon: string;
  /** What having this resource means, in one line. */
  access: string;
}

export const REQUIRED_RESOURCES: readonly RequiredResource[] = Object.freeze(
  vocabulary.resources.map((resource) => Object.freeze({ ...resource })),
);

export const REQUIRED_RESOURCE_IDS: ReadonlySet<string> = new Set(
  REQUIRED_RESOURCES.map((resource) => resource.id),
);

export function isRequiredResourceId(value: unknown): value is string {
  return typeof value === 'string' && REQUIRED_RESOURCE_IDS.has(value);
}

/**
 * Validate a `requires` value: a list of known resource ids with no
 * duplicates. Returns an error message, or null when valid.
 */
export function requiresError(value: unknown, field = 'requires'): string | null {
  if (!Array.isArray(value)) return `${field} must be an array of resource ids`;
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') return `${field} must be an array of resource ids`;
    if (!REQUIRED_RESOURCE_IDS.has(entry)) return `${field} has unknown resource '${entry}'`;
    if (seen.has(entry)) return `${field} lists '${entry}' more than once`;
    seen.add(entry);
  }
  return null;
}

/** Parse a comma-separated query value into resource ids, rejecting unknown ids. */
export function parseResourceList(
  raw: string,
  field: string,
): { ok: true; ids: string[] } | { ok: false; error: string } {
  const ids = [...new Set(raw.split(',').map((part) => part.trim()).filter(Boolean))];
  const unknown = ids.filter((id) => !REQUIRED_RESOURCE_IDS.has(id));
  if (unknown.length > 0) {
    return { ok: false, error: `${field} has unknown resource ${unknown.map((id) => `'${id}'`).join(', ')}` };
  }
  return { ok: true, ids };
}

export interface RequiresFilter {
  /** Keep Tasks requiring at least one of these. */
  anyOf?: string[];
  /** Drop Tasks requiring any of these. */
  noneOf?: string[];
  /** Keep only Tasks whose every requirement is in this set. */
  within?: string[];
}

export function matchesRequiresFilter(requires: readonly string[] | undefined, filter: RequiresFilter): boolean {
  const needed = requires || [];
  if (filter.anyOf && !filter.anyOf.some((id) => needed.includes(id))) return false;
  if (filter.noneOf && filter.noneOf.some((id) => needed.includes(id))) return false;
  if (filter.within) {
    const available = new Set(filter.within);
    if (!needed.every((id) => available.has(id))) return false;
  }
  return true;
}
