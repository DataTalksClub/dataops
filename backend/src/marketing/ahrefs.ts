import { normalizeDomain } from "./model";

export interface AhrefsRefreshResult {
  status: "ok" | "unavailable";
  reason: string;
  value?: number;
  period?: string;
  observedAt?: string;
  provider?: "ahrefs";
  metricVersion?: string;
  evidenceUrl?: string;
}

export interface AhrefsRefreshOptions {
  token?: string;
  fetchFn?: typeof fetch;
  date?: string;
  timeoutMs?: number;
}

/**
 * Official Ahrefs v3 API adapter for Domain Rating.
 * Only executes when credentials are already configured; never scrapes,
 * never verifies sites, never spends credits without an explicit token,
 * and never encodes unavailable data as zero.
 */
export async function fetchAhrefsDomainRating(
  rawDomain: string,
  opts: AhrefsRefreshOptions = {},
): Promise<AhrefsRefreshResult> {
  const domain = normalizeDomain(rawDomain);
  const token = (opts.token ?? process.env.AHREFS_API_TOKEN ?? "").trim();
  if (!token) {
    return {
      status: "unavailable",
      reason:
        "Ahrefs API credentials are not configured; record manual verified evidence instead.",
    };
  }
  const fetchFn = opts.fetchFn || globalThis.fetch;
  const observedAt = new Date().toISOString();
  const date = opts.date || observedAt.slice(0, 10);
  const url = `https://api.ahrefs.com/v3/site-explorer/domain-rating?target=${encodeURIComponent(domain)}&date=${encodeURIComponent(date)}`;
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
    });
    if (!response.ok) {
      return {
        status: "unavailable",
        reason: `Ahrefs API returned HTTP ${response.status}; unavailable values are never recorded as zero.`,
      };
    }
    const payload = (await response.json()) as {
      domain_rating?: { domain_rating?: unknown };
    };
    const rawValue = payload?.domain_rating?.domain_rating;
    const value = typeof rawValue === "number" ? rawValue : Number(rawValue);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      return {
        status: "unavailable",
        reason: "Ahrefs API response did not include a valid Domain Rating score.",
      };
    }
    return {
      status: "ok",
      reason: "Fetched from official Ahrefs v3 API.",
      value,
      period: date,
      observedAt,
      provider: "ahrefs",
      metricVersion: "v3",
      evidenceUrl: `https://ahrefs.com/website-authority-checker/?input=${encodeURIComponent(domain)}`,
    };
  } catch (error) {
    return {
      status: "unavailable",
      reason: `Ahrefs API request failed: ${(error as Error).message || "network error"}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
