/**
 * Browser requirement: whether doing a Task needs an interactive browser.
 *
 * A high-level execution requirement, deliberately separate from `requires`
 * (external accounts) and from free-form tags: a Task touching YouTube or
 * Typefully may be doable headlessly through an API, so no service name
 * implies a browser and none is ever inferred. `'headless'` claims the whole
 * Task can finish without a browser; a Code view alone is not that proof.
 * An absent value is an honest "not classified": every headless filter
 * excludes it and no surface presents it as safe headless work.
 */

import type { BrowserRequirement } from './types';

export const BROWSER_REQUIREMENTS: readonly BrowserRequirement[] = Object.freeze([
  'required',
  'headless',
]);

/** Listing filters: an explicit classification, or the not-classified rest. */
export const BROWSER_REQUIREMENT_FILTERS: readonly string[] = Object.freeze([
  ...BROWSER_REQUIREMENTS,
  'unclassified',
]);

export function isBrowserRequirement(value: unknown): value is BrowserRequirement {
  return value === 'required' || value === 'headless';
}

/**
 * Validate a write-path `browserRequirement`: one of the two classified
 * values, or null to clear the classification back to not classified.
 * Returns an error message, or null when valid.
 */
export function browserRequirementError(value: unknown, field = 'browserRequirement'): string | null {
  if (value === undefined || value === null) return null;
  if (!isBrowserRequirement(value)) {
    return `${field} must be 'required' or 'headless', or null to clear the classification`;
  }
  return null;
}

export type BrowserRequirementFilter = BrowserRequirement | 'unclassified';

/** Parse a listing `browser` query value into its filter. */
export function parseBrowserRequirementFilter(
  raw: string,
  param = 'browser',
): { ok: true; filter: BrowserRequirementFilter } | { ok: false; error: string } {
  if (BROWSER_REQUIREMENT_FILTERS.includes(raw)) return { ok: true, filter: raw as BrowserRequirementFilter };
  return { ok: false, error: `${param} must be one of: ${BROWSER_REQUIREMENT_FILTERS.join(', ')}` };
}

/** Keep only Tasks whose classification satisfies the filter; no filter keeps all. */
export function matchesBrowserRequirementFilter(
  browserRequirement: BrowserRequirement | undefined,
  filter: BrowserRequirementFilter | undefined,
): boolean {
  if (!filter) return true;
  if (filter === 'unclassified') return !isBrowserRequirement(browserRequirement);
  return browserRequirement === filter;
}
