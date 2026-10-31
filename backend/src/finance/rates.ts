/**
 * ECB euro reference rates, fetched for the dates a summary needs. A rate is
 * units of the currency per 1 EUR. On a weekend or TARGET holiday the last
 * published rate before the date applies, and that rate's own date is kept so
 * the summary can show it.
 */
import type { Rate, RateLookup } from './summary';

export const ECB_DATA_API = 'https://data-api.ecb.europa.eu/service/data/EXR';
type Fetch = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

// Published rates do not change; a warm Lambda keeps what it already fetched.
const cache = new Map<string, Map<string, number>>();

const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** Parse the ECB csvdata format: TIME_PERIOD and OBS_VALUE columns. */
export function parseEcbCsv(text: string): Map<string, number> {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const columns = header.split(',');
  const dateAt = columns.indexOf('TIME_PERIOD');
  const valueAt = columns.indexOf('OBS_VALUE');
  const out = new Map<string, number>();
  if (dateAt < 0 || valueAt < 0) return out;
  for (const line of lines) {
    const cells = line.split(',');
    const value = Number(cells[valueAt]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(cells[dateAt]) && Number.isFinite(value) && value > 0) out.set(cells[dateAt], value);
  }
  return out;
}

/**
 * Load every rate the given (currency, date) needs cover, one request per
 * currency, and return a synchronous lookup. A failed fetch leaves that
 * currency without rates: its rows show up as unconverted gaps rather than
 * failing the whole summary.
 */
export async function loadEcbRates(needs: Array<{ currency: string; date: string }>, fetchImpl: Fetch = globalThis.fetch as unknown as Fetch): Promise<{ lookup: RateLookup; errors: string[] }> {
  const errors: string[] = [];
  const byCurrency = new Map<string, string[]>();
  for (const { currency, date } of needs) {
    if (currency === 'EUR' || !/^[A-Z]{3}$/.test(currency) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    byCurrency.set(currency, [...(byCurrency.get(currency) || []), date]);
  }
  for (const [currency, dates] of byCurrency) {
    const known = cache.get(currency) || new Map<string, number>();
    const missing = dates.filter((date) => !covered(known, date));
    if (!missing.length) continue;
    missing.sort();
    const url = `${ECB_DATA_API}/D.${currency}.EUR.SP00.A?startPeriod=${shift(missing[0], -10)}&endPeriod=${missing[missing.length - 1]}&format=csvdata`;
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(8_000), headers: { Accept: 'text/csv' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      for (const [date, value] of parseEcbCsv(await response.text())) known.set(date, value);
      cache.set(currency, known);
    } catch (error) {
      errors.push(`ECB ${currency}: ${(error as Error).message}`);
    }
  }
  return { lookup: (currency, date) => lookup(cache.get(currency), currency, date), errors };
}

function covered(rates: Map<string, number>, date: string) {
  for (let back = 0; back <= 10; back += 1) if (rates.has(shift(date, -back))) return true;
  return false;
}

function lookup(rates: Map<string, number> | undefined, currency: string, date: string): Rate | null {
  if (!rates) return null;
  for (let back = 0; back <= 10; back += 1) {
    const day = shift(date, -back);
    const rate = rates.get(day);
    if (rate) return { currency, rate, date: day, source: 'ecb' };
  }
  return null;
}

export function clearEcbRateCacheForTests() {
  cache.clear();
}
