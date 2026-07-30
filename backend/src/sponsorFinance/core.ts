import { createHash } from 'crypto';

export const MONEY = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,4})?$/;
export const CURRENCY = /^[A-Z]{3}$/;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const IDEMPOTENCY = /^[A-Za-z0-9_-]{16,128}$/;
export const PAYMENT_LINK_LIMIT = 20;
export const MAX_PAYMENT_LINK_TRANSACTION_ACTIONS = 2 * (PAYMENT_LINK_LIMIT - 1) + 8;

export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid canonical value');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') throw new Error('Invalid canonical value');
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
};
export const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

export function scaledMoney(value: unknown, allowZero = false): bigint {
  if (typeof value !== 'string' || !MONEY.test(value)) throw new Error('Invalid money');
  const [whole, fraction = ''] = value.split('.');
  const result = BigInt(whole) * 10_000n + BigInt((fraction + '0000').slice(0, 4));
  if (!allowZero && result <= 0n) throw new Error('Invalid money');
  return result;
}

export function displayMoney(value: bigint): string {
  const whole = value / 10_000n;
  const fraction = String(value % 10_000n).padStart(4, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function realDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

export function berlinDate(value = new Date()): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function invoiceIdentity(source: Record<string, unknown>): string {
  if (
    source.status !== 'active' || source.documentType !== 'invoice'
    || typeof source.id !== 'string' || !/^[a-f0-9]{64}$/.test(String(source.sha256))
    || typeof source.objectVersionId !== 'string' || !source.objectVersionId
    || !Number.isSafeInteger(source.verifiedByteSize) || Number(source.verifiedByteSize) < 5
  ) throw new Error('Invalid invoice source');
  return digest({
    kind: 'document', id: source.id, sha256: source.sha256,
    objectVersionId: source.objectVersionId, byteSize: source.verifiedByteSize,
  });
}

export function paymentIdentity(source: Record<string, unknown>): string {
  scaledMoney(source.amount);
  if (typeof source.id !== 'string' || typeof source.updatedAt !== 'string' || !CURRENCY.test(String(source.currency))) {
    throw new Error('Invalid payment source');
  }
  return digest({ kind: 'transaction', id: source.id, updatedAt: source.updatedAt, amount: source.amount, currency: source.currency });
}

export const financeKey = (bookingId: string) => `SPONSOR_FINANCE#${bookingId}`;
export const linkKey = (bookingId: string, kind: 'document' | 'transaction', sourceId: string) =>
  `SPONSOR_FINANCE_LINK#${bookingId}#${kind}#${sourceId}`;
export const claimKey = (kind: 'document' | 'transaction', sourceId: string) =>
  `SPONSOR_FINANCE_CLAIM#${kind}#${sourceId}`;
export const sourceKey = (kind: 'document' | 'transaction', sourceId: string) =>
  `${kind === 'document' ? 'DOCUMENT' : 'BOOKKEEPING'}#${sourceId}`;
