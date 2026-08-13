import {
  emailHash,
  identityHash,
  normalizeEmail,
  digest,
} from "./canonical";
import {
  MigrationFailure,
  type DestinationSnapshot,
} from "./types";

export const DATAOPS_PRODUCTION_ORIGIN = "https://ops.dtcdev.click";

type Fetch = typeof fetch;
type ApiRecord = Record<string, unknown> & { id: string; version: number };
type ApiPage = {
  items: ApiRecord[];
  nextCursor: string | null;
};
type ApiLimits = {
  requestTimeoutMs: number;
  maxResponseBytes: number;
  maxPages: number;
  maxItems: number;
};

const DEFAULT_LIMITS: ApiLimits = {
  requestTimeoutMs: 15_000,
  maxResponseBytes: 2 * 1024 * 1024,
  maxPages: 2_000,
  maxItems: 100_000,
};

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum)
    throw new MigrationFailure("invalid-api-limit");
  return selected;
}

export class SponsorMigrationApi {
  private constructor(
    readonly origin: string,
    private readonly authorization: string,
    private readonly requestFetch: Fetch,
    private readonly sleep: (milliseconds: number) => Promise<void>,
    readonly limits: ApiLimits,
  ) {}

  static create(input: {
    origin: string;
    bearerToken: string;
    allowTestOrigin?: boolean;
    requestFetch?: Fetch;
    sleep?: (milliseconds: number) => Promise<void>;
    requestTimeoutMs?: number;
    maxResponseBytes?: number;
    maxPages?: number;
    maxItems?: number;
  }) {
    let parsed: URL;
    try {
      parsed = new URL(input.origin);
    } catch {
      throw new MigrationFailure("invalid-api-origin");
    }
    if (
      parsed.origin !== input.origin ||
      parsed.protocol !== "https:" ||
      (!input.allowTestOrigin && parsed.origin !== DATAOPS_PRODUCTION_ORIGIN)
    ) throw new MigrationFailure("invalid-api-origin");
    if (
      !/^[A-Za-z0-9._~-]{20,500}$/.test(input.bearerToken) ||
      input.bearerToken.startsWith("eyJ")
    ) throw new MigrationFailure("invalid-operator-credential");
    return new SponsorMigrationApi(
      parsed.origin,
      `Bearer ${input.bearerToken}`,
      input.requestFetch || fetch,
      input.sleep || ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds))),
      {
        requestTimeoutMs: boundedInteger(
          input.requestTimeoutMs, DEFAULT_LIMITS.requestTimeoutMs, 10, 120_000,
        ),
        maxResponseBytes: boundedInteger(
          input.maxResponseBytes, DEFAULT_LIMITS.maxResponseBytes, 128, 64 * 1024 * 1024,
        ),
        maxPages: boundedInteger(input.maxPages, DEFAULT_LIMITS.maxPages, 1, 10_000),
        maxItems: boundedInteger(input.maxItems, DEFAULT_LIMITS.maxItems, 1, 1_000_000),
      },
    );
  }

  private async responseJson<T>(response: Response): Promise<T> {
    const contentLength = response.headers.get("content-length");
    if (
      contentLength !== null &&
      (!/^\d+$/.test(contentLength) || Number(contentLength) > this.limits.maxResponseBytes)
    ) throw new MigrationFailure("api-response-too-large");
    if (!response.body) throw new MigrationFailure("unexpected-api-response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > this.limits.maxResponseBytes) {
          await reader.cancel().catch(() => undefined);
          throw new MigrationFailure("api-response-too-large");
        }
        chunks.push(result.value);
      }
    } finally {
      reader.releaseLock();
    }
    const combined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(combined)) as T;
    } catch {
      throw new MigrationFailure("unexpected-api-response");
    }
  }

  private async raw<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body: unknown,
    retryReads: boolean,
  ): Promise<{ status: number; value?: T }> {
    const attempts = retryReads ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.limits.requestTimeoutMs);
      try {
        const response = await this.requestFetch(`${this.origin}${path}`, {
          method,
          redirect: "manual",
          signal: controller.signal,
          headers: {
            authorization: this.authorization,
            accept: "application/json",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (response.status >= 300 && response.status < 400)
          throw new MigrationFailure("unexpected-api-redirect");
        if (response.status === 401 || response.status === 403)
          throw new MigrationFailure("operator-auth-rejected");
        if (response.status === 404) return { status: 404 };
        if (response.status === 409)
          throw new MigrationFailure("concurrent-destination-change");
        if (response.status === 429 || response.status >= 500)
          throw new MigrationFailure(retryReads ? "api-read-unavailable" : "api-outcome-unknown");
        const contentType = response.headers.get("content-type") || "";
        if (!contentType.toLowerCase().includes("application/json"))
          throw new MigrationFailure("unexpected-api-response");
        const value = await this.responseJson<T>(response);
        if (!response.ok) throw new MigrationFailure("api-request-rejected");
        return { status: response.status, value };
      } catch (error) {
        if (error instanceof MigrationFailure) {
          if (error.reason === "api-response-too-large" && !retryReads)
            throw new MigrationFailure("api-outcome-unknown");
          if (
            error.reason !== "api-read-unavailable" ||
            !retryReads || attempt === attempts - 1
          ) throw error;
        }
        if (retryReads && attempt < attempts - 1) {
          await this.sleep(100 * 2 ** attempt);
          continue;
        }
        throw new MigrationFailure(retryReads ? "api-read-unavailable" : "api-outcome-unknown");
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new MigrationFailure("api-read-unavailable");
  }

  async read<T>(path: string): Promise<T> {
    const result = await this.raw<T>("GET", path, undefined, true);
    if (result.status === 404) throw new MigrationFailure("destination-record-missing");
    return result.value!;
  }

  async readOptional<T>(path: string): Promise<T | undefined> {
    return (await this.raw<T>("GET", path, undefined, true)).value;
  }

  async mutate<T>(
    method: "POST" | "PUT" | "DELETE",
    path: string,
    body: unknown,
  ): Promise<T> {
    const result = await this.raw<T>(method, path, body, false);
    if (result.status === 404) throw new MigrationFailure("destination-record-missing");
    return result.value!;
  }

  async preflight() {
    const result = await this.read<{ user?: { enabled?: boolean } }>("/api/me");
    if (!result.user || result.user.enabled === false)
      throw new MigrationFailure("operator-auth-rejected");
  }
}

async function allCrmRecords(api: SponsorMigrationApi, kind: string) {
  const records: ApiRecord[] = [];
  let cursor: string | null = "0";
  const seenCursors = new Set<string>();
  let pages = 0;
  do {
    if (seenCursors.has(cursor)) throw new MigrationFailure("api-pagination-cycle");
    if (++pages > api.limits.maxPages) throw new MigrationFailure("api-pagination-limit");
    seenCursors.add(cursor);
    const page: ApiPage = await api.read<ApiPage>(
      `/api/sponsor-crm/${kind}?limit=100&cursor=${encodeURIComponent(cursor)}`,
    );
    if (!Array.isArray(page.items) ||
      (page.nextCursor !== null && !/^\d+$/.test(page.nextCursor)))
      throw new MigrationFailure("unexpected-api-response");
    if (page.items.length > 100 || records.length + page.items.length > api.limits.maxItems)
      throw new MigrationFailure("api-pagination-limit");
    records.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return records;
}

export async function exportDestinationSnapshot(
  api: SponsorMigrationApi,
  now = new Date(),
): Promise<DestinationSnapshot> {
  await api.preflight();
  const [organizations, contacts, bookings, newsletter] = await Promise.all([
    allCrmRecords(api, "organizations"),
    allCrmRecords(api, "contacts"),
    allCrmRecords(api, "bookings"),
    api.read<{
      items: ApiRecord[];
    }>(
      "/api/newsletter-slots?from=0001-01-01&to=9999-12-31",
    ),
  ]);
  if (!Array.isArray(newsletter.items))
    throw new MigrationFailure("unexpected-api-response");
  if (newsletter.items.length > api.limits.maxItems)
    throw new MigrationFailure("api-pagination-limit");
  const active = (record: ApiRecord) =>
    record.active !== false && typeof record.archivedAt !== "string";
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    originHash: digest(api.origin),
    organizations: organizations.map((record) => ({
      id: record.id,
      ...(typeof record.sourceKey === "string" ? { sourceKey: record.sourceKey } : {}),
      version: record.version,
      active: active(record),
      normalizedNameHash: identityHash(String(record.displayName || "")),
      ...(typeof record.strongDiscriminator === "string"
        ? { strongDiscriminatorHash: identityHash(record.strongDiscriminator) }
        : {}),
    })).sort((a, b) => a.id.localeCompare(b.id)),
    contacts: contacts.map((record) => ({
      id: record.id,
      organizationId: String(record.organizationId || ""),
      ...(typeof record.sourceKey === "string" ? { sourceKey: record.sourceKey } : {}),
      version: record.version,
      active: active(record),
      normalizedEmailHashes: Array.isArray(record.emails)
        ? [...new Set(record.emails
          .filter((email): email is string => typeof email === "string")
          .map(normalizeEmail)
          .map(emailHash))].sort()
        : [],
    })).sort((a, b) => a.id.localeCompare(b.id)),
    bookings: bookings.map((record) => ({
      id: record.id,
      organizationId: String(record.organizationId || ""),
      ...(typeof record.primaryContactId === "string"
        ? { primaryContactId: record.primaryContactId }
        : {}),
      ...(typeof record.sourceKey === "string" ? { sourceKey: record.sourceKey } : {}),
      version: record.version,
      status: String(record.status || ""),
      slotType: String(record.slotType || ""),
      ...(typeof record.scheduleEntryId === "string"
        ? { scheduleEntryId: record.scheduleEntryId }
        : {}),
    })).sort((a, b) => a.id.localeCompare(b.id)),
    newsletterSlots: newsletter.items.map((record) => ({
      id: record.id,
      version: record.version,
      status: String(record.status || ""),
      ...(typeof record.sponsorBookingId === "string"
        ? { sponsorBookingId: record.sponsorBookingId }
        : {}),
    })).sort((a, b) => a.id.localeCompare(b.id)),
  };
}
