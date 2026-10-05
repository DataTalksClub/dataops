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
    const existing = reports.find(
      (r) =>
        r.month === month && ["ready", "generated"].includes(String(r.status)),
    );
    if (existing) return json(200, { report: existing, duplicate: true });
    const accounts = (await listBookkeepingItems(client, "account")).filter(
      (a) => a.kind === "business" && a.active !== false,
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
    const monthTransactions = (
      await listBookkeepingItems(client, "bookkeeping")
    ).filter((t) => String(t.transactionDate).startsWith(month));
    const excludedTransactions = monthTransactions.filter(
      isReportExemptTransaction,
    );
    const transactions = monthTransactions.filter(
      (t) => !isReportExemptTransaction(t),
    );
    const links = await listBookkeepingItems(client, "link");
    const linkedIds = new Set(
      links
        .filter((l) => transactions.some((t) => t.id === l.transactionId))
        .map((l) => String(l.documentId)),
    );
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
        selectedPrivate.has(d.id),
    );
    const reportId = createHash("sha256").update(`report#${month}`).digest("hex");
    const guarded: string[] = [];
    let report: BookkeepingItem;
    try {
      for (const document of includedDocs) {
        if (await addDocumentReportReference(client, document.id, reportId))
          guarded.push(document.id);
      }
      report = (
        await putBookkeepingItem(
          client,
          "report",
          {
            id: reportId,
            month,
            status: "ready",
            transactionIds: transactions.map((t) => t.id),
            documentIds: includedDocs.map((d) => d.id),
            reconciliation: {
              transactionCount: transactions.length,
              excludedTransactionCount: excludedTransactions.length,
              documentCount: includedDocs.length,
              businessStatementCount: accounts.length,
            },
            snapshotVersion: 2,
          },
          `report#${month}`,
        )
      ).item;
    } catch (error) {
      await Promise.all(
        guarded.map((documentId) =>
          removeDocumentReportReference(client, documentId, reportId).catch(
            () => undefined,
          ),
        ),
      );
      throw error;
    }
    return json(201, {
      report,
      warnings: {
        missingEvidence: transactions.filter(
          (t) =>
            !links.some(
              (l) => l.transactionId === t.id && l.coverageType === "evidence",
            ),
        ).length,
      },
    });
  }
  if (path === "/api/bookkeeping/reports/vat" && method === "GET") {
    const year = event.queryStringParameters?.year;
    if (year != null && !/^\d{4}$/.test(String(year)))
      return json(400, { error: "Invalid year" });
    const withVat = (await listBookkeepingItems(client, "bookkeeping")).filter(
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
    const report = await getBookkeepingItem(client, "report", archive[1]);
    if (!report || !["ready", "generated"].includes(String(report.status)))
      return json(404, { error: "Ready report not found" });
    if (report.archiveDocumentId) {
      const doc = await getBookkeepingItem(
        client,
        "document",
        String(report.archiveDocumentId),
      );
      if (doc) {
        const url = await signUrl(
          s3,
          new GetObjectCommand({
            Bucket: process.env.BOOKKEEPING_DOCUMENTS_BUCKET,
            Key: String(doc.s3Key),
          }),
          { expiresIn: 300 },
        );
        return json(200, { downloadUrl: url, expiresIn: 300, duplicate: true });
      }
    }
    const transactionIds = Array.isArray(report.transactionIds)
        ? report.transactionIds.map(String)
        : [],
      documentIds = Array.isArray(report.documentIds)
        ? report.documentIds.map(String)
        : [];
    const maxFiles = Number(process.env.BOOKKEEPING_ARCHIVE_MAX_FILES || 500),
      maxBytes = Number(
      process.env.BOOKKEEPING_ARCHIVE_MAX_BYTES || 50 * 1024 * 1024,
      );
    if (documentIds.length + 1 > maxFiles)
      return json(413, { error: "Archive file limit exceeded" });
    const transactions = (
      await Promise.all(
        transactionIds.map((id) =>
          getBookkeepingItem(client, "bookkeeping", id),
        ),
      )
    ).filter(Boolean) as Record<string, unknown>[];
    const columns = [
      "transactionDate",
      "paidDate",
      "counterparty",
      "description",
      "amount",
      "currency",
      "amountEur",
      "vatAmount",
      "vatCurrency",
      "category",
      "entryType",
      "statementRef",
    ];
    const csv = Buffer.from(
      columns.join(",") +
        "\n" +
        transactions
          .map((t) => columns.map((c) => csvCell(t[c])).join(","))
          .join("\n") +
        "\n",
      "utf8",
    );
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
    return json(201, { downloadUrl: url, expiresIn: 300 });
  }
  return null;
}
