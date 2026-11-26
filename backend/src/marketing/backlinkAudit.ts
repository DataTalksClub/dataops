import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  MarketingError,
  normalizePublicHttpUrl,
  type BacklinkCheck,
  type BacklinkPair,
} from "./model";

export const BACKLINK_AUDIT_DEFAULTS = Object.freeze({
  timeoutMs: 10_000,
  maxRedirects: 5,
  maxBytes: 2 * 1024 * 1024,
  concurrency: 5,
  userAgent: "DataOps-BacklinkAudit/1.0 (+https://datatalks.club)",
});

const QUALIFIED_REL_TOKENS = new Set(["nofollow", "ugc", "sponsored"]);

const TRACKING_QUERY_PREFIXES = ["utm_", "fbclid", "gclid", "mc_cid", "mc_eid", "ref"];

function isPublicIpv4(ip: string): boolean {
  const parts = ip.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return false; // Link-local / IMDS 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC1918 172.16.0.0/12
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF / TEST-NET-1
  if (a === 192 && b === 168) return false; // RFC1918 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return false; // Benchmarking 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // Multicast & reserved
  return true;
}

export function isPublicIpAddress(rawIp: string): boolean {
  const ip = rawIp.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const version = isIP(ip);
  if (version === 4) return isPublicIpv4(ip);
  if (version !== 6) return false;
  if (ip === "::" || ip === "::1") return false;
  // IPv4-mapped IPv6 ::ffff:a.b.c.d or ::ffff:xxxx:yyyy
  const mappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mappedDotted) return isPublicIpv4(mappedDotted[1]);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isPublicIpv4(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
  }
  const firstHextet = parseInt(ip.split(":")[0] || "0", 16);
  if ((firstHextet & 0xfe00) === 0xfc00) return false; // fc00::/7 ULA
  if ((firstHextet & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((firstHextet & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (firstHextet === 0x0100 && ip.startsWith("100::")) return false; // discard-only
  if (ip.startsWith("2001:db8:")) return false; // documentation
  return true;
}

export type DnsLookupFn = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }>>;

export async function assertPublicTargetUrl(
  rawUrl: string,
  lookupFn: DnsLookupFn = lookup,
): Promise<URL> {
  const normalized = normalizePublicHttpUrl(rawUrl);
  const parsed = new URL(normalized);
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (!isPublicIpAddress(host)) {
      throw new MarketingError(`Non-public IP target rejected: ${host}`);
    }
    return parsed;
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookupFn(host, { all: true });
  } catch (error) {
    throw new MarketingError(
      `DNS lookup failed for ${host}: ${(error as Error).message || "unresolved"}`,
    );
  }
  if (!addresses.length) {
    throw new MarketingError(`DNS lookup returned no addresses for ${host}`);
  }
  for (const entry of addresses) {
    if (!isPublicIpAddress(entry.address)) {
      throw new MarketingError(
        `Non-public IP resolved for ${host}: ${entry.address}`,
      );
    }
  }
  return parsed;
}

export interface PageFetchResult {
  ok: boolean;
  httpStatus: number | null;
  finalUrl: string | null;
  html: string;
  reason: string;
}

export interface FetchPageOptions {
  fetchFn?: typeof fetch;
  lookupFn?: DnsLookupFn;
  timeoutMs?: number;
  maxRedirects?: number;
  maxBytes?: number;
  userAgent?: string;
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      return { text: text.slice(0, maxBytes), truncated: true };
    }
    return { text, truncated: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > maxBytes) {
        const remaining = maxBytes - total;
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return { text: merged.toString("utf8"), truncated };
}

export async function fetchPublicHtmlPage(
  sourceUrl: string,
  opts: FetchPageOptions = {},
): Promise<PageFetchResult> {
  const fetchFn = opts.fetchFn || globalThis.fetch;
  const lookupFn = opts.lookupFn || lookup;
  const timeoutMs = opts.timeoutMs ?? BACKLINK_AUDIT_DEFAULTS.timeoutMs;
  const maxRedirects = opts.maxRedirects ?? BACKLINK_AUDIT_DEFAULTS.maxRedirects;
  const maxBytes = opts.maxBytes ?? BACKLINK_AUDIT_DEFAULTS.maxBytes;
  const userAgent = opts.userAgent ?? BACKLINK_AUDIT_DEFAULTS.userAgent;

  let currentUrl: URL;
  try {
    currentUrl = await assertPublicTargetUrl(sourceUrl, lookupFn);
    currentUrl.hash = "";
  } catch (error) {
    return {
      ok: false,
      httpStatus: null,
      finalUrl: null,
      html: "",
      reason: (error as Error).message || "Rejected non-public URL",
    };
  }

  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchFn(currentUrl.href, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": userAgent,
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        },
      });
    } catch (error) {
      clearTimeout(timer);
      const isAbort = (error as Error).name === "AbortError";
      return {
        ok: false,
        httpStatus: null,
        finalUrl: currentUrl.href,
        html: "",
        reason: isAbort
          ? `Request timeout after ${timeoutMs}ms`
          : `Fetch failed: ${(error as Error).message || "network error"}`,
      };
    }

    if (response.status >= 300 && response.status < 400) {
      clearTimeout(timer);
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      if (!location) {
        return {
          ok: false,
          httpStatus: response.status,
          finalUrl: currentUrl.href,
          html: "",
          reason: `Redirect HTTP ${response.status} without Location header`,
        };
      }
      if (redirects === maxRedirects) {
        return {
          ok: false,
          httpStatus: response.status,
          finalUrl: currentUrl.href,
          html: "",
          reason: `Exceeded max redirects (${maxRedirects})`,
        };
      }
      let nextHref: string;
      try {
        nextHref = new URL(location, currentUrl.href).href;
      } catch {
        return {
          ok: false,
          httpStatus: response.status,
          finalUrl: currentUrl.href,
          html: "",
          reason: "Invalid redirect Location URL",
        };
      }
      try {
        currentUrl = await assertPublicTargetUrl(nextHref, lookupFn);
        currentUrl.hash = "";
      } catch (error) {
        return {
          ok: false,
          httpStatus: response.status,
          finalUrl: currentUrl.href,
          html: "",
          reason: `Redirect target rejected: ${(error as Error).message}`,
        };
      }
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      clearTimeout(timer);
      await response.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        httpStatus: response.status,
        finalUrl: currentUrl.href,
        html: "",
        reason: `HTTP ${response.status}`,
      };
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (
      contentType &&
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml+xml") &&
      !contentType.includes("text/plain")
    ) {
      clearTimeout(timer);
      await response.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        httpStatus: response.status,
        finalUrl: currentUrl.href,
        html: "",
        reason: `Non-HTML content-type: ${contentType.split(";")[0].trim()}`,
      };
    }

    try {
      const { text } = await readBoundedText(response, maxBytes);
      clearTimeout(timer);
      return {
        ok: true,
        httpStatus: response.status,
        finalUrl: currentUrl.href,
        html: text,
        reason: `HTTP ${response.status}`,
      };
    } catch (error) {
      clearTimeout(timer);
      return {
        ok: false,
        httpStatus: response.status,
        finalUrl: currentUrl.href,
        html: "",
        reason: `Failed reading response body: ${(error as Error).message || "read error"}`,
      };
    }
  }

  return {
    ok: false,
    httpStatus: null,
    finalUrl: currentUrl.href,
    html: "",
    reason: `Exceeded max redirects (${maxRedirects})`,
  };
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/g, "&")
    .replace(/&#x26;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

export interface ExtractedAnchor {
  rawHref: string;
  resolvedHref: string;
  rel: string[];
}

export function extractAnchors(html: string, baseUrl: string): ExtractedAnchor[] {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  const anchors: ExtractedAnchor[] = [];
  const tagRegex = /<a\b([^>]*)>/gi;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagRegex.exec(cleaned)) !== null) {
    const attrs = tagMatch[1];
    let rawHref: string | null = null;
    let rawRel = "";
    const attrRegex = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(attrs)) !== null) {
      const name = attrMatch[1].toLowerCase();
      const value = decodeHtmlEntities(attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? "").trim();
      if (name === "href") rawHref = value;
      else if (name === "rel") rawRel = value;
    }
    if (!rawHref || rawHref.startsWith("#")) continue;
    let resolved: URL;
    try {
      resolved = new URL(rawHref, baseUrl);
    } catch {
      continue;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
    const rel = rawRel
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);
    anchors.push({ rawHref, resolvedHref: resolved.href, rel });
  }
  return anchors;
}

function normalizePathForMatch(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function isTrackingParam(key: string): boolean {
  const lower = key.toLowerCase();
  return TRACKING_QUERY_PREFIXES.some((prefix) =>
    prefix.endsWith("_") ? lower.startsWith(prefix) : lower === prefix,
  );
}

/**
 * Match a candidate resolved href against a registered target URL while
 * preserving exact host and route identity (never collapsing subdomains
 * like prod.datatalks.club into datatalks.club, or different paths).
 */
export function matchesTargetUrl(candidateHref: string, targetUrl: string): boolean {
  let candidate: URL;
  let target: URL;
  try {
    candidate = new URL(candidateHref);
    target = new URL(targetUrl);
  } catch {
    return false;
  }
  if (candidate.protocol !== "http:" && candidate.protocol !== "https:") return false;
  if (candidate.hostname.toLowerCase() !== target.hostname.toLowerCase()) return false;
  const candPort = candidate.port || (candidate.protocol === "https:" ? "443" : "80");
  const targetPort = target.port || (target.protocol === "https:" ? "443" : "80");
  if (candPort !== targetPort) return false;
  if (normalizePathForMatch(candidate.pathname) !== normalizePathForMatch(target.pathname)) {
    return false;
  }
  const targetParams = [...target.searchParams.entries()];
  if (targetParams.length > 0) {
    for (const [k, v] of targetParams) {
      if (candidate.searchParams.get(k) !== v) return false;
    }
    return true;
  }
  for (const [k] of candidate.searchParams.entries()) {
    if (!isTrackingParam(k)) return false;
  }
  return true;
}

export function classifyBacklinkCheck(
  page: PageFetchResult,
  targetUrl: string,
  checkedAt = new Date().toISOString(),
): BacklinkCheck {
  if (!page.ok) {
    return {
      checkedAt,
      bucket: "unavailable",
      httpStatus: page.httpStatus,
      finalUrl: page.finalUrl,
      matchedHref: null,
      matchedRel: [],
      matchCount: 0,
      reason: page.reason || "Source page unavailable",
    };
  }
  const anchors = extractAnchors(page.html, page.finalUrl || targetUrl);
  const matches = anchors.filter((a) => matchesTargetUrl(a.resolvedHref, targetUrl));
  if (matches.length === 0) {
    return {
      checkedAt,
      bucket: "absent",
      httpStatus: page.httpStatus,
      finalUrl: page.finalUrl,
      matchedHref: null,
      matchedRel: [],
      matchCount: 0,
      reason: "Target link not found on page",
    };
  }
  const followMatch = matches.find(
    (m) => !m.rel.some((token) => QUALIFIED_REL_TOKENS.has(token)),
  );
  if (followMatch) {
    return {
      checkedAt,
      bucket: "added_follow",
      httpStatus: page.httpStatus,
      finalUrl: page.finalUrl,
      matchedHref: followMatch.resolvedHref,
      matchedRel: followMatch.rel,
      matchCount: matches.length,
      reason: "Link present (follow)",
    };
  }
  const qualified = matches[0];
  return {
    checkedAt,
    bucket: "added_qualified",
    httpStatus: page.httpStatus,
    finalUrl: page.finalUrl,
    matchedHref: qualified.resolvedHref,
    matchedRel: qualified.rel,
    matchCount: matches.length,
    reason: `Link present (rel=${qualified.rel.join(" ")})`,
  };
}

function fetchKeyForSource(sourceUrl: string): string {
  try {
    const u = new URL(sourceUrl);
    u.hash = "";
    return u.href;
  } catch {
    return sourceUrl;
  }
}

export async function auditBacklinkPairs(
  pairs: Pick<BacklinkPair, "id" | "sourceUrl" | "targetUrl">[],
  opts: FetchPageOptions & { concurrency?: number; now?: () => string } = {},
): Promise<Map<string, BacklinkCheck>> {
  const concurrency = Math.max(
    1,
    Math.min(10, opts.concurrency ?? BACKLINK_AUDIT_DEFAULTS.concurrency),
  );
  const uniqueSources = [...new Set(pairs.map((p) => fetchKeyForSource(p.sourceUrl)))];
  const pageCache = new Map<string, PageFetchResult>();
  let cursor = 0;

  async function worker() {
    while (cursor < uniqueSources.length) {
      const idx = cursor++;
      const url = uniqueSources[idx];
      pageCache.set(url, await fetchPublicHtmlPage(url, opts));
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, uniqueSources.length) }, () => worker()),
  );

  const results = new Map<string, BacklinkCheck>();
  const checkedAt = opts.now ? opts.now() : new Date().toISOString();
  for (const pair of pairs) {
    const page = pageCache.get(fetchKeyForSource(pair.sourceUrl))!;
    results.set(pair.id, classifyBacklinkCheck(page, pair.targetUrl, checkedAt));
  }
  return results;
}
