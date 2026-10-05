#!/usr/bin/env node

/**
 * Manual one-off raw bookkeeping archive importer.
 *
 * Local manifest/archive validation is the default operation. A write is an
 * explicitly targeted sandbox operation and uses only the ordinary
 * authenticated bookkeeping APIs; this command never talks directly to AWS.
 */

import { promises as fs } from "fs";
import path from "path";
import { inspectArchives, openArchiveMember } from "./bookkeeping-document-import/archive";
import { validateManifest } from "./bookkeeping-document-import/manifest";
import {
  DEFAULT_LIMITS,
  ImportFailure,
  MAX_INPUT_CARDINALITY,
  type ArchiveInput,
  type Manifest,
} from "./bookkeeping-document-import/types";

const SANDBOX_TARGET = "sandbox";
const PRODUCTION_HOSTS = new Set(["ops.dtcdev.click"]);
const SAFE_REASON = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type Arguments = {
  archives: ArchiveInput[];
  manifestFile?: string;
  origin?: string;
  confirmOrigin?: string;
  targetEnvironment?: string;
  confirmTarget?: string;
  write: boolean;
};

type RemoteRecord = Record<string, unknown>;
type ResolvedLink = {
  documentHash: string;
  transactionId: string;
  coverageType: string;
};
type Preflight = {
  links: ResolvedLink[];
};
type OutcomeCounts = { documents: number; links: number };
type Summary = {
  archives: number;
  acceptedOccurrences: number;
  uniqueDocuments: number;
  duplicateOccurrences: number;
  exclusions: number;
  planned: OutcomeCounts;
  created: OutcomeCounts | null;
  existing: OutcomeCounts | null;
};

const valueFlags = new Set([
  "--manifest",
  "--api-base-url",
  "--confirm-origin",
  "--target-environment",
  "--confirm-target",
]);

function isRecord(value: unknown): value is RemoteRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizedOriginArgument(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function parseArguments(argv: string[]): Arguments {
  const result: Arguments = { archives: [], write: false };
  const seen = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--write") {
      if (seen.has(flag)) throw new ImportFailure("invalid-arguments");
      seen.add(flag);
      result.write = true;
      continue;
    }
    if (flag === "--archive") {
      if (!value || value.startsWith("--")) throw new ImportFailure("invalid-arguments");
      const separator = value.indexOf("=");
      if (separator < 1 || separator === value.length - 1)
        throw new ImportFailure("invalid-arguments");
      result.archives.push({
        alias: value.slice(0, separator),
        path: path.resolve(value.slice(separator + 1)),
      });
      index += 1;
      continue;
    }
    if (valueFlags.has(flag)) {
      if (seen.has(flag) || !value || value.startsWith("--"))
        throw new ImportFailure("invalid-arguments");
      seen.add(flag);
      if (flag === "--manifest") result.manifestFile = path.resolve(value);
      if (flag === "--api-base-url") result.origin = normalizedOriginArgument(value);
      if (flag === "--confirm-origin") result.confirmOrigin = normalizedOriginArgument(value);
      if (flag === "--target-environment") result.targetEnvironment = value;
      if (flag === "--confirm-target") result.confirmTarget = value;
      index += 1;
      continue;
    }
    throw new ImportFailure("invalid-arguments");
  }

  if (!result.manifestFile || !result.archives.length)
    throw new ImportFailure("source-required");
  return result;
}

function validateWriteTarget(args: Arguments): { origin: string } {
  if (args.targetEnvironment !== SANDBOX_TARGET) {
    throw new ImportFailure(
      args.targetEnvironment === "prod" || args.targetEnvironment === "production"
        ? "production-target-forbidden"
        : "sandbox-target-required",
    );
  }
  if (args.confirmTarget !== SANDBOX_TARGET || args.confirmTarget !== args.targetEnvironment)
    throw new ImportFailure("target-confirmation-required");
  if (!args.origin) throw new ImportFailure("api-base-url-required");
  if (args.confirmOrigin !== args.origin)
    throw new ImportFailure("origin-confirmation-required");

  let parsed: URL;
  try {
    parsed = new URL(args.origin);
  } catch {
    throw new ImportFailure("invalid-origin");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== args.origin ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  )
    throw new ImportFailure("invalid-origin");
  if (PRODUCTION_HOSTS.has(parsed.hostname.toLowerCase()))
    throw new ImportFailure("production-target-forbidden");
  return { origin: parsed.origin };
}

async function readManifest(file: string): Promise<Manifest> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024)
      throw new ImportFailure("invalid-manifest");
    return validateManifest(JSON.parse(await fs.readFile(file, "utf8")));
  } catch (error) {
    if (error instanceof ImportFailure) throw error;
    throw new ImportFailure("invalid-manifest");
  }
}

class Api {
  constructor(
    private readonly origin: string,
    private readonly token: string,
  ) {}

  private async send(method: "GET" | "POST", route: string, body?: unknown) {
    try {
      return await fetch(`${this.origin}${route}`, {
        method,
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ImportFailure("api-unavailable");
    }
  }

  async request<T>(
    method: "GET" | "POST",
    route: string,
    body?: unknown,
    acceptedStatuses: readonly number[] = [200],
  ): Promise<T> {
    const response = await this.send(method, route, body);
    if (!acceptedStatuses.includes(response.status))
      throw new ImportFailure(`api-rejected-${response.status}`);
    try {
      return await response.json() as T;
    } catch {
      throw new ImportFailure("api-invalid-response");
    }
  }
}

function collectionItems(value: unknown, reason: string, maxItems: number): RemoteRecord[] {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > maxItems)
    throw new ImportFailure(reason);
  if (!value.items.every(isRecord)) throw new ImportFailure(reason);
  return value.items;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 300;
}

function validateExistingDocuments(items: RemoteRecord[]) {
  const ids = new Set<string>();
  for (const item of items) {
    if (!nonEmptyString(item.id) || ids.has(item.id))
      throw new ImportFailure("invalid-document-response");
    ids.add(item.id);
  }
}

function validateExistingLinks(items: RemoteRecord[]) {
  const tuples = new Set<string>();
  for (const item of items) {
    if (
      !nonEmptyString(item.id) ||
      !nonEmptyString(item.documentId) ||
      !nonEmptyString(item.transactionId) ||
      !["evidence", "statement-coverage", "report-source"].includes(String(item.coverageType))
    )
      throw new ImportFailure("invalid-link-response");
    const tuple = `${item.documentId}\0${item.transactionId}\0${item.coverageType}`;
    if (tuples.has(tuple)) throw new ImportFailure("ambiguous-existing-link");
    tuples.add(tuple);
  }
}

async function preflightTargets(api: Api, manifest: Manifest): Promise<Preflight> {
  const [accountPayload, transactionPayload, documentPayload, linkPayload] = await Promise.all([
    api.request<unknown>("GET", "/api/bookkeeping/accounts"),
    api.request<unknown>("GET", "/api/bookkeeping/transactions"),
    api.request<unknown>("GET", "/api/bookkeeping/documents"),
    api.request<unknown>("GET", "/api/bookkeeping/links"),
  ]);
  const accounts = collectionItems(
    accountPayload,
    "invalid-account-response",
    MAX_INPUT_CARDINALITY.documents,
  );
  const transactions = collectionItems(
    transactionPayload,
    "invalid-transaction-response",
    MAX_INPUT_CARDINALITY.totalLinks,
  );
  const documents = collectionItems(
    documentPayload,
    "invalid-document-response",
    MAX_INPUT_CARDINALITY.documents,
  );
  const existingLinks = collectionItems(
    linkPayload,
    "invalid-link-response",
    MAX_INPUT_CARDINALITY.totalLinks,
  );
  validateExistingDocuments(documents);
  validateExistingLinks(existingLinks);

  const accountById = new Map<string, RemoteRecord>();
  for (const account of accounts) {
    if (!nonEmptyString(account.id) || accountById.has(account.id))
      throw new ImportFailure("ambiguous-account-target");
    accountById.set(account.id, account);
  }

  const transactionById = new Map<string, RemoteRecord>();
  const transactionsBySource = new Map<string, string>();
  for (const transaction of transactions) {
    if (!nonEmptyString(transaction.id) || transactionById.has(transaction.id))
      throw new ImportFailure("ambiguous-transaction-target");
    transactionById.set(transaction.id, transaction);
    if (transaction.sourceKey !== undefined && transaction.sourceKey !== null) {
      if (!nonEmptyString(transaction.sourceKey) || transactionsBySource.has(transaction.sourceKey))
        throw new ImportFailure("ambiguous-transaction-source");
      transactionsBySource.set(transaction.sourceKey, transaction.id);
    }
  }

  const links: ResolvedLink[] = [];
  const linkTargets = new Set<string>();
  for (const document of manifest.documents) {
    const documentHash = document.sha256.replace(/^sha256:/, "");
    if (["bank-statement", "private-account-statement"].includes(document.documentType)) {
      const account = accountById.get(String(document.accountId));
      const expectedKind =
        document.documentType === "private-account-statement" ? "private" : "business";
      if (!account) throw new ImportFailure("statement-account-missing");
      if (account.active !== true) throw new ImportFailure("statement-account-disabled");
      if (account.kind !== expectedKind) throw new ImportFailure("statement-account-kind-mismatch");
    }
    for (const transaction of document.transactions) {
      const transactionId = transaction.transactionId
        ? transactionById.get(transaction.transactionId)?.id
        : transactionsBySource.get(String(transaction.sourceKey));
      if (!transactionId) throw new ImportFailure("transaction-target-missing");
      const target = `${documentHash}\0${transactionId}\0${transaction.coverageType}`;
      if (linkTargets.has(target)) throw new ImportFailure("duplicate-link-target");
      linkTargets.add(target);
      links.push({ documentHash, transactionId, coverageType: transaction.coverageType });
    }
  }
  return { links };
}

function summary(
  archives: number,
  manifest: Manifest,
  inventory: Awaited<ReturnType<typeof inspectArchives>>,
  plannedLinks: number,
  created: OutcomeCounts | null = null,
  existing: OutcomeCounts | null = null,
): Summary {
  return {
    archives,
    acceptedOccurrences: inventory.occurrenceCount,
    uniqueDocuments: inventory.uniqueCount,
    duplicateOccurrences: inventory.duplicateCount,
    exclusions: inventory.excluded.length,
    planned: { documents: manifest.documents.length, links: plannedLinks },
    created,
    existing,
  };
}

function ownershipFor(sha256: string) {
  return {
    idempotencyKey: `document-import:${sha256}`,
    sourceRef: `archive-document:${sha256}`,
  };
}

function preparedResponse(value: unknown): {
  outcome: "created" | "retry" | "existing";
  document: RemoteRecord;
  uploadUrl?: string;
  uploadHeaders?: Record<string, string>;
} {
  if (!isRecord(value) || !["created", "retry", "existing"].includes(String(value.outcome)))
    throw new ImportFailure("invalid-document-response");
  const outcome = value.outcome as "created" | "retry" | "existing";
  if (!isRecord(value.document) || !nonEmptyString(value.document.id))
    throw new ImportFailure("invalid-document-response");
  if (
    outcome === "existing" &&
    (value.uploadUrl !== undefined || value.uploadHeaders !== undefined)
  )
    throw new ImportFailure("invalid-upload-authorization");
  if (
    outcome !== "existing" &&
    (typeof value.uploadUrl !== "string" || !isRecord(value.uploadHeaders))
  )
    throw new ImportFailure("invalid-upload-authorization");
  if (value.uploadUrl !== undefined && typeof value.uploadUrl !== "string")
    throw new ImportFailure("invalid-upload-authorization");
  if (value.uploadHeaders !== undefined && !isRecord(value.uploadHeaders))
    throw new ImportFailure("invalid-upload-authorization");
  const uploadHeaders = value.uploadHeaders
    ? Object.fromEntries(
        Object.entries(value.uploadHeaders).map(([key, header]) => {
          if (typeof header !== "string") throw new ImportFailure("invalid-upload-authorization");
          return [key, header];
        }),
      )
    : undefined;
  return {
    outcome,
    document: value.document,
    ...(value.uploadUrl === undefined ? {} : { uploadUrl: value.uploadUrl }),
    ...(uploadHeaders === undefined ? {} : { uploadHeaders }),
  };
}

function validatePreparedMetadata(
  document: RemoteRecord,
  expected: Manifest["documents"][number],
  byteSize: number,
  outcome: "created" | "retry" | "existing",
) {
  const expectedStatus = outcome === "existing" ? "active" : "pending";
  const accountMatches = expected.accountId === undefined
    ? document.accountId === undefined
    : document.accountId === expected.accountId;
  const monthMatches = expected.statementMonth === undefined
    ? document.statementMonth === undefined
    : document.statementMonth === expected.statementMonth;
  if (
    document.documentType !== expected.documentType ||
    document.status !== expectedStatus ||
    document.byteSize !== byteSize ||
    !accountMatches ||
    !monthMatches
  )
    throw new ImportFailure("document-metadata-mismatch");
}

function operationOutcome(value: unknown, reason: string): "created" | "existing" {
  if (!isRecord(value) || !["created", "existing"].includes(String(value.outcome)))
    throw new ImportFailure(reason);
  return value.outcome as "created" | "existing";
}

function completedOutcome(
  value: unknown,
  expectedId: string,
  expected: Manifest["documents"][number],
  byteSize: number,
): "created" | "existing" {
  const outcome = operationOutcome(value, "invalid-document-response");
  if (!isRecord(value) || !isRecord(value.document) || value.document.id !== expectedId)
    throw new ImportFailure("invalid-document-response");
  validatePreparedMetadata(value.document, expected, byteSize, "existing");
  return outcome;
}

function linkOutcome(
  value: unknown,
  expected: { documentId: string; transactionId: string; coverageType: string },
): "created" | "existing" {
  const outcome = operationOutcome(value, "invalid-link-response");
  if (!isRecord(value) || !isRecord(value.link))
    throw new ImportFailure("invalid-link-response");
  if (
    value.link.documentId !== expected.documentId ||
    value.link.transactionId !== expected.transactionId ||
    value.link.coverageType !== expected.coverageType ||
    !nonEmptyString(value.link.id)
  )
    throw new ImportFailure("invalid-link-response");
  return outcome;
}

async function uploadMember(
  prepared: ReturnType<typeof preparedResponse>,
  archivePath: string,
  sourceMember: string,
  archiveSha256: string,
  sha256: string,
  byteSize: number,
) {
  if (!prepared.uploadUrl || !prepared.uploadHeaders)
    throw new ImportFailure("invalid-upload-authorization");
  let parsed: URL;
  try {
    parsed = new URL(prepared.uploadUrl);
  } catch {
    throw new ImportFailure("invalid-upload-authorization");
  }
  if (parsed.protocol !== "https:") throw new ImportFailure("invalid-upload-authorization");
  const opened = await openArchiveMember(
    archivePath,
    sourceMember,
    { archiveSha256, sha256, byteSize },
    DEFAULT_LIMITS,
  );
  try {
    let response: Response;
    try {
      response = await fetch(prepared.uploadUrl, {
        method: "PUT",
        headers: prepared.uploadHeaders,
        body: opened.stream as unknown as BodyInit,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        duplex: "half",
      } as RequestInit & { duplex: "half" });
    } catch {
      throw new ImportFailure("upload-unavailable");
    }
    if (!response.ok && response.status !== 412)
      throw new ImportFailure(`upload-rejected-${response.status}`);
  } finally {
    opened.close();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const target = args.write ? validateWriteTarget(args) : undefined;
  let api: Api | undefined;

  if (args.write) {
    const token = process.env.DATAOPS_OPERATOR_SESSION_TOKEN;
    if (!token) throw new ImportFailure("operator-session-required");
    api = new Api(target!.origin, token);
    const me = await api.request<unknown>("GET", "/api/me");
    if (!isRecord(me) || !isRecord(me.user) || me.user.disabled !== false)
      throw new ImportFailure("operator-auth-rejected");
  }

  const manifest = await readManifest(args.manifestFile!);
  const inventory = await inspectArchives(args.archives, manifest, DEFAULT_LIMITS);
  const localLinkCount = manifest.documents.reduce(
    (sum, document) => sum + document.transactions.length,
    0,
  );
  if (!args.write)
    return {
      mode: "dry-run",
      summary: summary(args.archives.length, manifest, inventory, localLinkCount),
    };

  const preflight = await preflightTargets(api!, manifest);
  const archiveByAlias = new Map(args.archives.map((archive) => [archive.alias, archive.path]));
  const archiveDigestByAlias = new Map(
    manifest.archives.map((archive) => [archive.alias, archive.sha256.replace(/^sha256:/, "")]),
  );
  const inventoryBySource = new Map(
    inventory.accepted.map((item) => [`${item.archive}\0${item.member}`, item]),
  );
  const documentIds = new Map<string, string>();
  let createdDocuments = 0;
  let existingDocuments = 0;
  let createdLinks = 0;
  let existingLinks = 0;

  for (const document of manifest.documents) {
    const sha256 = document.sha256.replace(/^sha256:/, "");
    const source = document.sources[0];
    const archived = inventoryBySource.get(`${source.archive}\0${source.member}`);
    const archivePath = archiveByAlias.get(source.archive);
    const archiveSha256 = archiveDigestByAlias.get(source.archive);
    if (!archived || !archivePath || !archiveSha256)
      throw new ImportFailure("manifest-source-missing");
    const ownership = ownershipFor(sha256);
    const prepared = preparedResponse(
      await api!.request<unknown>(
        "POST",
        "/api/bookkeeping/documents/prepare",
        {
          sha256,
          byteSize: archived.byteSize,
          documentType: document.documentType,
          ...(document.accountId ? { accountId: document.accountId } : {}),
          ...(document.statementMonth ? { statementMonth: document.statementMonth } : {}),
          ...ownership,
        },
        [200, 201],
      ),
    );
    validatePreparedMetadata(prepared.document, document, archived.byteSize, prepared.outcome);
    documentIds.set(sha256, prepared.document.id);
    if (prepared.outcome === "existing") {
      existingDocuments += 1;
      continue;
    }
    await uploadMember(
      prepared,
      archivePath,
      source.member,
      archiveSha256,
      sha256,
      archived.byteSize,
    );
    const completed = completedOutcome(
      await api!.request<unknown>(
        "POST",
        `/api/bookkeeping/documents/${encodeURIComponent(prepared.document.id)}/complete`,
        { idempotencyKey: ownership.idempotencyKey },
        [200],
      ),
      prepared.document.id,
      document,
      archived.byteSize,
    );
    if (completed === "created") createdDocuments += 1;
    else existingDocuments += 1;
  }

  for (const link of preflight.links) {
    const documentId = documentIds.get(link.documentHash);
    if (!documentId) throw new ImportFailure("document-target-missing");
    const outcome = linkOutcome(
      await api!.request<unknown>(
        "POST",
        "/api/bookkeeping/links",
        {
          documentId,
          transactionId: link.transactionId,
          coverageType: link.coverageType,
        },
        [200, 201],
      ),
      {
        documentId,
        transactionId: link.transactionId,
        coverageType: link.coverageType,
      },
    );
    if (outcome === "created") createdLinks += 1;
    else existingLinks += 1;
  }

  return {
    mode: "write",
    summary: summary(
      args.archives.length,
      manifest,
      inventory,
      preflight.links.length,
      { documents: createdDocuments, links: createdLinks },
      { documents: existingDocuments, links: existingLinks },
    ),
  };
}

function safeReason(error: unknown) {
  const reason = error instanceof ImportFailure ? error.reason : "";
  return SAFE_REASON.test(reason) ? reason : "unexpected-failure";
}

if (require.main === module)
  main().then(
    (result) => process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`),
    (error) => {
      process.stderr.write(`${JSON.stringify({ ok: false, reason: safeReason(error) })}\n`);
      process.exitCode = 1;
    },
  );
