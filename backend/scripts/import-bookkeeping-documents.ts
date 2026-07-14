import { createHash, randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { inspectArchives, openArchiveMember } from "../src/bookkeeping-document-import/archive";
import { BookkeepingApi, PRODUCTION_ORIGIN } from "../src/bookkeeping-document-import/api";
import { manifestFingerprint, validateManifest } from "../src/bookkeeping-document-import/manifest";
import {
  DEFAULT_LIMITS,
  ImportFailure,
  MAX_INPUT_CARDINALITY,
  validateInventoryLimits,
  type ArchiveInput,
  type InventoryLimits,
  type Manifest,
} from "../src/bookkeeping-document-import/types";

const IMPORTER_VERSION = "bookkeeping-document-import-v1";
const RUN_ID = /^(?!\.{1,2}$)[A-Za-z0-9._:-]{1,160}$/;
type Arguments = {
  archives: ArchiveInput[];
  manifest?: string;
  cookieFile?: string;
  write: boolean;
  confirmOrigin?: string;
  approval?: string;
  runId?: string;
  rollback: boolean;
  backfillHashClaims?: boolean;
  apiBaseUrl?: string;
  limits: InventoryLimits;
};
type CategorizedCounts = {
  archiveYears: Record<string, number>;
  documentTypes: Record<string, number>;
  statements: Record<string, number>;
  unlinkedApproved: number;
  exclusions: Record<string, number>;
  rejectedReasons: Record<string, number>;
};
type PlannedDocument = {
  sha256: string;
  byteSize: number;
  documentType: string;
  accountId?: string;
  statementMonth?: string;
  outcome: "create" | "reuse";
  documentId?: string;
};
type PlannedLink = {
  documentSha256: string;
  transactionId: string;
  coverageType: string;
  outcome: "create" | "reuse";
  linkId?: string;
};
type ImportPlan = {
  occurrences: number;
  unique: number;
  duplicates: number;
  exclusions: number;
  links: number;
  documentOutcomes: { create: number; reuse: number };
  linkOutcomes: { create: number; reuse: number };
  categories: CategorizedCounts;
  documents: PlannedDocument[];
  linkTuples: PlannedLink[];
};
type Approval = {
  schemaVersion: 1;
  importerVersion: string;
  runId: string;
  origin: string;
  expiresAt: string;
  manifestFingerprint: string;
  archiveFingerprints: Record<string, string>;
  limits: InventoryLimits;
  plan: ImportPlan;
  fingerprint: string;
};
type Checkpoint = {
  schemaVersion: 1;
  runId: string;
  documents: Record<string, { id: string; outcome: "created" | "existing" }>;
  links: Record<string, { id: string; outcome: "created" | "existing" }>;
  pendingDocuments?: Record<string, { id: string; idempotencyKey: string }>;
};

function parseArguments(argv: string[]): Arguments {
  const result: Arguments = { archives: [], write: false, rollback: false, backfillHashClaims: false, limits: { ...DEFAULT_LIMITS } };
  const limitFlags: Record<string, keyof InventoryLimits> = {
    "--max-archive-bytes": "maxArchiveBytes",
    "--max-members": "maxMembers",
    "--max-compressed-bytes": "maxCompressedBytes",
    "--max-member-bytes": "maxMemberBytes",
    "--max-total-bytes": "maxTotalBytes",
    "--max-compression-ratio": "maxCompressionRatio",
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--archive" && value) {
      const separator = value.indexOf("=");
      if (separator < 1) throw new ImportFailure("invalid-arguments");
      result.archives.push({ alias: value.slice(0, separator), path: value.slice(separator + 1) });
      index += 1;
    } else if (limitFlags[flag] && value) {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) throw new ImportFailure("invalid-inventory-limits");
      result.limits[limitFlags[flag]] = parsed;
      index += 1;
    } else if (flag === "--manifest" && value) (result.manifest = value), (index += 1);
    else if (flag === "--auth-cookie-file" && value) (result.cookieFile = value), (index += 1);
    else if (flag === "--approval" && value) (result.approval = value), (index += 1);
    else if (flag === "--confirm-origin" && value) (result.confirmOrigin = value), (index += 1);
    else if (flag === "--run-id" && value) (result.runId = value), (index += 1);
    else if (flag === "--api-base-url" && value) (result.apiBaseUrl = value.replace(/\/$/, "")), (index += 1);
    else if (flag === "--write") result.write = true;
    else if (flag === "--rollback") result.rollback = true;
    else if (flag === "--backfill-hash-claims") result.backfillHashClaims = true;
    else throw new ImportFailure("invalid-arguments");
  }
  if (result.cookieFile && process.env.DATAOPS_OPERATOR_SESSION_TOKEN)
    throw new ImportFailure("invalid-auth-mode");
  if (result.runId && !RUN_ID.test(result.runId))
    throw new ImportFailure("invalid-run-id");
  if (result.archives.length > MAX_INPUT_CARDINALITY.archives)
    throw new ImportFailure("manifest-cardinality-exceeded");
  validateInventoryLimits(result.limits);
  return result;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "fingerprint")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const fingerprint = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const opaque = (runId: string, kind: string, index: number) =>
  createHash("sha256").update(`${runId}:${kind}:${index}`).digest("hex");
const counts = (values: string[]) =>
  Object.fromEntries(
    [...new Set(values)].sort().map((value) => [
      value,
      values.filter((candidate) => candidate === value).length,
    ]),
  );
function categories(manifest: Manifest, inventory: Awaited<ReturnType<typeof inspectArchives>>) {
  return {
    archiveYears: counts(
      inventory.accepted.map((item) =>
        String(manifest.archives.find((archive) => archive.alias === item.archive)!.year),
      ),
    ),
    documentTypes: counts(manifest.documents.map((item) => item.documentType)),
    statements: counts(
      manifest.documents.flatMap((item) =>
        item.accountId ? [`${item.accountId}:${item.statementMonth}`] : [],
      ),
    ),
    unlinkedApproved: manifest.documents.filter((item) => item.unlinkedApproved).length,
    exclusions: counts(inventory.excluded.map((item) => item.reason)),
    rejectedReasons: {},
  };
}

async function privateDirectory(runId: string) {
  if (!RUN_ID.test(runId)) throw new ImportFailure("invalid-run-id");
  const temporaryRoot = path.resolve(process.cwd(), "../.tmp");
  let rootStat = await fs.lstat(temporaryRoot).catch(() => null);
  if (!rootStat) {
    const project = await fs.lstat(path.dirname(temporaryRoot));
    if (
      !project.isDirectory() ||
      project.isSymbolicLink() ||
      (typeof process.getuid === "function" && project.uid !== process.getuid())
    )
      throw new ImportFailure("unsafe-evidence-root");
    await fs.mkdir(temporaryRoot, { mode: 0o700 });
    rootStat = await fs.lstat(temporaryRoot);
  }
  if (
    !rootStat?.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (typeof process.getuid === "function" && rootStat.uid !== process.getuid())
  )
    throw new ImportFailure("unsafe-evidence-root");
  const root = path.join(temporaryRoot, "bookkeeping-document-import");
  const existingRoot = await fs.lstat(root).catch(() => null);
  if (!existingRoot) await fs.mkdir(root, { mode: 0o700 });
  const securedRoot = await fs.lstat(root);
  if (
    !securedRoot.isDirectory() ||
    securedRoot.isSymbolicLink() ||
    (securedRoot.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && securedRoot.uid !== process.getuid())
  )
    throw new ImportFailure("unsafe-evidence-root");
  const directory = path.join(root, runId);
  const existing = await fs.lstat(directory).catch(() => null);
  if (!existing) await fs.mkdir(directory, { mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  )
    throw new ImportFailure("unsafe-evidence-directory");
  return directory;
}
async function privateWrite(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, file);
}
async function journal(directory: string, value: unknown) {
  const file = path.join(directory, "journal.ndjson");
  await fs.appendFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}
async function loadCheckpoint(directory: string, runId: string): Promise<Checkpoint> {
  const file = path.join(directory, "checkpoint.json");
  try {
    const stat = await fs.lstat(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    )
      throw new ImportFailure("unsafe-checkpoint");
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    if (parsed.schemaVersion !== 1 || parsed.runId !== runId) throw new Error();
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { schemaVersion: 1, runId, documents: {}, links: {} };
    if (error instanceof ImportFailure) throw error;
    throw new ImportFailure("stale-checkpoint");
  }
}

async function resolveTransactions(api: BookkeepingApi, manifest: Manifest) {
  const sourceKeys = [...new Set(manifest.documents.flatMap((document) => document.transactions.flatMap((item) => item.sourceKey ? [item.sourceKey] : [])))];
  const resolved = new Map<string, string>();
  for (let start = 0; start < sourceKeys.length; start += 100) {
    const response = await api.request<{ resolved: { sourceKey: string; id: string }[]; missing: string[] }>("POST", "/api/bookkeeping/transactions/resolve", { sourceKeys: sourceKeys.slice(start, start + 100) });
    const requested = sourceKeys.slice(start, start + 100);
    if (
      response.missing.length ||
      response.resolved.length !== requested.length ||
      new Set(response.resolved.map((item) => item.sourceKey)).size !== requested.length ||
      response.resolved.some(
        (item) => !requested.includes(item.sourceKey) || !item.id,
      )
    )
      throw new ImportFailure("unknown-transaction");
    for (const item of response.resolved) resolved.set(item.sourceKey, item.id);
  }
  for (const transactionId of new Set(manifest.documents.flatMap((document) => document.transactions.flatMap((item) => item.transactionId ? [item.transactionId] : []))))
    await api.request("GET", `/api/bookkeeping/transactions/${encodeURIComponent(transactionId)}`);
  return resolved;
}

async function validateAccounts(api: BookkeepingApi, manifest: Manifest) {
  const response = await api.request<{
    items: { id: string; kind: string; active?: boolean }[];
  }>("GET", "/api/bookkeeping/accounts");
  const accounts = new Map(response.items.map((item) => [item.id, item]));
  if (
    manifest.documents.some((document) => {
      if (!document.accountId) return false;
      const account = accounts.get(document.accountId);
      return (
        !account ||
        account.active === false ||
        (document.documentType === "bank-statement" && account.kind !== "business") ||
        (document.documentType === "private-account-statement" && account.kind !== "private")
      );
    })
  )
    throw new ImportFailure("unknown-account");
}

async function hashLookups(api: BookkeepingApi, hashes: string[]) {
  const states: { state: string; documentId?: string; byteSize?: number; documentType?: string; accountId?: string; statementMonth?: string }[] = [];
  for (let start = 0; start < hashes.length; start += 100) {
    const requested = hashes.slice(start, start + 100);
    const response = await api.request<{ results: typeof states }>("POST", "/api/bookkeeping/documents/hash-lookup", { hashes: requested });
    if (response.results.length !== requested.length)
      throw new ImportFailure("document-reconciliation-mismatch");
    states.push(...response.results);
  }
  return states;
}

async function linkLookups(
  api: BookkeepingApi,
  tuples: { documentId: string; transactionId: string; coverageType: string }[],
) {
  const results: { state: string; id?: string }[] = [];
  for (let start = 0; start < tuples.length; start += 100) {
    const requested = tuples.slice(start, start + 100);
    const response = await api.request<{ results: { state: string; id?: string }[] }>(
      "POST",
      "/api/bookkeeping/links/lookup",
      { tuples: requested },
    );
    if (response.results.length !== requested.length)
      throw new ImportFailure("link-reconciliation-mismatch");
    results.push(...response.results);
  }
  return results;
}

async function buildPlan(
  api: BookkeepingApi,
  manifest: Manifest,
  inventory: Awaited<ReturnType<typeof inspectArchives>>,
  states: Awaited<ReturnType<typeof hashLookups>>,
  resolved: Map<string, string>,
): Promise<ImportPlan> {
  const documents = manifest.documents.map((document, index): PlannedDocument => {
    const sha256 = document.sha256.replace(/^sha256:/, "");
    const source = inventory.accepted.find((item) => item.sha256 === sha256);
    if (!source) throw new ImportFailure("manifest-content-mismatch");
    const state = states[index];
    return {
      sha256,
      byteSize: source.byteSize,
      documentType: document.documentType,
      ...(document.accountId ? { accountId: document.accountId, statementMonth: document.statementMonth } : {}),
      outcome: state.state === "active" ? "reuse" : "create",
      ...(state.state === "active" ? { documentId: state.documentId } : {}),
    };
  });
  const activeTuples: { documentId: string; transactionId: string; coverageType: string }[] = [];
  const linkBases = manifest.documents.flatMap((document, documentIndex) =>
    document.transactions.map((transaction) => {
      const transactionId = transaction.sourceKey
        ? resolved.get(transaction.sourceKey)!
        : transaction.transactionId!;
      const documentId = states[documentIndex].state === "active"
        ? states[documentIndex].documentId
        : undefined;
      if (documentId)
        activeTuples.push({ documentId, transactionId, coverageType: transaction.coverageType });
      return {
        documentSha256: documents[documentIndex].sha256,
        transactionId,
        coverageType: transaction.coverageType,
        documentId,
      };
    }),
  );
  const tupleKeys = linkBases.map((item) =>
    `${item.documentSha256}\0${item.transactionId}\0${item.coverageType}`,
  );
  if (new Set(tupleKeys).size !== tupleKeys.length)
    throw new ImportFailure("duplicate-link-mapping");
  const activeResults = await linkLookups(api, activeTuples);
  let activeIndex = 0;
  const linkTuples = linkBases.map((item): PlannedLink => {
    const result = item.documentId ? activeResults[activeIndex++] : { state: "absent" };
    if (!["active", "absent"].includes(result.state))
      throw new ImportFailure("link-reconciliation-mismatch");
    return {
      documentSha256: item.documentSha256,
      transactionId: item.transactionId,
      coverageType: item.coverageType,
      outcome: result.state === "active" ? "reuse" : "create",
      ...(result.state === "active" ? { linkId: result.id } : {}),
    };
  });
  return {
    occurrences: inventory.occurrenceCount,
    unique: inventory.uniqueCount,
    duplicates: inventory.duplicateCount,
    exclusions: inventory.excluded.length,
    links: linkTuples.length,
    documentOutcomes: {
      create: documents.filter((item) => item.outcome === "create").length,
      reuse: documents.filter((item) => item.outcome === "reuse").length,
    },
    linkOutcomes: {
      create: linkTuples.filter((item) => item.outcome === "create").length,
      reuse: linkTuples.filter((item) => item.outcome === "reuse").length,
    },
    categories: categories(manifest, inventory),
    documents,
    linkTuples,
  };
}

async function runOwnedPages(
  api: BookkeepingApi,
  runId: string,
  kind: "document" | "link",
) {
  const items: Record<string, unknown>[] = [];
  let nextToken: string | undefined;
  do {
    const page = await api.request<{
      items: Record<string, unknown>[];
      nextToken?: string;
    }>("POST", `/api/bookkeeping/migration-runs/${encodeURIComponent(runId)}/reconcile`, {
      kind,
      limit: 100,
      ...(nextToken ? { nextToken } : {}),
    });
    items.push(...page.items);
    nextToken = page.nextToken;
  } while (nextToken);
  return items;
}

export async function runImport(args: Arguments, api: BookkeepingApi) {
  await api.preflight(); // Authentication must succeed before any archive byte is read.
  if (args.runId && !RUN_ID.test(args.runId)) throw new ImportFailure("invalid-run-id");
  if (args.backfillHashClaims) {
    if (args.write && args.confirmOrigin !== api.origin)
      throw new ImportFailure("environment-confirmation-required");
    const result = await api.request<{
      conflicts: number;
      unclaimable: number;
      ready: boolean;
    }>("POST", "/api/bookkeeping/documents/hash-claims/backfill", {
      write: args.write,
    });
    if (result.conflicts || result.unclaimable)
      throw new ImportFailure("hash-claim-conflict");
    return { mode: "hash-claim-backfill", write: args.write, ...result };
  }
  if (args.rollback) {
    if (!args.runId) throw new ImportFailure("invalid-arguments");
    if (args.write && args.confirmOrigin !== api.origin) throw new ImportFailure("environment-confirmation-required");
    const directory = await privateDirectory(args.runId);
    const preview = await api.request<{
      links: number;
      documents: number;
      refusedDocuments: number;
      deferredDocuments: number;
    }>("POST", `/api/bookkeeping/migration-runs/${encodeURIComponent(args.runId)}/rollback`, {
      write: false,
    });
    await journal(directory, { kind: "rollback-preview", ...preview });
    await privateWrite(path.join(directory, "rollback-preview.json"), preview);
    if (!args.write) return preview;
    let result: {
      remainingDocuments?: number;
      remainingLinks?: number;
      failedDocuments?: number;
      refusedDocuments?: number;
    };
    try {
      result = await api.request("POST", `/api/bookkeeping/migration-runs/${encodeURIComponent(args.runId)}/rollback`, {
        write: true,
      });
    } catch (error) {
      const failure = {
        kind: "rollback-write-failure",
        reason: error instanceof ImportFailure ? error.reason : "unexpected-failure",
        retryable: true,
      };
      await journal(directory, failure);
      await privateWrite(path.join(directory, "rollback-result.json"), failure);
      throw error;
    }
    await journal(directory, { kind: "rollback-write", ...result });
    await privateWrite(path.join(directory, "rollback-result.json"), result);
    if (
      result.failedDocuments !== 0 ||
      result.remainingLinks !== 0 ||
      result.remainingDocuments !== preview.refusedDocuments
    )
      throw new ImportFailure("rollback-reconciliation-mismatch");
    return result;
  }
  if (!args.manifest || !args.archives.length) throw new ImportFailure("invalid-arguments");
  const limits = validateInventoryLimits(args.limits || { ...DEFAULT_LIMITS });
  let manifest: Manifest;
  try {
    const manifestStat = await fs.lstat(args.manifest);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 8 * 1024 * 1024)
      throw new ImportFailure("invalid-manifest");
    manifest = validateManifest(
      JSON.parse(await fs.readFile(args.manifest, "utf8")) as Manifest,
    );
  } catch (error) {
    if (error instanceof ImportFailure) throw error;
    throw new ImportFailure("invalid-manifest");
  }
  const inventory = await inspectArchives(args.archives, manifest, limits);
  const hashes = manifest.documents.map((document) => document.sha256.replace(/^sha256:/, ""));
  const dryRunClaims = await api.request<{ conflicts: number; unclaimable: number; created: number; ready: boolean }>("POST", "/api/bookkeeping/documents/hash-claims/backfill", { write: false });
  if (dryRunClaims.conflicts || dryRunClaims.unclaimable) throw new ImportFailure("hash-claim-conflict");
  if (dryRunClaims.created || !dryRunClaims.ready)
    throw new ImportFailure("hash-claims-not-ready");
  const existing = await hashLookups(api, hashes);
  if (
    existing.some((item) =>
      args.write
        ? !["absent", "active", "pending", "cleanup-required"].includes(item.state)
        : !["absent", "active"].includes(item.state),
    )
  )
    throw new ImportFailure("content-upload-pending");
  for (const [index, state] of existing.entries()) {
    if (state.state !== "active") continue;
    const document = manifest.documents[index];
    const inventoryDocument = inventory.accepted.find(
      (item) => item.sha256 === hashes[index],
    )!;
    if (
      Number(state.byteSize) !== inventoryDocument.byteSize ||
      state.documentType !== document.documentType ||
      (state.accountId || undefined) !== (document.accountId || undefined) ||
      (state.statementMonth || undefined) !==
        (document.statementMonth || undefined)
    )
      throw new ImportFailure("existing-document-metadata-mismatch");
  }
  const resolved = await resolveTransactions(api, manifest);
  await validateAccounts(api, manifest);
  const links = manifest.documents.reduce((total, document) => total + document.transactions.length, 0);
  const currentPlan = await buildPlan(api, manifest, inventory, existing, resolved);
  if (!args.write) {
    const runId = args.runId || randomUUID();
    const directory = await privateDirectory(runId);
    const approvalBase = {
      schemaVersion: 1 as const,
      importerVersion: IMPORTER_VERSION,
      runId,
      origin: api.origin,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      manifestFingerprint: manifestFingerprint(manifest),
      archiveFingerprints: inventory.archiveFingerprints,
      limits,
      plan: currentPlan,
    };
    const approval: Approval = { ...approvalBase, fingerprint: fingerprint(approvalBase) };
    await privateWrite(path.join(directory, "approval.json"), approval);
    await privateWrite(path.join(directory, "inventory.json"), {
      inventory,
      manifest,
      categories: categories(manifest, inventory),
    });
    return {
      mode: "dry-run",
      runId,
      occurrences: currentPlan.occurrences,
      unique: currentPlan.unique,
      duplicates: currentPlan.duplicates,
      exclusions: currentPlan.exclusions,
      links,
      plannedDocumentCreates: currentPlan.documentOutcomes.create,
      plannedDocumentReuses: currentPlan.documentOutcomes.reuse,
      plannedLinkCreates: currentPlan.linkOutcomes.create,
      plannedLinkReuses: currentPlan.linkOutcomes.reuse,
    };
  }
  if (!args.approval || args.confirmOrigin !== api.origin)
    throw new ImportFailure("environment-confirmation-required");
  const approvalStat = await fs.lstat(args.approval).catch(() => null);
  if (
    !approvalStat?.isFile() ||
    approvalStat.isSymbolicLink() ||
    (approvalStat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && approvalStat.uid !== process.getuid())
  )
    throw new ImportFailure("unsafe-approval-file");
  let approval: Approval;
  try {
    approval = JSON.parse(await fs.readFile(args.approval, "utf8")) as Approval;
  } catch {
    throw new ImportFailure("stale-dry-run-approval");
  }
  if (!RUN_ID.test(String(approval.runId || "")))
    throw new ImportFailure("invalid-run-id");
  const expectedApproval = path.join(
    await privateDirectory(approval.runId),
    "approval.json",
  );
  if (path.resolve(args.approval) !== expectedApproval)
    throw new ImportFailure("unsafe-approval-file");
  const approvalExpiry = Date.parse(approval.expiresAt);
  if (
    approval.schemaVersion !== 1 ||
    approval.importerVersion !== IMPORTER_VERSION ||
    approval.origin !== api.origin ||
    !Number.isFinite(approvalExpiry) ||
    approvalExpiry <= Date.now() ||
    approval.manifestFingerprint !== manifestFingerprint(manifest) ||
    canonical(approval.archiveFingerprints) !== canonical(inventory.archiveFingerprints) ||
    canonical(approval.limits) !== canonical(limits) ||
    approval.fingerprint !== fingerprint(approval)
  )
    throw new ImportFailure("stale-dry-run-approval");
  const runId = approval.runId;
  const directory = await privateDirectory(runId);
  const checkpoint = await loadCheckpoint(directory, runId);
  checkpoint.pendingDocuments ||= {};
  const initialRunDocuments = await runOwnedPages(api, runId, "document");
  const initialRunLinks = await runOwnedPages(api, runId, "link");
  const initialRunDocumentIds = new Set(initialRunDocuments.map((item) => String(item.id)));
  const initialRunLinkIds = new Set(initialRunLinks.map((item) => String(item.id)));
  if (
    !approval.plan ||
    canonical({
      occurrences: approval.plan.occurrences,
      unique: approval.plan.unique,
      duplicates: approval.plan.duplicates,
      exclusions: approval.plan.exclusions,
      links: approval.plan.links,
      categories: approval.plan.categories,
      documents: approval.plan.documents?.map(({ outcome: _outcome, documentId: _id, ...item }) => item),
      linkTuples: approval.plan.linkTuples?.map(({ outcome: _outcome, linkId: _id, ...item }) => item),
    }) !== canonical({
      occurrences: currentPlan.occurrences,
      unique: currentPlan.unique,
      duplicates: currentPlan.duplicates,
      exclusions: currentPlan.exclusions,
      links: currentPlan.links,
      categories: currentPlan.categories,
      documents: currentPlan.documents.map(({ outcome: _outcome, documentId: _id, ...item }) => item),
      linkTuples: currentPlan.linkTuples.map(({ outcome: _outcome, linkId: _id, ...item }) => item),
    })
  )
    throw new ImportFailure("stale-dry-run-approval");
  for (const [index, planned] of approval.plan.documents.entries()) {
    const current = currentPlan.documents[index];
    if (
      planned.outcome === "create" &&
      current.outcome === "reuse" &&
      current.documentId &&
      initialRunDocumentIds.has(current.documentId)
    )
      checkpoint.documents[planned.sha256] = { id: current.documentId, outcome: "created" };
    if (
      planned.outcome === "reuse"
        ? current.outcome !== "reuse" || current.documentId !== planned.documentId
        : current.outcome === "reuse" &&
          (!checkpoint.documents[planned.sha256] ||
            checkpoint.documents[planned.sha256].id !== current.documentId ||
            !initialRunDocumentIds.has(current.documentId!))
    )
      throw new ImportFailure("stale-dry-run-approval");
  }
  const linkCoordinates = manifest.documents.flatMap((document, documentIndex) =>
    document.transactions.map((_transaction, transactionIndex) => ({ documentIndex, transactionIndex })),
  );
  for (const [index, planned] of approval.plan.linkTuples.entries()) {
    const current = currentPlan.linkTuples[index];
    const coordinate = linkCoordinates[index];
    if (!current || !coordinate) throw new ImportFailure("stale-dry-run-approval");
    const tuple = opaque(runId, `link:${coordinate.documentIndex}`, coordinate.transactionIndex);
    if (
      planned.outcome === "create" &&
      current.outcome === "reuse" &&
      current.linkId &&
      initialRunLinkIds.has(current.linkId)
    )
      checkpoint.links[tuple] = { id: current.linkId, outcome: "created" };
    if (
      planned.outcome === "reuse"
        ? current.outcome !== "reuse" || current.linkId !== planned.linkId
        : current.outcome === "reuse" &&
          (!checkpoint.links[tuple] || checkpoint.links[tuple].id !== current.linkId || !initialRunLinkIds.has(current.linkId!))
    )
      throw new ImportFailure("stale-dry-run-approval");
  }
  await privateWrite(path.join(directory, "checkpoint.json"), checkpoint);
  await api.request("POST", "/api/bookkeeping/documents/hash-claims/backfill", { write: true });
  for (const [hash, saved] of Object.entries(checkpoint.documents)) {
    const index = hashes.indexOf(hash);
    if (
      index < 0 ||
      existing[index]?.state !== "active" ||
      existing[index]?.documentId !== saved.id
    )
      throw new ImportFailure("stale-checkpoint");
    saved.outcome = initialRunDocumentIds.has(saved.id) ? "created" : "existing";
  }
  let createdDocuments = 0;
  let createdLinks = 0;
  for (const [index, document] of manifest.documents.entries()) {
    const sha256 = hashes[index];
    if (!checkpoint.documents[sha256]) {
      const source = document.sources[0];
      const inventorySource = inventory.accepted.find((item) => item.archive === source.archive && item.member === source.member)!;
      const idempotencyKey = opaque(runId, "document", index);
      const sourceRef = opaque(runId, "source", index);
      const prepared = await api.request<{ outcome: "created" | "retry" | "existing"; document: { id: string }; uploadUrl?: string; uploadHeaders?: Record<string, string> }>("POST", "/api/bookkeeping/documents/prepare", {
        sha256,
        byteSize: inventorySource.byteSize,
        documentType: document.documentType,
        ...(document.accountId ? { accountId: document.accountId, statementMonth: document.statementMonth } : {}),
        idempotencyKey,
        runId,
        sourceRef,
      });
      let outcome: "created" | "existing" =
        prepared.outcome === "existing" &&
        !initialRunDocumentIds.has(prepared.document.id)
          ? "existing"
          : "created";
      if (prepared.uploadUrl && prepared.uploadHeaders) {
        checkpoint.pendingDocuments[sha256] = {
          id: prepared.document.id,
          idempotencyKey,
        };
        await journal(directory, {
          kind: "document-prepared",
          index,
          id: prepared.document.id,
        });
        await privateWrite(path.join(directory, "checkpoint.json"), checkpoint);
        const archive = args.archives.find((item) => item.alias === source.archive)!;
        await api.upload(prepared.uploadUrl, prepared.uploadHeaders, () =>
          openArchiveMember(archive.path, source.member, {
            archiveSha256: inventory.archiveFingerprints[source.archive],
            sha256,
            byteSize: inventorySource.byteSize,
          }, limits),
        );
        const completed = await api.request<{ document: { id: string } }>("POST", `/api/bookkeeping/documents/${prepared.document.id}/complete`, { idempotencyKey, runId });
        prepared.document = completed.document;
      }
      checkpoint.documents[sha256] = { id: prepared.document.id, outcome };
      delete checkpoint.pendingDocuments[sha256];
      if (outcome === "created") createdDocuments += 1;
      await journal(directory, { kind: "document", index, outcome, id: prepared.document.id });
      await privateWrite(path.join(directory, "checkpoint.json"), checkpoint);
    }
  }
  for (const [documentIndex, document] of manifest.documents.entries()) {
    const documentId = checkpoint.documents[hashes[documentIndex]].id;
    for (const [transactionIndex, transaction] of document.transactions.entries()) {
      const transactionId = transaction.sourceKey ? resolved.get(transaction.sourceKey)! : transaction.transactionId!;
      const tuple = opaque(runId, `link:${documentIndex}`, transactionIndex);
      if (checkpoint.links[tuple]) {
        const saved = checkpoint.links[tuple];
        const truth = await api.request<{ results: { state: string; id?: string }[] }>(
          "POST",
          "/api/bookkeeping/links/lookup",
          { tuples: [{ documentId, transactionId, coverageType: transaction.coverageType }] },
        );
        if (truth.results[0]?.state !== "active" || truth.results[0].id !== saved.id)
          throw new ImportFailure("stale-checkpoint");
        saved.outcome = initialRunLinkIds.has(saved.id) ? "created" : "existing";
        continue;
      }
      const response = await api.request<{ outcome: "created" | "existing"; link: { id: string } }>("POST", "/api/bookkeeping/links", { documentId, transactionId, coverageType: transaction.coverageType, runId, sourceRef: tuple });
      const outcome =
        response.outcome === "created" || initialRunLinkIds.has(response.link.id)
          ? "created"
          : "existing";
      checkpoint.links[tuple] = { id: response.link.id, outcome };
      if (response.outcome === "created") createdLinks += 1;
      await journal(directory, { kind: "link", documentIndex, transactionIndex, outcome, id: response.link.id });
      await privateWrite(path.join(directory, "checkpoint.json"), checkpoint);
    }
  }
  const finalStates = await hashLookups(api, hashes);
  if (
    finalStates.some((item, index) => {
      const planned = approval.plan.documents[index];
      const saved = checkpoint.documents[hashes[index]];
      return (
        item.state !== "active" ||
        !saved ||
        item.documentId !== saved.id ||
        Number(item.byteSize) !== planned.byteSize ||
        item.documentType !== planned.documentType ||
        (item.accountId || undefined) !== (planned.accountId || undefined) ||
        (item.statementMonth || undefined) !== (planned.statementMonth || undefined) ||
        saved.outcome !== (planned.outcome === "create" ? "created" : "existing")
      );
    })
  )
    throw new ImportFailure("document-reconciliation-mismatch");
  const tuples = manifest.documents.flatMap((document, index) => document.transactions.map((transaction) => ({ documentId: checkpoint.documents[hashes[index]].id, transactionId: transaction.sourceKey ? resolved.get(transaction.sourceKey)! : transaction.transactionId!, coverageType: transaction.coverageType })));
  const finalLinks = await linkLookups(api, tuples);
  if (
    finalLinks.some((item, index) => {
      const coordinate = linkCoordinates[index];
      const key = opaque(runId, `link:${coordinate.documentIndex}`, coordinate.transactionIndex);
      const saved = checkpoint.links[key];
      const planned = approval.plan.linkTuples[index];
      return (
        item.state !== "active" ||
        !saved ||
        item.id !== saved.id ||
        saved.outcome !== (planned.outcome === "create" ? "created" : "existing")
      );
    })
  )
    throw new ImportFailure("link-reconciliation-mismatch");
  const runDocuments = await runOwnedPages(api, runId, "document");
  const runLinks = await runOwnedPages(api, runId, "link");
  const expectedRunDocuments = Object.values(checkpoint.documents).filter(
    (item) => item.outcome === "created",
  );
  const expectedRunLinks = Object.values(checkpoint.links).filter(
    (item) => item.outcome === "created",
  );
  if (
    expectedRunDocuments.some(
      (item) => !runDocuments.some((remote) => remote.id === item.id),
    ) ||
    expectedRunLinks.some(
      (item) => !runLinks.some((remote) => remote.id === item.id),
    ) ||
    runDocuments.length !== expectedRunDocuments.length ||
    runLinks.length !== expectedRunLinks.length ||
    expectedRunDocuments.length !== approval.plan.documentOutcomes.create ||
    Object.values(checkpoint.documents).filter((item) => item.outcome === "existing").length !== approval.plan.documentOutcomes.reuse ||
    expectedRunLinks.length !== approval.plan.linkOutcomes.create ||
    Object.values(checkpoint.links).filter((item) => item.outcome === "existing").length !== approval.plan.linkOutcomes.reuse ||
    canonical(categories(manifest, inventory)) !== canonical(approval.plan.categories)
  )
    throw new ImportFailure("run-reconciliation-mismatch");
  await privateWrite(path.join(directory, "reconciliation.json"), {
    documents: finalStates,
    links: finalLinks,
    runDocuments,
    runLinks,
    checkpoint,
    categories: approval.plan.categories,
    outcomes: {
      documents: approval.plan.documentOutcomes,
      links: approval.plan.linkOutcomes,
      createdThisExecution: { documents: createdDocuments, links: createdLinks },
    },
  });
  return {
    mode: "write",
    runId,
    documents: hashes.length,
    links: tuples.length,
    createdDocuments,
    createdLinks,
    noOpExecution: createdDocuments === 0 && createdLinks === 0,
  };
}

async function main() {
  try {
    const args = parseArguments(process.argv.slice(2));
    const api = await BookkeepingApi.create({
      origin: args.apiBaseUrl || PRODUCTION_ORIGIN,
      cookieFile: args.cookieFile,
      bearerToken: process.env.DATAOPS_OPERATOR_SESSION_TOKEN,
    });
    const result = await runImport(args, api);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const reason = error instanceof ImportFailure ? error.reason : "unexpected-failure";
    process.stderr.write(`${JSON.stringify({ status: "failed", reason })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("import-bookkeeping-documents.ts")) void main();
