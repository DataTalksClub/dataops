/** Strip DynamoDB partition and sort keys (`PK`, `SK`), returning `null` when absent. */
export function cleanItem<T = Record<string, unknown>>(item?: Record<string, unknown>): T | null {
  if (!item) return null;
  const { PK: _pk, SK: _sk, ...rest } = item;
  return rest as unknown as T;
}

/** Strip DynamoDB partition and sort keys (`PK`, `SK`) from a known item. */
export function cleanRequiredItem<T = Record<string, unknown>>(item: Record<string, unknown>): T {
  const { PK: _pk, SK: _sk, ...rest } = item;
  return rest as unknown as T;
}
