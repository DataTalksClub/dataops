/**
 * EU VAT ID structure: member states, per-country formats and input
 * splitting. Structure only — the authoritative validity answer comes from
 * the VIES service (`client.ts`); these rules exist to reject, without any
 * network call, values that cannot be VIES identifiers at all (a bare
 * Danish CVR, a German tax number, a missing country prefix).
 */

export const EU_MEMBER_STATES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU',
  'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

/** VIES uses `EL` for Greece and `XI` for Northern Ireland; input uses `GR`. */
const VIES_MEMBER_STATE: Record<string, string> = { GR: 'EL' };

const PATTERNS: Record<string, RegExp> = {
  AT: /^U\d{7}$/,
  BE: /^0\d{9}$/,
  BG: /^\d{9,10}$/,
  CY: /^\d{8}[A-Z]$/,
  CZ: /^\d{8,10}$/,
  DE: /^\d{9}$/,
  DK: /^\d{8}$/,
  EE: /^\d{9}$/,
  ES: /^[0-9A-Z]\d{7}[0-9A-Z]$/,
  FI: /^\d{8}$/,
  FR: /^[0-9A-Z]{2}\d{9}$/,
  GR: /^\d{9}$/,
  HR: /^\d{11}$/,
  HU: /^\d{8}$/,
  IE: /^(?:\d[A-Z*]\d{5}[A-Z]|\d{7}[A-Z])$/,
  IT: /^\d{11}$/,
  LT: /^\d{9,12}$/,
  LU: /^\d{8}$/,
  LV: /^\d{11}$/,
  MT: /^\d{8}$/,
  NL: /^\d{9}B\d{2}$/,
  PL: /^\d{10}$/,
  PT: /^\d{9}$/,
  RO: /^\d{2,10}$/,
  SE: /^\d{10}$/,
  SI: /^\d{8}$/,
  SK: /^\d{10}$/,
};

export type SplitVatId = { country: string; number: string } | { error: string };

/** Uppercase and drop the separators invoices commonly carry. */
export function normalizeVatId(raw: unknown): string {
  return String(raw ?? '').toUpperCase().replace(/[\s.\-–—]/g, '');
}

export function isEuMemberState(country: unknown): boolean {
  return typeof country === 'string' && EU_MEMBER_STATES.has(country.toUpperCase());
}

export function viesMemberState(country: string): string {
  return VIES_MEMBER_STATE[country] || country;
}

/**
 * Split a VAT ID into member state and national number. Accepts `DE123456789`;
 * also accepts an already-separated pair via the `country` argument. A value
 * without an EU member-state prefix (a bare CVR) or failing the country's
 * structure is an error naming the problem.
 */
export function splitVatId(raw: unknown, country?: unknown): SplitVatId {
  const value = normalizeVatId(raw);
  if (!value) return { error: 'empty' };
  let memberState: string | undefined;
  let number: string;
  const prefix = value.slice(0, 2), rest = value.slice(2);
  if (EU_MEMBER_STATES.has(prefix) && rest) {
    memberState = prefix;
    number = rest;
  } else if (country !== undefined) {
    const explicit = normalizeVatId(country);
    if (!EU_MEMBER_STATES.has(explicit)) return { error: 'unknown-member-state' };
    memberState = explicit;
    number = value;
  } else {
    return { error: 'missing-country-prefix' };
  }
  const pattern = PATTERNS[memberState];
  if (!pattern || !pattern.test(number)) return { error: 'malformed' };
  return { country: memberState, number };
}
