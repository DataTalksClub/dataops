import { createHash } from "crypto";
import { ZipFile } from "yazl";
import { Readable, Transform } from "stream";
import { DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { LambdaEvent, LambdaResponse } from "../types";
import {
  addDocumentReportReference,
  deleteBookkeepingItem,
  getBookkeepingItem,
  isReportExemptTransaction,
  listBookkeepingItems,
  markGenerationCleanupRequired,
  markReportGenerated,
  putBookkeepingItem,
  removeDocumentReportReference,
  type BookkeepingItem,
} from "../db/bookkeeping";
import {
  attachBookkeepingReportSnapshot,
  deleteBookkeepingReportSnapshot,
  readBookkeepingReportSnapshotForItem,
  storeBookkeepingReportSnapshot,
  type BookkeepingReportSnapshot,
  type StoredBookkeepingReportSnapshot,
} from "../db/bookkeepingReportSnapshots";
import { preflightOrganizations } from '../vies/service';
import { businessAccountRequiresStatement } from "../finance/businessAccounts";
import { projectTransactionAllocations, readTransactionAllocations } from "../bookkeepingAllocations";
import {
  headDocumentObject,
  json,
  MONEY,
  MONTH,
  parse,
  s3,
  signUrl,
  uploadStream,
} from "./bookkeepingShared";

const csvCell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const REPORT_SNAPSHOT_VERSION = 4;
const SNAPSHOT_CSV_COLUMNS = [
  "transactionDate", "paidDate", "counterparty", "description", "amount", "currency",
  "amountEur", "vatAmount", "vatCurrency", "category", "entryType", "statementRef",
];

export function accountantSnapshotRows(transactions: Record<string, unknown>[]) {
  return transactions.map((transaction) => Object.fromEntries(
    SNAPSHOT_CSV_COLUMNS
      .filter((column) => transaction[column] !== undefined)
      .map((column) => [column, transaction[column]]),
  ));
}

export function formatReportSnapshotCsv(transactions: Record<string, unknown>[]) {
  return SNAPSHOT_CSV_COLUMNS.join(",") + "\n" + transactions
    .map((transaction) => SNAPSHOT_CSV_COLUMNS.map((column) => csvCell(transaction[column])).join(","))
    .join("\n") + "\n";
}

const activeLedgerRows = async (client: DynamoDBDocumentClient) =>
  (await listBookkeepingItems(client, "bookkeeping")).filter((item) => item.voidStatus !== "voided");

function reportSnapshotFromLegacy(report: BookkeepingItem): BookkeepingReportSnapshot {
  return {
    transactionIds: Array.isArray(report.transactionIds) ? report.transactionIds : [],
    transactionRows: Array.isArray(report.transactionRows) ? report.transactionRows : [],
    documentIds: Array.isArray(report.documentIds) ? report.documentIds : [],
    reconciliation: report.reconciliation && typeof report.reconciliation === "object"
      ? report.reconciliation
      : {},
  };
}

async function ensureStoredReportSnapshot(
  client: DynamoDBDocumentClient,
  initial: BookkeepingItem,
) {
  let report = initial;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (Number(report.snapshotVersion) === REPORT_SNAPSHOT_VERSION) return report;

    const snapshot = reportSnapshotFromLegacy(report);
    const stored = await storeBookkeepingReportSnapshot(client, report.id, snapshot);
    let migrated = false;
    try {
      migrated = await attachBookkeepingReportSnapshot(client, report, stored);
    } catch (error) {
      let current: BookkeepingItem | null;
      try {
        current = await getBookkeepingItem(client, "report", report.id, true);
      } catch {
        // Keep chunks when the outcome is unknown; the report may already point to them.
        throw error;
      }
      if (current && Number(current.snapshotVersion) === REPORT_SNAPSHOT_VERSION) {
        if (current.snapshotStorageId !== stored.snapshotStorageId)
          await deleteBookkeepingReportSnapshot(client, stored.snapshotStorageId).catch(() => undefined);
        return current;
      }
      await deleteBookkeepingReportSnapshot(client, stored.snapshotStorageId).catch(() => undefined);
      throw error;
    }

    const current = await getBookkeepingItem(client, "report", report.id, true);
    if (migrated && current && Number(current.snapshotVersion) === REPORT_SNAPSHOT_VERSION
      && current.snapshotStorageId === stored.snapshotStorageId) return current;

    if (current && Number(current.snapshotVersion) === REPORT_SNAPSHOT_VERSION) {
      if (current.snapshotStorageId !== stored.snapshotStorageId)
        await deleteBookkeepingReportSnapshot(client, stored.snapshotStorageId).catch(() => undefined);
      return current;
    }
    await deleteBookkeepingReportSnapshot(client, stored.snapshotStorageId).catch(() => undefined);
    if (!current || !["ready", "generated"].includes(String(current.status)))
      throw new Error("Bookkeeping report changed before its snapshot could be migrated");
    if (current.updatedAt === report.updatedAt
      && Object.is(current.snapshotVersion, report.snapshotVersion))
      throw new Error("Bookkeeping report snapshot migration lost its compare-and-swap");
    report = current;
  }
  throw new Error("Bookkeeping report changed repeatedly during snapshot migration");
}

async function reportSnapshotContent(
  client: DynamoDBDocumentClient,
  report: BookkeepingItem,
): Promise<BookkeepingReportSnapshot> {
  return readBookkeepingReportSnapshotForItem(client, report);
}

async function releaseUnusedReportDocumentReferences(
  client: DynamoDBDocumentClient,
  reportId: string,
  documentIds: string[],
  current: BookkeepingItem | null,
) {
  let currentDocumentIds = new Set<string>();
  if (current) {
    try {
      const snapshot = await reportSnapshotContent(client, current);
      currentDocumentIds = new Set(
        Array.isArray(snapshot.documentIds) ? snapshot.documentIds.map(String) : [],
      );
    } catch {
      // Unknown winners keep their references; releasing one could unpin a live report.
      return;
    }
  }
  await Promise.all(documentIds
    .filter((documentId) => !currentDocumentIds.has(documentId))
    .map((documentId) => removeDocumentReportReference(client, documentId, reportId).catch(() => undefined)));
}

/**
 * Customer VAT report for the monthly pack (ZM / Mandantenserver upload):
 * every EU B2B customer's last known VIES state, cached-only so assembling
 * a pack never waits on the network. Reporting only — the blocking gate is
 * the invoice issue path and `dataops vies preflight`.
 */
async function vatPreflightSummary(client: DynamoDBDocumentClient) {
  const { scanned, entries } = await preflightOrganizations(client);
  const flagged = entries.filter((entry) => entry.flags.length > 0);
  return {
    scanned,
    issueCount: flagged.length,
    issues: flagged.map((entry) => ({
      organizationId: entry.organizationId,
      ...(entry.displayName ? { displayName: entry.displayName } : {}),
      ...(entry.country ? { country: entry.country } : {}),
      ...(entry.vatId ? { vatId: entry.vatId } : {}),
      flags: entry.flags,
    })),
  };
}

export async function handleBookkeepingReportRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  if (path === "/api/bookkeeping/reports/snapshot" && method === "POST") {
    const body = parse(event.body || null),
      month = String(body?.month || "");
    if (!MONTH.test(month)) return json(400, { error: "Invalid month" });
    const reports = await listBookkeepingItems(client, "report");
    const monthlyReports = reports.filter((report) => report.month === month
      && ["ready", "generated"].includes(String(report.status)));
    const existing = monthlyReports.find((report) => Number(report.snapshotVersion) === REPORT_SNAPSHOT_VERSION);
    if (existing) {
      return json(200, { report: existing, duplicate: true, vatPreflight: await vatPreflightSummary(client) });
    }
    const legacy = monthlyReports.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    if (legacy) {
      try {
        const migrated = await ensureStoredReportSnapshot(client, legacy);
        return json(200, { report: migrated, duplicate: true, vatPreflight: await vatPreflightSummary(client) });
      } catch {
        return json(503, { error: "The existing report snapshot could not be migrated; retry the request." });
      }
    }
    const accounts = (await listBookkeepingItems(client, "account")).filter(
      (a) => a.kind === "business" && a.active !== false && businessAccountRequiresStatement(String(a.id), month),
    );
    const docs = (await listBookkeepingItems(client, "document")).filter(
      (d) => d.status === "active",
    );
    const missing = accounts.filter(
      (a) =>
        !docs.some(
          (d) =>
            d.documentType === "bank-statement" &&
            d.accountId === a.id &&
            d.statementMonth === month,
        ),
    );
    if (accounts.length < 2 || missing.length)
      return json(409, {
        error: "Missing required business statements",
        missingAccountIds: missing.map((a) => a.id),
      });
    const monthTransactions = (await activeLedgerRows(client))
      .filter((t) => String(t.transactionDate).startsWith(month));
    const projectedTransactions = monthTransactions.flatMap((transaction) => {
      const allocations = projectTransactionAllocations(transaction);
      return allocations.length ? allocations : [transaction];
    });
    const excludedTransactions = projectedTransactions.filter(isReportExemptTransaction);
    const transactions = projectedTransactions.filter((transaction) => !isReportExemptTransaction(transaction));
    const unconverted = transactions.filter(
      (t) =>
        String(t.currency || "EUR").toUpperCase() !== "EUR" &&
        !String(t.amountEur ?? "").trim(),
    );
    if (unconverted.length)
      return json(409, {
        error: `${unconverted.length} transaction(s) have no EUR value; convert them before preparing the package`,
        unconvertedTransactionIds: unconverted.map((t) => String(t.id)),
      });
    const links = await listBookkeepingItems(client, "link");
    const allocatedParentIds = new Set(monthTransactions
      .filter((transaction) => readTransactionAllocations(transaction).length)
      .map((transaction) => String(transaction.id)));
    const includedParentIds = new Set(transactions.map((transaction) => String(transaction.sourceTransactionId || transaction.id)));
    const linkedIds = new Set(links
      .filter((link) => includedParentIds.has(String(link.transactionId))
        && !allocatedParentIds.has(String(link.transactionId)))
      .map((link) => String(link.documentId)));
    for (const transaction of transactions) {
      if (transaction.allocationDocumentId) linkedIds.add(String(transaction.allocationDocumentId));
    }
    const excludedTransactionIds = new Set(excludedTransactions.map((transaction) => String(transaction.sourceTransactionId || transaction.id)));
    const excludedLinkedIds = new Set(
      links
        .filter((link) => excludedTransactionIds.has(String(link.transactionId))
          && !includedParentIds.has(String(link.transactionId)))
        .map((link) => String(link.documentId)),
    );
    for (const link of links) {
      if (allocatedParentIds.has(String(link.transactionId)) && !linkedIds.has(String(link.documentId)))
        excludedLinkedIds.add(String(link.documentId));
    }
    for (const transaction of excludedTransactions) {
      if (transaction.allocationDocumentId)
        excludedLinkedIds.add(String(transaction.allocationDocumentId));
    }
    const selectedPrivate = new Set(
      Array.isArray(body?.privateDocumentIds)
        ? body!.privateDocumentIds.map(String)
        : [],
    );
    const includedDocs = docs.filter(
      (d) =>
        (d.documentType === "bank-statement" &&
          d.statementMonth === month &&
          accounts.some((a) => a.id === d.accountId)) ||
        linkedIds.has(d.id) ||
        (selectedPrivate.has(d.id) && !excludedLinkedIds.has(String(d.id))),
    );
    const reportId = createHash("sha256").update(`report#${month}#snapshot-v4`).digest("hex");
    const snapshotContent = {
      transactionIds: [...new Set(transactions.map((t) => String(t.sourceTransactionId || t.id)))],
      transactionRows: accountantSnapshotRows(transactions),
      documentIds: includedDocs.map((d) => d.id),
      reconciliation: {
        transactionCount: transactions.length,
        excludedTransactionCount: excludedTransactions.length,
        documentCount: includedDocs.length,
        businessStatementCount: accounts.length,
      },
    };
    const snapshot = {
      id: reportId,
      month,
      status: "ready",
      reconciliation: snapshotContent.reconciliation,
      snapshotVersion: REPORT_SNAPSHOT_VERSION,
    };
    const guarded: string[] = [];
    let stored: StoredBookkeepingReportSnapshot | undefined;
    let report: BookkeepingItem | undefined;
    try {
      stored = await storeBookkeepingReportSnapshot(client, reportId, snapshotContent);
      for (const document of includedDocs) {
        if (await addDocumentReportReference(client, document.id, reportId))
          guarded.push(document.id);
      }
      const result = await putBookkeepingItem(
        client,
        "report",
        { ...snapshot, ...stored },
        `report#${month}#snapshot-v4`,
      );
      report = result.item;
      if (result.duplicate) {
        if (result.item.snapshotStorageId !== stored.snapshotStorageId) {
          await releaseUnusedReportDocumentReferences(client, reportId, guarded, result.item);
          await deleteBookkeepingReportSnapshot(client, stored.snapshotStorageId);
        }
        return json(200, { report: result.item, duplicate: true, vatPreflight: await vatPreflightSummary(client) });
      }
    } catch (error) {
      let current: BookkeepingItem | null;
      try {
        current = await getBookkeepingItem(client, "report", reportId, true);
      } catch {
        // A write may have committed before its response was lost; retain its chunks until verified.
        throw error;
      }
      if (current && Number(current.snapshotVersion) === REPORT_SNAPSHOT_VERSION) {
        if (stored && current.snapshotStorageId === stored.snapshotStorageId)
          return json(201, { report: current, duplicate: false, vatPreflight: await vatPreflightSummary(client) });
        await releaseUnusedReportDocumentReferences(client, reportId, guarded, current);
        if (stored)
          await deleteBookkeepingReportSnapshot(client, stored.snapshotStorageId).catch(() => undefined);
        return json(200, { report: current, duplicate: true, vatPreflight: await vatPreflightSummary(client) });
      }
      await releaseUnusedReportDocumentReferences(client, reportId, guarded, current);
      if (stored) await deleteBookkeepingReportSnapshot(client, stored.snapshotStorageId).catch(() => undefined);
      throw error;
    }
    if (!report) throw new Error("Bookkeeping report snapshot was not stored");
    return json(201, {
      report,
      vatPreflight: await vatPreflightSummary(client),
      warnings: {
        missingEvidence: transactions.filter(
          (transaction) => transaction.allocationDocumentId
            ? !linkedIds.has(String(transaction.allocationDocumentId))
            : !links.some((link) => link.transactionId === transaction.id && link.coverageType === "evidence"),
        ).length,
      },
    });
  }
  if (path === "/api/bookkeeping/reports/vat" && method === "GET") {
    const year = event.queryStringParameters?.year;
    if (year != null && !/^\d{4}$/.test(String(year)))
      return json(400, { error: "Invalid year" });
    const withVat = (await activeLedgerRows(client)).filter(
      (t) => typeof t.vatAmount === "string" && MONEY.test(t.vatAmount),
    );
    const selected = year
      ? withVat.filter((t) =>
          String(t.transactionDate).startsWith(String(year)),
        )
      : withVat;
    type VatBucket = {
      month: string;
      currency: string;
      outputVat: number;
      inputVat: number;
      net: number;
      transactionCount: number;
    };
    const months = new Map<string, VatBucket>();
    for (const t of selected) {
      const month = String(t.transactionDate).slice(0, 7);
      const currency = String(t.vatCurrency || t.currency || "EUR");
      const bucket = months.get(`${month}#${currency}`) || {
        month,
        currency,
        outputVat: 0,
        inputVat: 0,
        net: 0,
        transactionCount: 0,
      };
      const amount = Number(t.vatAmount);
      if (t.entryType === "income") bucket.outputVat += amount;
      else bucket.inputVat += amount;
      bucket.net = Math.round((bucket.outputVat - bucket.inputVat) * 100) / 100;
      bucket.transactionCount += 1;
      months.set(`${month}#${currency}`, bucket);
    }
    return json(200, {
      months: [...months.values()].sort((a, b) => b.month.localeCompare(a.month)),
      transactions: selected,
    });
  }
  const archive = path.match(/^\/api\/bookkeeping\/reports\/([^/]+)\/archive$/);
  if (archive && method === "POST") {
    let report = await getBookkeepingItem(client, "report", archive[1]);
    if (!report || !["ready", "generated"].includes(String(report.status)))
      return json(404, { error: "Ready report not found" });
    if (report.archiveDocumentId) {
      const doc = await getBookkeepingItem(
        client,
        "document",
        String(report.archiveDocumentId),
      );
      if (doc?.status === "active") {
        const url = await signUrl(
          s3,
          new GetObjectCommand({
            Bucket: process.env.BOOKKEEPING_DOCUMENTS_BUCKET,
            Key: String(doc.s3Key),
          }),
          { expiresIn: 300 },
        );
        return json(200, { downloadUrl: url, expiresIn: 300, duplicate: true, vatPreflight: await vatPreflightSummary(client) });
      }
      if (report.status === "generated")
        return json(409, { error: "The historical report archive is unavailable." });
    }
    try {
      report = await ensureStoredReportSnapshot(client, report);
    } catch {
      return json(503, { error: "The report snapshot could not be prepared for archive generation; retry the request." });
    }
    const snapshotContent = await reportSnapshotContent(client, report);
    const documentIds = Array.isArray(snapshotContent.documentIds)
      ? snapshotContent.documentIds.map(String)
      : [];
    const maxFiles = Number(process.env.BOOKKEEPING_ARCHIVE_MAX_FILES || 500),
      maxBytes = Number(
      process.env.BOOKKEEPING_ARCHIVE_MAX_BYTES || 50 * 1024 * 1024,
      );
    if (documentIds.length + 1 > maxFiles)
      return json(413, { error: "Archive file limit exceeded" });
    const transactions = Array.isArray(snapshotContent.transactionRows)
      ? snapshotContent.transactionRows as Record<string, unknown>[]
      : [];
    const csv = Buffer.from(formatReportSnapshotCsv(transactions), "utf8");
    let total = csv.length;
    const snapshotDocs: BookkeepingItem[] = [];
    for (const id of documentIds) {
      const doc = await getBookkeepingItem(client, "document", id);
      if (!doc || doc.status !== "active")
        return json(409, { error: "Snapshot document unavailable" });
      if (
        Number(doc.byteSize) >
        Number(process.env.BOOKKEEPING_PDF_MAX_BYTES || 20 * 1024 * 1024)
      )
        return json(413, { error: "Archive member too large" });
      total += Number(doc.byteSize);
      if (total > maxBytes)
        return json(413, { error: "Archive byte limit exceeded" });
      snapshotDocs.push(doc);
    }
    const archiveId = crypto.randomUUID(),
      archiveKey = `reports/${report.id}/${archiveId}.zip`;
    const generationLock = await putBookkeepingItem(
      client,
      "generation",
      { reportId: report.id, status: "generating" },
      `archive#${report.id}`,
    );
    if (generationLock.duplicate) {
      return json(409, { error: "Archive generation already in progress" });
    }
    const zip = new ZipFile();
    zip.addBuffer(csv, `datatalksclub-${report.month}.csv`);
    for (const doc of snapshotDocs) {
      const object = await s3.send(new GetObjectCommand({
        Bucket: process.env.BOOKKEEPING_DOCUMENTS_BUCKET,
        Key: String(doc.s3Key),
      }));
      const body = object.Body as unknown as Readable;
      zip.addReadStream(typeof body?.pipe === "function" ? body : Readable.from(await object.Body!.transformToByteArray()), `documents/${doc.id}.pdf`);
    }
    const digest = createHash("sha256");
    let archiveBytes = 0;
    let archiveVersionId: string | undefined;
    let archiveUploaded = false;
    const meter = new Transform({ transform(chunk, _encoding, callback) { archiveBytes += chunk.length; digest.update(chunk); callback(null, chunk); } });
    zip.outputStream.pipe(meter);
    try {
      const uploadPromise = uploadStream({
        Bucket: process.env.BOOKKEEPING_DOCUMENTS_BUCKET,
        Key: archiveKey,
        Body: meter,
        ContentType: "application/zip",
        ServerSideEncryption: "aws:kms",
        SSEKMSKeyId: process.env.BOOKKEEPING_DOCUMENTS_KMS_KEY,
      });
      zip.end();
      const uploaded = await uploadPromise;
      archiveUploaded = true;
      archiveVersionId = uploaded?.VersionId;
      if (!archiveVersionId) {
        const head = await headDocumentObject(
          process.env.BOOKKEEPING_DOCUMENTS_BUCKET || "",
          archiveKey,
        );
        archiveVersionId = head?.VersionId;
      }
      if (!archiveVersionId) throw new Error("archive-version-unavailable");
    } catch (error) {
      if (archiveUploaded && !archiveVersionId)
        await markGenerationCleanupRequired(
          client,
          generationLock.item.id,
        ).catch(() => undefined);
      else
        await deleteBookkeepingItem(client, "generation", generationLock.item.id);
      throw error;
    }
    let archiveDoc: BookkeepingItem;
    try {
      archiveDoc = (
        await putBookkeepingItem(client, "document", {
        id: archiveId,
        documentType: "monthly-report",
        originalFilename: `datatalksclub-${report.month}.zip`,
        contentType: "application/zip",
        byteSize: archiveBytes,
        sha256: digest.digest("hex"),
        s3Key: archiveKey,
        ...(archiveVersionId ? { objectVersionId: archiveVersionId } : {}),
        status: "active",
        })
      ).item;
      await markReportGenerated(client, report.id, archiveDoc.id);
      await deleteBookkeepingItem(client, "generation", generationLock.item.id);
    } catch (error) {
      await s3.send(new DeleteObjectCommand({ Bucket: process.env.BOOKKEEPING_DOCUMENTS_BUCKET, Key: archiveKey, VersionId: archiveVersionId! })).catch(() => undefined);
      await deleteBookkeepingItem(client, "document", archiveId).catch(() => undefined);
      await deleteBookkeepingItem(client, "generation", generationLock.item.id);
      throw error;
    }
    const url = await signUrl(
      s3,
      new GetObjectCommand({
        Bucket: process.env.BOOKKEEPING_DOCUMENTS_BUCKET,
        Key: archiveKey,
        ResponseContentDisposition: `attachment; filename="datatalksclub-${report.month}.zip"`,
      }),
      { expiresIn: 300 },
    );
    return json(201, { downloadUrl: url, expiresIn: 300, vatPreflight: await vatPreflightSummary(client) });
  }
  return null;
}
