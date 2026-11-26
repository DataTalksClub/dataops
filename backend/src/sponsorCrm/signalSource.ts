/**
 * Normalized outbound sponsor-signal sources. A lead carries an explicit
 * `source` when an operator recorded it; leads extracted from newsletter
 * intake carry none and are, by construction, newsletter sightings.
 */
export const SIGNAL_SOURCES = ['newsletter', 'social', 'influencer', 'paid', 'conference', 'funding'] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

export function isSignalSource(value: unknown): value is SignalSource {
  return typeof value === 'string' && (SIGNAL_SOURCES as readonly string[]).includes(value);
}

/** The supported source of a lead, or null when the stored data does not say. */
export function leadSignalSource(lead: Record<string, unknown>): SignalSource | null {
  if (isSignalSource(lead.source)) return lead.source;
  if (lead.source === undefined && lead.sourceType === 'leads-intake') return 'newsletter';
  return null;
}
