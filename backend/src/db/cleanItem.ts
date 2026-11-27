/**
 * Strip DynamoDB partition and sort keys (`PK`, `SK`) and the sponsor CRM
 * type-index key (`GSI5PK`, derived from PK), returning `null` when absent.
 */
export function cleanItem<T = Record<string, unknown>>(item?: Record<string, unknown>): T | null {
  if (!item) return null;
  const { PK: _pk, SK: _sk, GSI5PK: _type, ...rest } = item;
  return rest as unknown as T;
}

/** Strip DynamoDB keys (`PK`, `SK`, `GSI5PK`) from a known item. */
export function cleanRequiredItem<T = Record<string, unknown>>(item: Record<string, unknown>): T {
  const { PK: _pk, SK: _sk, GSI5PK: _type, ...rest } = item;
  return rest as unknown as T;
}
