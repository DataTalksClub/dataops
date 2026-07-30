export type StoragePaginationLimits = {
  maxPages: number;
  maxItems: number;
  maxBytes: number;
  deadlineMs: number;
};

export const SNAPSHOT_STORAGE_LIMITS: StoragePaginationLimits = {
  maxPages: 10_000,
  maxItems: 250_000,
  maxBytes: 128 * 1024 * 1024,
  deadlineMs: 30_000,
};

export class StoragePaginationError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "StoragePaginationError";
  }
}

const plainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (plainObject(value))
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  const rendered = JSON.stringify(value);
  if (rendered === undefined) throw new StoragePaginationError("storage-pagination-malformed");
  return rendered;
}

export const storageSnapshotDigest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");

function cursor(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (
    !plainObject(value) ||
    Object.keys(value).length < 1 ||
    Object.keys(value).length > 16 ||
    Object.entries(value).some(([key, child]) =>
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(key) ||
      (typeof child !== "string" && typeof child !== "number") ||
      (typeof child === "string" && (child.length < 1 || child.length > 2048)) ||
      (typeof child === "number" && !Number.isFinite(child)))
  ) throw new StoragePaginationError("storage-pagination-malformed");
  return value;
}

function validateLimits(limits: StoragePaginationLimits) {
  if (
    !Number.isSafeInteger(limits.maxPages) || limits.maxPages < 1 ||
    !Number.isSafeInteger(limits.maxItems) || limits.maxItems < 1 ||
    !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1 ||
    !Number.isSafeInteger(limits.deadlineMs) || limits.deadlineMs < 1
  ) throw new StoragePaginationError("storage-pagination-limits-invalid");
}

export async function collectBoundedPages<T>(input: {
  loadPage: (
    exclusiveStartKey: Record<string, unknown> | undefined,
    abortSignal: AbortSignal,
  ) => Promise<{ Items?: unknown; LastEvaluatedKey?: unknown }>;
  limits?: StoragePaginationLimits;
  now?: () => number;
}): Promise<T[]> {
  const limits = input.limits || SNAPSHOT_STORAGE_LIMITS;
  validateLimits(limits);
  const now = input.now || Date.now;
  const startedAt = now();
  const items: T[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;

  for (let page = 0; page < limits.maxPages; page++) {
    const remaining = limits.deadlineMs - (now() - startedAt);
    if (remaining <= 0)
      throw new StoragePaginationError("storage-pagination-timeout");
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new StoragePaginationError("storage-pagination-timeout"));
      }, remaining);
    });
    let result: { Items?: unknown; LastEvaluatedKey?: unknown };
    try {
      result = await Promise.race([
        input.loadPage(exclusiveStartKey, controller.signal),
        deadline,
      ]);
    } catch (error) {
      if (error instanceof StoragePaginationError) throw error;
      throw new StoragePaginationError(
        controller.signal.aborted
          ? "storage-pagination-timeout"
          : "storage-pagination-failed",
      );
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    const pageItems = result.Items === undefined ? [] : result.Items;
    if (!Array.isArray(pageItems))
      throw new StoragePaginationError("storage-pagination-malformed");
    if (items.length + pageItems.length > limits.maxItems)
      throw new StoragePaginationError("storage-pagination-item-limit");
    for (const item of pageItems) {
      if (!plainObject(item))
        throw new StoragePaginationError("storage-pagination-malformed");
      try {
        bytes += Buffer.byteLength(canonical(item), "utf8");
      } catch (error) {
        if (error instanceof StoragePaginationError) throw error;
        throw new StoragePaginationError("storage-pagination-malformed");
      }
      if (bytes > limits.maxBytes)
        throw new StoragePaginationError("storage-pagination-byte-limit");
      items.push(item as T);
    }
    const next = cursor(result.LastEvaluatedKey);
    if (!next) return items;
    const fingerprint = canonical(next);
    if (seen.has(fingerprint))
      throw new StoragePaginationError("storage-pagination-cycle");
    seen.add(fingerprint);
    exclusiveStartKey = next;
  }
  throw new StoragePaginationError("storage-pagination-page-limit");
}
import { createHash } from "crypto";
