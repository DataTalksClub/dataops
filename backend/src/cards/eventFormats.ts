/**
 * The event format policy: DataOps runs events in exactly three formats —
 * workshop, webinar and podcast — and each format is served by its one
 * canonical Git-authored Template. Sponsorship is a flag on the Card, never a
 * format: there is no sponsored variant of a format Template, and a Custom
 * Template may not claim an event format at all.
 *
 * Newsletter formats (`newsletter`, `newsletter-standalone`) are separate
 * recurring publications with their own flows and stay untouched by this
 * policy.
 */
import { parseCardTitle } from './cardTitleStructure';

/** The three event formats and their canonical Template `type` values. */
export const EVENT_CARD_FORMATS = ['workshop', 'webinar', 'podcast'] as const;

export type EventCardFormat = (typeof EVENT_CARD_FORMATS)[number];

/** Portal document templates each event format's Cards may carry. */
export const EVENT_FORMAT_DOC_TEMPLATES: Record<EventCardFormat, readonly string[]> = {
  workshop: ['workshop'],
  webinar: ['webinar'],
  podcast: ['podcast', 'podcast-episode-brief', 'podcast-run-sheet', 'podcast-guest-research'],
};

const FORMAT_WORDS = new RegExp(`(?:^|-)(${EVENT_CARD_FORMATS.join('|')})(?:-|$)`, 'i');

/**
 * Distinct business-unit product Templates (e.g., AI Shipping Labs workshops)
 * that run their own operational workflow outside DataTalks.Club's three
 * canonical event formats.
 */
export const SEPARATE_BUSINESS_EVENT_TYPES = ['aishl-workshop'] as const;

export function isSeparateBusinessEventType(type: string | null | undefined): boolean {
  const value = String(type || '').toLowerCase();
  return (SEPARATE_BUSINESS_EVENT_TYPES as readonly string[]).includes(value);
}

/** The canonical event format a Template `type` serves, if any. */
export function eventFormatOfType(type: string | null | undefined): EventCardFormat | null {
  const value = String(type || '').toLowerCase();
  if ((EVENT_CARD_FORMATS as readonly string[]).includes(value)) return value as EventCardFormat;
  return null;
}

/**
 * Whether a Template `type` is an event-format variant: a slug that carries a
 * format word as a segment but is not exactly the canonical type
 * (`sponsored-webinar`, `sponsored-podcast`). Git-authored Templates with their
 * own compound types (`lightning-lesson-podcast`) and separate business-unit
 * workflows (`aishl-workshop`) are distinct products, not DTC format variants.
 */
export function isEventFormatVariantType(type: string | null | undefined): boolean {
  const value = String(type || '').toLowerCase();
  if (eventFormatOfType(value) || isSeparateBusinessEventType(value)) return false;
  return FORMAT_WORDS.test(value);
}

/**
 * Whether a Template type is a canonical event format or a variant slug —
 * the predicate behind "custom Templates may not claim an event format".
 * Callers gate on the Template's origin so Git-authored compound types stay
 * distinct products.
 */
export function claimsEventCardFormat(type: string | null | undefined): boolean {
  return eventFormatOfType(type) !== null || isEventFormatVariantType(type);
}

const EVENT_FORMAT_BY_TAG: Record<string, EventCardFormat> = {
  workshop: 'workshop',
  webinar: 'webinar',
  podcast: 'podcast',
};

/** The event format a free-text Card-title `[Tag]` claims, if any. */
export function eventFormatOfTag(tag: string | null | undefined): EventCardFormat | null {
  if (!tag) return null;
  return EVENT_FORMAT_BY_TAG[tag.trim().toLowerCase()] || null;
}

/**
 * The event format a variant Template-type slug claims (`aishl-workshop`
 * names the workshop format it imitates). Canonical types and slugs without
 * a format word claim nothing. Audit-side only: enforcement gates on exact
 * canonical types, so Git-authored compound products keep their flows.
 */
export function eventFormatOfVariantType(type: string | null | undefined): EventCardFormat | null {
  const value = String(type || '').toLowerCase();
  if (eventFormatOfType(value) || isSeparateBusinessEventType(value)) return null;
  const match = FORMAT_WORDS.exec(value);
  return match ? (match[1] as EventCardFormat) : null;
}

/**
 * A Custom Template claiming an event format can never be created, and an
 * event card can never be instantiated from one: the three formats are served
 * only by their canonical Git-authored Templates.
 */
export function eventFormatTemplateClaimError(type: string, name: string): string {
  const format = eventFormatOfType(type);
  const variant = !format && isEventFormatVariantType(type);
  if (!format && !variant) return '';
  const claimed = format ? `the ${format} format` : `an event-format variant ("${type}")`;
  return `Template "${name}" claims ${claimed}. Events run only in the workshop, webinar and podcast formats, `
    + 'each served by its canonical Template: custom or variant Templates for these formats are not allowed. '
    + 'Sponsorship is a Card flag, not a format.';
}

/**
 * The error for a Card creation whose Template is not the canonical format
 * Template its type (or its title tag) claims.
 */
export function eventFormatCardError(claimed: string, templateName: string, templateType: string): string {
  return `"${templateName}" (${templateType}) is not the canonical ${claimed} Template. `
    + `Event Cards are created only from the canonical workshop, webinar and podcast Templates — `
    + `use the ${claimed} Template for ${claimed} events. Sponsorship is a Card flag, not a format.`;
}

/**
 * The error for a Card creation from a Custom Template claiming an event
 * format, directly via its type or via a `[Workshop]`-style title tag.
 */
export function eventFormatVariantCardError(templateName: string, templateType: string): string {
  return `Event Cards are created only from the canonical workshop, webinar and podcast Templates: `
    + `"${templateName}" (${templateType}) is not one of them, and custom or variant Templates for `
    + `these formats are not allowed. Sponsorship is a Card flag, not a format.`;
}

/**
 * The Card-creation gate: event formats are served only by their canonical
 * Git-authored Templates. A Card created from a non-Git Template is rejected
 * when the Template's type claims an event format, or when the resolved Card
 * title claims one with a `[Workshop]`-style tag. Git-authored Templates keep
 * their legacy tagged titles and their own compound types.
 */
export function eventFormatCardCreationError(
  template: { type?: string; name?: string; origin?: string },
  resolvedTitle: string,
): string {
  if (template.origin === 'git' || isSeparateBusinessEventType(template.type)) return '';
  if (claimsEventCardFormat(template.type)) {
    return eventFormatVariantCardError(String(template.name || ''), String(template.type || ''));
  }
  const tag = parseCardTitle(resolvedTitle).tag;
  if (eventFormatOfTag(tag)) {
    return eventFormatVariantCardError(String(template.name || ''), String(template.type || ''));
  }
  return '';
}

function eventFormatDocError(format: EventCardFormat, requested: string): string {
  const allowed = EVENT_FORMAT_DOC_TEMPLATES[format].join(', ');
  return `Document template "${requested}" does not belong to the ${format} format. `
    + `A ${format} Card carries only its format's documents (allowed: ${allowed}).`;
}

/**
 * The error for a document whose template does not belong to the owning
 * event Card's format. Newsletter Cards are out of scope: their document
 * flows keep their existing slot behaviour.
 */
export function eventFormatDocTemplateError(cardType: string | null, requestedTemplate: string): string | null {
  const format = eventFormatOfType(cardType);
  if (!format) return null;
  if (EVENT_FORMAT_DOC_TEMPLATES[format].includes(requestedTemplate)) return null;
  return eventFormatDocError(format, requestedTemplate);
}
