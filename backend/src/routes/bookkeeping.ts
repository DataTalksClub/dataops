import { timingSafeEqual } from "crypto";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "crypto";
import { ZipFile } from "yazl";
import { Upload } from "@aws-sdk/lib-storage";
import { Readable, Transform } from "stream";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { LambdaEvent, LambdaResponse } from "../types";
import {
  deleteBookkeepingItem,
  getBookkeepingItem,
  listBookkeepingItems,
  putBookkeepingItem,
  type BookkeepingItem,
} from "../db/bookkeeping";

const json = (statusCode: number, body: unknown): LambdaResponse => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const MONEY = /^(0|[1-9]\d{0,11})(\.\d{1,4})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const allowed = [
  "transactionDate",
  "paidDate",
  "counterparty",
  "description",
  "amount",
  "currency",
  "amountEur",
  "statementRef",
  "quantity",
  "comment",
  "entryType",
  "subtype",
  "period",
  "category",
  "sourceType",
  "sourceKey",
];
let secretCache: { value: string; expiresAt: number } | null = null;
const ingestionWindows = new Map<string, { started: number; count: number }>();
let s3 = new S3Client({});
let signUrl = getSignedUrl;
let uploadStream = async (params: ConstructorParameters<typeof Upload>[0]["params"]) => {
  await new Upload({ client: s3, params, leavePartsOnError: false }).done();
};
export function setBookkeepingStorageForTests(
  client: S3Client,
  signer: typeof getSignedUrl = getSignedUrl,
) {
  s3 = client;
  signUrl = signer;
}
export function setBookkeepingArchiveUploaderForTests(uploader: typeof uploadStream) {
  uploadStream = uploader;
}

function parse(body: string | null): Record<string, unknown> | null {
  try {
    return body ? JSON.parse(body) : null;
  } catch {
    return null;
  }
}
function validateTransaction(input: Record<string, unknown>, partial = false) {
  const errors: string[] = [];
  if (
    (!partial || input.transactionDate !== undefined) &&
    !realDate(input.transactionDate)
  )
    errors.push("transactionDate");
  if (input.paidDate != null && !realDate(input.paidDate))
    errors.push("paidDate");
  for (const name of ["counterparty", "description"] as const)
    if (!partial && (typeof input[name] !== "string" || !input[name].trim()))
      errors.push(name);
  for (const name of [
    "counterparty",
    "description",
    "statementRef",
    "comment",
    "entryType",
    "subtype",
    "period",
    "category",
    "sourceType",
    "sourceKey",
  ])
    if (
      input[name] != null &&
      (typeof input[name] !== "string" ||
        String(input[name]).length > (name === "comment" ? 2000 : 300))
    )
      errors.push(name);
  if (
    (!partial || input.amount !== undefined) &&
    (typeof input.amount !== "string" || !MONEY.test(input.amount))
  )
    errors.push("amount");
  if (
    input.amountEur != null &&
    (typeof input.amountEur !== "string" || !MONEY.test(input.amountEur))
  )
    errors.push("amountEur");
  if (
    (!partial || input.currency !== undefined) &&
    (typeof input.currency !== "string" || !CURRENCY.test(input.currency))
  )
    errors.push("currency");
  if (
    input.quantity != null &&
    (!Number.isSafeInteger(input.quantity) || Number(input.quantity) < 0)
  )
    errors.push("quantity");
  return [...new Set(errors)];
}
function realDate(value: unknown) {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number),
    parsed = new Date(Date.UTC(y, m - 1, d));
  return (
    parsed.getUTCFullYear() === y &&
    parsed.getUTCMonth() === m - 1 &&
    parsed.getUTCDate() === d
  );
}
function safeData(input: Record<string, unknown>) {
  return Object.fromEntries(
    allowed.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]),
  );
}
async function ingestionSecret() {
  if (process.env.BOOKKEEPING_INGESTION_SECRET)
    return process.env.BOOKKEEPING_INGESTION_SECRET;
  if (secretCache && secretCache.expiresAt > Date.now())
    return secretCache.value;
  const id = process.env.BOOKKEEPING_INGESTION_SECRET_NAME;
  if (!id) return "";
  const value =
    (
      await new SecretsManagerClient({}).send(
        new GetSecretValueCommand({ SecretId: id }),
      )
    ).SecretString || "";
  secretCache = {
    value,
    expiresAt:
      Date.now() + Number(process.env.BOOKKEEPING_SECRET_CACHE_MS || 60000),
  };
  return value;
}
async function machineAuthorized(event: LambdaEvent) {
  const provided =
    Object.entries(event.headers || {}).find(
      ([k]) => k.toLowerCase() === "x-bookkeeping-ingestion-key",
    )?.[1] || "";
  const stored = await ingestionSecret();
  let expected = stored,
    credentialId = "default";
  try {
    const parsed = JSON.parse(stored);
    expected = String(parsed.secret || "");
    credentialId = String(parsed.credentialId || "default");
  } catch {}
  const a = Buffer.from(provided),
    b = Buffer.from(expected);
  const authorized =
    !!expected && a.length === b.length && timingSafeEqual(a, b);
  return { authorized, credentialId };
}
const csvCell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

export async function handleBookkeepingRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
  sessionAuthorized: boolean,
): Promise<LambdaResponse> {
  const ingest = path === "/api/bookkeeping/ingest";
  let machine: { authorized: boolean; credentialId: string } | null = null;
  if (ingest && method === "POST") machine = await machineAuthorized(event);
  if (ingest && !machine?.authorized)
    return json(401, { error: "Unauthorized" });
  if (!ingest && !sessionAuthorized)
    return json(401, { error: "Unauthorized" });
  if (machine?.authorized) {
    const now = Date.now(),
      limit = Number(process.env.BOOKKEEPING_INGESTION_RATE_LIMIT || 60),
      window = ingestionWindows.get(machine.credentialId);
    if (!window || now - window.started >= 60000)
      ingestionWindows.set(machine.credentialId, { started: now, count: 1 });
    else if (++window.count > limit) {
      const limited = json(429, { error: "Rate limit exceeded" });
      limited.headers = { ...limited.headers, "Retry-After": "60" };
      return limited;
    }
    console.info(
      JSON.stringify({
        event: "bookkeeping_ingest",
        credentialId: machine.credentialId,
      }),
    );
  }
  const match = path.match(/^\/api\/bookkeeping\/transactions(?:\/([^/]+))?$/);
  if (match) {
    if (method === "GET" && !match[1])
      return json(200, {
        items: await listBookkeepingItems(client, "bookkeeping"),
      });
    if (method === "GET" && match[1]) {
      const item = await getBookkeepingItem(client, "bookkeeping", match[1]);
      return item ? json(200, item) : json(404, { error: "Not found" });
    }
    if (method === "DELETE" && match[1])
      return (await deleteBookkeepingItem(client, "bookkeeping", match[1]))
        ? { statusCode: 204, headers: {}, body: "" }
        : json(404, { error: "Not found" });
    if ((method === "POST" && !match[1]) || (method === "PUT" && match[1])) {
      const body = parse(event.body || null);
      if (!body) return json(400, { error: "Invalid JSON" });
      const previous = match[1]
        ? await getBookkeepingItem(client, "bookkeeping", match[1])
        : null;
      if (match[1] && !previous) return json(404, { error: "Not found" });
      const value: Record<string, unknown> = {
        ...(previous || {}),
        ...safeData(body),
        ...(match[1] ? { id: match[1] } : {}),
      };
      const errors = validateTransaction(value);
      if (errors.length)
        return json(400, { error: "Validation failed", fields: errors });
      if (match[1])
        await deleteBookkeepingItem(client, "bookkeeping", match[1]);
      const result = await putBookkeepingItem(
        client,
        "bookkeeping",
        value,
        typeof value.sourceKey === "string"
          ? `source#${value.sourceKey}`
          : undefined,
      );
      return json(match[1] ? 200 : 201, result.item);
    }
  }
  if (ingest && method === "POST") {
    const idempotency = Object.entries(event.headers || {}).find(
      ([k]) => k.toLowerCase() === "idempotency-key",
    )?.[1];
    if (!idempotency || idempotency.length > 200)
      return json(400, { error: "Idempotency-Key required" });
    const body = parse(event.body || null);
    if (!body || JSON.stringify(body).length > 16384)
      return json(400, { error: "Invalid request" });
    const errors = validateTransaction(body);
    if (errors.length)
      return json(400, { error: "Validation failed", fields: errors });
    const sourceKey = body.sourceKey;
    if (typeof sourceKey !== "string" || !sourceKey)
      return json(400, { error: "sourceKey required" });
    const result = await putBookkeepingItem(
      client,
      "bookkeeping",
      safeData(body),
      `source#${sourceKey}`,
    );
    return json(result.duplicate ? 200 : 201, {
      item: result.item,
      duplicate: result.duplicate,
    });
  }
  if (path === "/api/bookkeeping/documents/upload" && method === "POST") {
    const body = parse(event.body || null);
    const filename = String(body?.filename || "")
      .replace(/[^a-zA-Z0-9._ -]/g, "_")
      .slice(0, 180);
    const contentType = body?.contentType;
    const byteSize = Number(body?.byteSize);
    const limit = Number(
      process.env.BOOKKEEPING_PDF_MAX_BYTES || 20 * 1024 * 1024,
    );
    if (
      !filename.toLowerCase().endsWith(".pdf") ||
      contentType !== "application/pdf" ||
      !Number.isSafeInteger(byteSize) ||
      byteSize < 5 ||
      byteSize > limit
    )
      return json(400, { error: "Invalid PDF metadata" });
    const id = crypto.randomUUID(),
      s3Key = `documents/${id}`,
      bucket = process.env.BOOKKEEPING_DOCUMENTS_BUCKET;
    if (!bucket) return json(503, { error: "Document storage unavailable" });
    const doc = (
      await putBookkeepingItem(client, "document", {
        id,
        documentType: body?.documentType || "other-evidence",
        originalFilename: filename,
        contentType,
        byteSize,
        s3Key,
        status: "pending",
        accountId: body?.accountId,
        statementMonth: body?.statementMonth,
      })
    ).item;
    const uploadUrl = await signUrl(
      s3,
      new PutObjectCommand({
        Bucket: bucket,
        Key: s3Key,
        ContentType: "application/pdf",
        ServerSideEncryption: "aws:kms",
        SSEKMSKeyId: process.env.BOOKKEEPING_DOCUMENTS_KMS_KEY,
      }),
      { expiresIn: 300 },
    );
    const { s3Key: _private, ...metadata } = doc;
    return json(201, { document: metadata, uploadUrl, expiresIn: 300 });
  }
  const complete = path.match(
    /^\/api\/bookkeeping\/documents\/([^/]+)\/complete$/,
  );
  if (complete && method === "POST") {
    const doc = await getBookkeepingItem(client, "document", complete[1]);
    if (!doc || doc.status !== "pending")
      return json(404, { error: "Pending document not found" });
    const bucket = process.env.BOOKKEEPING_DOCUMENTS_BUCKET || "";
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: String(doc.s3Key) }),
    );
    if (
      head.ContentLength !== doc.byteSize ||
      head.ContentType !== "application/pdf"
    )
      return json(400, { error: "Uploaded object verification failed" });
    const object = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: String(doc.s3Key) }),
    );
    const bytes = await object.Body!.transformToByteArray();
    if (Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-")
      return json(400, { error: "Uploaded object is not a PDF" });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const documents = await listBookkeepingItems(client, "document");
    if (
      documents.some(
        (d) => d.id !== doc.id && d.sha256 === sha256 && d.status === "active",
      )
    )
      return json(409, { error: "Duplicate document" });
    await deleteBookkeepingItem(client, "document", doc.id);
    const active = (
      await putBookkeepingItem(client, "document", {
        ...doc,
        status: "active",
        sha256,
      })
    ).item;
    const { s3Key: _private, ...metadata } = active;
    return json(200, { document: metadata });
  }
  const download = path.match(
    /^\/api\/bookkeeping\/documents\/([^/]+)\/download$/,
  );
  if (download && method === "GET") {
    const doc = await getBookkeepingItem(client, "document", download[1]);
    if (!doc || doc.status !== "active")
      return json(404, { error: "Document not found" });
    const downloadUrl = await signUrl(
      s3,
      new GetObjectCommand({
        Bucket: process.env.BOOKKEEPING_DOCUMENTS_BUCKET,
        Key: String(doc.s3Key),
        ResponseContentDisposition: `attachment; filename="${String(doc.originalFilename).replace(/["\\]/g, "_")}"`,
      }),
      { expiresIn: 300 },
    );
    return json(200, { downloadUrl, expiresIn: 300 });
  }
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
    const transactions = (
      await listBookkeepingItems(client, "bookkeeping")
    ).filter((t) => String(t.transactionDate).startsWith(month));
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
    const report = (
      await putBookkeepingItem(
        client,
        "report",
        {
          month,
          status: "ready",
          transactionIds: transactions.map((t) => t.id),
          documentIds: includedDocs.map((d) => d.id),
          reconciliation: {
            transactionCount: transactions.length,
            documentCount: includedDocs.length,
            businessStatementCount: accounts.length,
          },
          snapshotVersion: 1,
        },
        `report#${month}`,
      )
    ).item;
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
      await uploadPromise;
    } catch (error) {
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
        status: "active",
        })
      ).item;
      await deleteBookkeepingItem(client, "report", report.id);
      await putBookkeepingItem(client, "report", {
        ...report,
        status: "generated",
        archiveDocumentId: archiveDoc.id,
      });
      await deleteBookkeepingItem(client, "generation", generationLock.item.id);
    } catch (error) {
      await s3.send(new DeleteObjectCommand({ Bucket: process.env.BOOKKEEPING_DOCUMENTS_BUCKET, Key: archiveKey })).catch(() => undefined);
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
  if (path === "/api/bookkeeping/accounts/setup" && method === "POST") {
    const names = [
      process.env.BOOKKEEPING_BUSINESS_ACCOUNT_1 || "Primary business account",
      process.env.BOOKKEEPING_BUSINESS_ACCOUNT_2 || "Secondary business account",
    ];
    const accounts = [];
    for (const [index, displayName] of names.entries()) {
      accounts.push((await putBookkeepingItem(client, "account", {
        id: `business-${index + 1}`,
        displayName,
        kind: "business",
        active: true,
      }, `business-account#${index + 1}`)).item);
    }
    return json(200, { accounts });
  }
  // Account/link/report metadata use the same private table and authenticated boundary.
  const resource = path.match(
    /^\/api\/bookkeeping\/(accounts|documents|links|reports)(?:\/([^/]+))?$/,
  );
  if (resource) {
    const kind = resource[1].slice(0, -1),
      id = resource[2];
    if (method === "GET" && !id) {
      const items = await listBookkeepingItems(client, kind);
      return json(200, {
        items: items.map((i) => {
          const { s3Key, ...safe } = i;
          return safe;
        }),
      });
    }
    if (method === "POST" && !id) {
      if (kind === "document" || kind === "report") {
        return json(405, {
          error: "Use the validated upload or report snapshot endpoint",
        });
      }
      const body = parse(event.body || null);
      if (!body) return json(400, { error: "Invalid JSON" });
      if (
        kind === "account" &&
        (!["business", "private"].includes(String(body.kind)) ||
          typeof body.displayName !== "string")
      )
        return json(400, { error: "Invalid account" });
      if (kind === "link") {
        if (
          !["evidence", "statement-coverage", "report-source"].includes(
            String(body.coverageType),
          )
        )
          return json(400, { error: "Invalid coverage type" });
        if (
          !(await getBookkeepingItem(
            client,
            "document",
            String(body.documentId),
          )) ||
          !(await getBookkeepingItem(
            client,
            "bookkeeping",
            String(body.transactionId),
          ))
        )
          return json(404, { error: "Link target not found" });
      }
      if (kind === "report" && !MONTH.test(String(body.month || "")))
        return json(400, { error: "Invalid month" });
      return json(
        201,
        (
          await putBookkeepingItem(
            client,
            kind,
            body,
            kind === "link"
              ? `link#${body.documentId}#${body.transactionId}#${body.coverageType}`
              : undefined,
          )
        ).item,
      );
    }
    if (method === "DELETE" && id)
      return (await deleteBookkeepingItem(client, kind, id))
        ? { statusCode: 204, headers: {}, body: "" }
        : json(404, { error: "Not found" });
  }
  return json(404, { error: "Not found" });
}
