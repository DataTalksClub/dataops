/**
 * Client for the EU VIES REST API, the European Commission's service for
 * validating the registration status of member-state VAT IDs.
 *
 * Zero-dependency by design: one GET against
 * `{baseUrl}/ms/{state}/vat/{number}` using the runtime's global `fetch`.
 * The transport and base URL are injectable so tests run a local HTTP
 * server instead of the real service; a live smoke test runs behind the
 * `VIES_LIVE_SMOKE=1` flag rather than in normal CI.
 *
 * The answer distinguishes "VIES says the ID is not registered" (a
 * definitive, blocking answer) from "VIES could not answer" (never a
 * validity answer; callers degrade to a warning).
 */

import { viesMemberState } from './format';

export const VIES_REST_BASE = 'https://ec.europa.eu/taxation_customs/vies/rest-api';

export type ViesAnswer =
  | { kind: 'valid'; name?: string; address?: string; responseDate?: string }
  | { kind: 'not-found'; error?: string }
  | { kind: 'unavailable'; error?: string };

export type ViesFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export type ViesLookupOptions = {
  fetchImpl?: ViesFetch;
  /** Defaults to the European Commission REST endpoint. */
  baseUrl?: string;
  /** Milliseconds before the request is abandoned; the answer is `unavailable`. */
  timeoutMs?: number;
};

/** userError codes that mean VIES itself could not produce an answer. */
const SERVICE_TROUBLE = new Set([
  'SERVICE_UNAVAILABLE', 'MS_UNAVAILABLE', 'GLOBAL_UNAVAILABLE',
  'MS_MAX_CONCURRENT_REQ', 'GLOBAL_MAX_CONCURRENT_REQ', 'TIMEOUT',
]);

export async function lookupVies(country: string, number: string, options: ViesLookupOptions = {}): Promise<ViesAnswer> {
  const fetchImpl = options.fetchImpl || (globalThis.fetch as unknown as ViesFetch);
  const url = `${options.baseUrl || process.env.VIES_BASE_URL || VIES_REST_BASE}/ms/${viesMemberState(country)}/vat/${encodeURIComponent(number)}`;
  let response: { ok: boolean; status: number; json: () => Promise<unknown> };
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(options.timeoutMs || 10_000) });
  } catch (error) {
    const name = (error as { name?: string }).name;
    return { kind: 'unavailable', error: name === 'TimeoutError' ? 'vies-timeout' : 'vies-unavailable' };
  }
  if (!response.ok) return { kind: 'unavailable', error: `vies-http-${response.status}` };
  let body: { isValid?: unknown; name?: unknown; address?: unknown; requestDate?: unknown; userError?: unknown };
  try {
    body = await response.json() as typeof body;
  } catch {
    return { kind: 'unavailable', error: 'vies-invalid-response' };
  }
  if (body.isValid === true) {
    return {
      kind: 'valid',
      ...(typeof body.name === 'string' && body.name.trim() ? { name: body.name.trim() } : {}),
      ...(typeof body.address === 'string' && body.address.trim() ? { address: body.address.trim() } : {}),
      ...(typeof body.requestDate === 'string' && body.requestDate ? { responseDate: body.requestDate } : {}),
    };
  }
  // With isValid=false the REST API either names a userError or, when the
  // consultation itself worked, sends the sentinel `VALID` (or nothing).
  const userError = typeof body.userError === 'string' ? body.userError.toUpperCase() : '';
  if (!userError || userError === 'VALID') return { kind: 'not-found' };
  if (SERVICE_TROUBLE.has(userError)) return { kind: 'unavailable', error: `vies-user-error:${userError}` };
  return { kind: 'not-found', error: userError };
}
