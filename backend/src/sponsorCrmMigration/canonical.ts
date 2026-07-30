import { createHash } from "crypto";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export const digest = (value: unknown) =>
  createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");

export const normalizeText = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");

export const normalizeEmail = (value: string) => value.trim().toLocaleLowerCase("en-US");

export const identityHash = (value: string) => digest(normalizeText(value));
export const emailHash = (value: string) => digest(normalizeEmail(value));

export function sourceKey(
  namespace: string,
  immutableSourceIdentity: string,
  kind: string,
  recordId: string,
) {
  return `${namespace}:${kind}:${digest(`${immutableSourceIdentity}\0${kind}\0${recordId}`)}`;
}

export const operationId = (sourceKeyValue: string, kind: string) =>
  digest(`sponsor-crm-migration-v1\0${kind}\0${sourceKeyValue}`);
