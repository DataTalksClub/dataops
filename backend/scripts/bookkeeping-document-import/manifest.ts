/** Validation for the retained raw bookkeeping archive manifest. */
import { createHash } from "crypto";
import { ImportFailure, MAX_INPUT_CARDINALITY, type Manifest } from "./types";

const HASH = /^(?:sha256:)?[a-f0-9]{64}$/;
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const OPAQUE = /^[a-zA-Z0-9._:-]{1,300}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

function isOpaque(value: unknown): value is string {
  return typeof value === "string" && OPAQUE.test(value);
}

function exactKeys(value: unknown, allowed: string[]) {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => allowed.includes(key))
  );
}

export function validateManifest(input: unknown): Manifest {
  if (
    !isRecord(input) ||
    !exactKeys(input, ["schemaVersion", "archives", "documents", "exclusions"]) ||
    input.schemaVersion !== 1 ||
    !Array.isArray(input.archives) ||
    !input.archives.length ||
    input.archives.length > MAX_INPUT_CARDINALITY.archives ||
    !Array.isArray(input.documents) ||
    input.documents.length > MAX_INPUT_CARDINALITY.documents ||
    !Array.isArray(input.exclusions) ||
    input.exclusions.length > MAX_INPUT_CARDINALITY.exclusions
  )
    throw new ImportFailure("invalid-manifest");

  const manifest = input as unknown as Manifest;
  const archiveAliases = new Set<string>();
  for (const archive of input.archives) {
    if (
      !isRecord(archive) ||
      !exactKeys(archive, ["alias", "year", "sha256"]) ||
      !isOpaque(archive.alias) ||
      archiveAliases.has(archive.alias) ||
      !Number.isInteger(archive.year) ||
      archive.year < 2000 ||
      archive.year > 2100 ||
      !isHash(archive.sha256)
    )
      throw new ImportFailure("invalid-manifest-archive");
    archiveAliases.add(archive.alias);
  }

  const documentHashes = new Set<string>();
  let totalLinks = 0;
  for (const document of input.documents) {
    if (!isRecord(document)) throw new ImportFailure("invalid-document-mapping");
    const statement = ["bank-statement", "private-account-statement"].includes(
      String(document.documentType),
    );
    if (
      !exactKeys(document, [
        "sha256",
        "sources",
        "documentType",
        "accountId",
        "statementMonth",
        "transactions",
        "unlinkedApproved",
      ]) ||
      !isHash(document.sha256) ||
      !["invoice", "receipt", "bank-statement", "private-account-statement", "other-evidence"].includes(
        String(document.documentType),
      ) ||
      !Array.isArray(document.sources) ||
      !document.sources.length ||
      document.sources.length > MAX_INPUT_CARDINALITY.sourcesPerDocument ||
      document.sources.some(
        (source) =>
          !isRecord(source) ||
          !exactKeys(source, ["archive", "member"]) ||
          !isOpaque(source.archive) ||
          !archiveAliases.has(source.archive) ||
          typeof source.member !== "string" ||
          source.member.length < 1 ||
          source.member.length > 1024,
      ) ||
      (statement &&
        (!isOpaque(document.accountId) ||
          typeof document.statementMonth !== "string" ||
          !MONTH.test(document.statementMonth))) ||
      (!statement &&
        (document.accountId !== undefined || document.statementMonth !== undefined)) ||
      (document.unlinkedApproved !== undefined &&
        typeof document.unlinkedApproved !== "boolean") ||
      !Array.isArray(document.transactions) ||
      document.transactions.length > MAX_INPUT_CARDINALITY.transactionsPerDocument ||
      (!document.transactions.length && document.unlinkedApproved !== true) ||
      (document.transactions.length > 0 && document.unlinkedApproved === true)
    )
      throw new ImportFailure("invalid-document-mapping");

    const normalizedHash = document.sha256.replace(/^sha256:/, "");
    if (documentHashes.has(normalizedHash))
      throw new ImportFailure("duplicate-document-hash");
    documentHashes.add(normalizedHash);
    totalLinks += document.transactions.length;
    if (totalLinks > MAX_INPUT_CARDINALITY.totalLinks)
      throw new ImportFailure("manifest-cardinality-exceeded");

    const links = new Set<string>();
    for (const transaction of document.transactions) {
      if (!isRecord(transaction)) throw new ImportFailure("invalid-transaction-mapping");
      const hasSourceKey = transaction.sourceKey !== undefined;
      const hasTransactionId = transaction.transactionId !== undefined;
      const refs = Number(hasSourceKey) + Number(hasTransactionId);
      if (
        !exactKeys(transaction, ["sourceKey", "transactionId", "coverageType"]) ||
        refs !== 1 ||
        !["evidence", "statement-coverage"].includes(String(transaction.coverageType)) ||
        (hasSourceKey && !isOpaque(transaction.sourceKey)) ||
        (hasTransactionId && !isOpaque(transaction.transactionId)) ||
        (statement && transaction.coverageType !== "statement-coverage") ||
        (!statement && transaction.coverageType !== "evidence")
      )
        throw new ImportFailure("invalid-transaction-mapping");
      const reference = hasSourceKey ? transaction.sourceKey : transaction.transactionId;
      const tuple = `${reference}\0${transaction.coverageType}`;
      if (links.has(tuple)) throw new ImportFailure("duplicate-link-mapping");
      links.add(tuple);
    }
  }

  for (const exclusion of input.exclusions) {
    if (
      !isRecord(exclusion) ||
      !exactKeys(exclusion, ["archive", "member", "reason"]) ||
      !isOpaque(exclusion.archive) ||
      !archiveAliases.has(exclusion.archive) ||
      typeof exclusion.member !== "string" ||
      exclusion.member.length < 1 ||
      exclusion.member.length > 1024 ||
      !["unsupported-image", "nested-packaging-archive"].includes(String(exclusion.reason))
    )
      throw new ImportFailure("invalid-exclusion");
  }
  return manifest;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}

export function manifestFingerprint(manifest: Manifest) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(manifest)))
    .digest("hex");
}
