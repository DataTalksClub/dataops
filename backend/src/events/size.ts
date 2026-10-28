/** Conservative JSON budgets leave room below DynamoDB's 400 KiB item limit.
 * JSON overhead exceeds DynamoDB map/list overhead for these string/number objects.
 */
export function fitsEventBytes(value: unknown, limit: number): boolean {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= limit; }
  catch { return false; }
}
export function requireEventBytes(value: unknown, limit: number, label: string): void {
  if (!fitsEventBytes(value, limit)) throw new Error(`${label} exceeds the event UTF-8 byte budget`);
}
