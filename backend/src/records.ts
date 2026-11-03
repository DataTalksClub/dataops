/** Plain JSON-like object check (excludes null and arrays). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export const isDict = isRecord;
