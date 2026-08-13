#!/usr/bin/env node

/**
 * One-off raw bookkeeping archive importer.
 *
 * The script validates the retained manifest and ZIP archives, then uses the
 * ordinary bookkeeping document/link APIs in one straight-line execution.
 * Run without --write for an offline source inventory.
 */

import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { inspectArchives, openArchiveMember } from "./bookkeeping-document-import/archive";
import { validateManifest } from "./bookkeeping-document-import/manifest";
import {
  DEFAULT_LIMITS,
  ImportFailure,
  type ArchiveInput,
  type Manifest,
} from "./bookkeeping-document-import/types";

const PRODUCTION_ORIGIN = "https://ops.dtcdev.click";

type Arguments = {
  archives: ArchiveInput[];
  manifestFile?: string;
  origin: string;
  confirmOrigin?: string;
  write: boolean;
};

function parseArguments(argv: string[]): Arguments {
  const result: Arguments = { archives: [], origin: PRODUCTION_ORIGIN, write: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--write") result.write = true;
    else if (flag === "--archive" && value) {
      const separator = value.indexOf("=");
      if (separator < 1) throw new ImportFailure("invalid-arguments");
      result.archives.push({ alias: value.slice(0, separator), path: path.resolve(value.slice(separator + 1)) });
      index += 1;
    } else if (["--manifest", "--api-base-url", "--confirm-origin"].includes(flag) && value) {
      if (flag === "--manifest") result.manifestFile = path.resolve(value);
      if (flag === "--api-base-url") result.origin = value.replace(/\/$/, "");
      if (flag === "--confirm-origin") result.confirmOrigin = value.replace(/\/$/, "");
      index += 1;
    } else throw new ImportFailure("invalid-arguments");
  }
  if (!result.manifestFile || !result.archives.length) throw new ImportFailure("source-required");
  let parsed: URL;
  try { parsed = new URL(result.origin); } catch { throw new ImportFailure("invalid-origin"); }
  if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(parsed.hostname))
    throw new ImportFailure("invalid-origin");
  return result;
}

async function readManifest(file: string) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024)
      throw new ImportFailure("invalid-manifest");
    return validateManifest(JSON.parse(await fs.readFile(file, "utf8")) as Manifest);
  } catch (error) {
    if (error instanceof ImportFailure) throw error;
    throw new ImportFailure("invalid-manifest");
  }
}

class Api {
  constructor(readonly origin: string, private readonly token: string) {}

  async request<T>(method: "GET" | "POST", route: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.origin}${route}`, {
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
    if (!response.ok) throw new ImportFailure(`api-rejected-${response.status}`);
    return await response.json() as T;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const manifest = await readManifest(args.manifestFile!);
  const inventory = await inspectArchives(args.archives, manifest, DEFAULT_LIMITS);
  const counts = {
    archives: args.archives.length,
    occurrences: inventory.occurrenceCount,
    documents: inventory.uniqueCount,
    duplicates: inventory.duplicateCount,
    links: manifest.documents.reduce((sum, document) => sum + document.transactions.length, 0),
    exclusions: inventory.excluded.length,
  };
  if (!args.write) return { mode: "validate", counts };
  if (args.confirmOrigin !== args.origin) throw new ImportFailure("origin-confirmation-required");
  const token = process.env.DATAOPS_OPERATOR_SESSION_TOKEN;
  if (!token) throw new ImportFailure("operator-session-required");
  const api = new Api(args.origin, token);
  const me = await api.request<{ user?: { enabled?: boolean } }>("GET", "/api/me");
  if (!me.user || me.user.enabled === false) throw new ImportFailure("operator-auth-rejected");
  const transactions = await api.request<{ items: Record<string, unknown>[] }>("GET", "/api/bookkeeping/transactions");
  const transactionBySource = new Map(
    transactions.items
      .filter((item) => typeof item.sourceKey === "string" && typeof item.id === "string")
      .map((item) => [String(item.sourceKey), String(item.id)]),
  );
  const archiveByAlias = new Map(args.archives.map((archive) => [archive.alias, archive.path]));
  const archiveDigestByAlias = new Map(manifest.archives.map((archive) => [archive.alias, archive.sha256.replace(/^sha256:/, "")]));
  const inventoryBySource = new Map(inventory.accepted.map((item) => [`${item.archive}\0${item.member}`, item]));
  const documentIds = new Map<string, string>();
  const runId = randomUUID();
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
    if (!archived || !archivePath || !archiveSha256) throw new ImportFailure("manifest-source-missing");
    const ownership = {
      idempotencyKey: `document-import:${sha256.slice(0, 32)}`,
      runId,
    };
    const prepared = await api.request<{
      outcome: "created" | "retry" | "existing";
      document: { id: string };
      uploadUrl?: string;
      uploadHeaders?: Record<string, string>;
    }>("POST", "/api/bookkeeping/documents/prepare", {
      sha256,
      byteSize: archived.byteSize,
      documentType: document.documentType,
      ...(document.accountId ? { accountId: document.accountId } : {}),
      ...(document.statementMonth ? { statementMonth: document.statementMonth } : {}),
      ...ownership,
      sourceRef: `archive:${sha256.slice(0, 48)}`,
    });
    documentIds.set(sha256, prepared.document.id);
    if (prepared.outcome === "existing") {
      existingDocuments += 1;
      continue;
    }
    if (!prepared.uploadUrl || !prepared.uploadHeaders) throw new ImportFailure("upload-authorization-missing");
    const opened = await openArchiveMember(
      archivePath,
      source.member,
      { archiveSha256, sha256, byteSize: archived.byteSize },
      DEFAULT_LIMITS,
    );
    try {
      const upload = await fetch(prepared.uploadUrl, {
        method: "PUT",
        headers: prepared.uploadHeaders,
        body: opened.stream as unknown as BodyInit,
        redirect: "error",
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      if (!upload.ok && upload.status !== 412) throw new ImportFailure(`upload-rejected-${upload.status}`);
    } finally {
      opened.close();
    }
    await api.request("POST", `/api/bookkeeping/documents/${encodeURIComponent(prepared.document.id)}/complete`, ownership);
    createdDocuments += 1;
  }

  for (const document of manifest.documents) {
    const documentId = documentIds.get(document.sha256.replace(/^sha256:/, ""))!;
    for (const link of document.transactions) {
      const transactionId = link.transactionId || transactionBySource.get(String(link.sourceKey));
      if (!transactionId) throw new ImportFailure("transaction-reference-missing");
      const response = await fetch(`${args.origin}/api/bookkeeping/links`, {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ documentId, transactionId, coverageType: link.coverageType }),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 201) createdLinks += 1;
      else if (response.status === 200) existingLinks += 1;
      else throw new ImportFailure(`api-links-rejected-${response.status}`);
    }
  }
  return { mode: "write", counts, createdDocuments, existingDocuments, createdLinks, existingLinks };
}

if (require.main === module)
  main().then(
    (result) => process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`),
    (error) => {
      const reason = error instanceof ImportFailure ? error.reason : "unexpected-failure";
      process.stderr.write(`${JSON.stringify({ ok: false, reason })}\n`);
      process.exitCode = 1;
    },
  );
