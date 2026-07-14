import { createHash } from "crypto";
import { ImportFailure, MAX_INPUT_CARDINALITY, type Manifest } from "./types";

const HASH = /^(?:sha256:)?[a-f0-9]{64}$/;
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const OPAQUE = /^[a-zA-Z0-9._:-]{1,300}$/;

export function validateManifest(manifest: Manifest) {
  const exactKeys = (value: unknown, allowed: string[]) =>
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).every((key) => allowed.includes(key));
  if (
    !manifest ||
    !exactKeys(manifest, ["schemaVersion", "archives", "documents", "exclusions"]) ||
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.archives) ||
    !manifest.archives.length ||
    manifest.archives.length > MAX_INPUT_CARDINALITY.archives ||
    !Array.isArray(manifest.documents) ||
    manifest.documents.length > MAX_INPUT_CARDINALITY.documents ||
    !Array.isArray(manifest.exclusions)
    || manifest.exclusions.length > MAX_INPUT_CARDINALITY.exclusions
  )
    throw new ImportFailure("invalid-manifest");
  const archiveAliases = new Set<string>();
  for (const archive of manifest.archives)
    if (
      !exactKeys(archive, ["alias", "year", "sha256"]) ||
      !OPAQUE.test(archive.alias) ||
      archiveAliases.has(archive.alias) ||
      !Number.isInteger(archive.year) ||
      archive.year < 2000 ||
      archive.year > 2100 ||
      !HASH.test(archive.sha256)
    )
      throw new ImportFailure("invalid-manifest-archive");
    else archiveAliases.add(archive.alias);
  const documentHashes = new Set<string>();
  let totalLinks = 0;
  for (const document of manifest.documents) {
    const statement = ["bank-statement", "private-account-statement"].includes(document.documentType);
    if (
      !exactKeys(document, ["sha256", "sources", "documentType", "accountId", "statementMonth", "transactions", "unlinkedApproved"]) ||
      !HASH.test(document.sha256) ||
      !["invoice", "receipt", "bank-statement", "private-account-statement", "other-evidence"].includes(document.documentType) ||
      !Array.isArray(document.sources) ||
      !document.sources.length ||
      document.sources.length > MAX_INPUT_CARDINALITY.sourcesPerDocument ||
      document.sources.some(
        (source) =>
          !exactKeys(source, ["archive", "member"]) ||
          !archiveAliases.has(source.archive) ||
          typeof source.member !== "string" ||
          source.member.length < 1 ||
          source.member.length > 1024,
      ) ||
      (statement && (!OPAQUE.test(document.accountId || "") || !MONTH.test(document.statementMonth || ""))) ||
      (!statement && (document.accountId !== undefined || document.statementMonth !== undefined)) ||
      !Array.isArray(document.transactions) ||
      document.transactions.length > MAX_INPUT_CARDINALITY.transactionsPerDocument ||
      (!document.transactions.length && document.unlinkedApproved !== true) ||
      (document.transactions.length > 0 && document.unlinkedApproved === true)
    )
      throw new ImportFailure("invalid-document-mapping");
    const normalizedHash = document.sha256.replace(/^sha256:/, "");
    if (documentHashes.has(normalizedHash)) throw new ImportFailure("duplicate-document-hash");
    documentHashes.add(normalizedHash);
    totalLinks += document.transactions.length;
    if (totalLinks > MAX_INPUT_CARDINALITY.totalLinks)
      throw new ImportFailure("manifest-cardinality-exceeded");
    const links = new Set<string>();
    for (const transaction of document.transactions) {
      const refs = Number(!!transaction.sourceKey) + Number(!!transaction.transactionId);
      if (
        !exactKeys(transaction, ["sourceKey", "transactionId", "coverageType"]) ||
        refs !== 1 ||
        !["evidence", "statement-coverage"].includes(transaction.coverageType) ||
        (transaction.sourceKey !== undefined && !OPAQUE.test(transaction.sourceKey)) ||
        (transaction.transactionId !== undefined && !OPAQUE.test(transaction.transactionId)) ||
        (statement && transaction.coverageType !== "statement-coverage") ||
        (!statement && transaction.coverageType !== "evidence")
      )
        throw new ImportFailure("invalid-transaction-mapping");
      const tuple = `${transaction.sourceKey || transaction.transactionId}\0${transaction.coverageType}`;
      if (links.has(tuple)) throw new ImportFailure("duplicate-link-mapping");
      links.add(tuple);
    }
  }
  for (const exclusion of manifest.exclusions)
    if (
      !exactKeys(exclusion, ["archive", "member", "reason"]) ||
      !archiveAliases.has(exclusion.archive) ||
      typeof exclusion.member !== "string" ||
      exclusion.member.length < 1 ||
      exclusion.member.length > 1024 ||
      !["unsupported-image", "nested-packaging-archive"].includes(exclusion.reason)
    )
      throw new ImportFailure("invalid-exclusion");
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
