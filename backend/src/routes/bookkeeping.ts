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
  addDocumentReportReference,
  activateDocument,
  backfillDocumentHashClaims,
  createDocumentLink,
  deleteBookkeepingItem,
  deleteDocumentLink,
  deleteDeletingReport,
  deleteRunOwnedLink,
  documentHashClaimsReady,
  getBookkeepingItem,
  getRawDocument,
  listBookkeepingItems,
  listRunOwnedItems,
  listRunOwnedPage,
  lookupDocumentHash,
  markDocumentCleanupRequired,
  markDocumentRollbackDeleting,
  markGenerationCleanupRequired,
  markReportDeleting,
  markReportGenerated,
  putBookkeepingItem,
  prepareDocument,
  removePendingDocumentClaim,
  removeDocumentReportReference,
  removeRollbackDocument,
  renewDocumentPrepareLease,
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
const SHA256 = /^[a-f0-9]{64}$/;
const OPAQUE = /^[a-zA-Z0-9._:-]{1,160}$/;
const DOCUMENT_TYPES = new Set([
  "invoice",
  "receipt",
  "bank-statement",
  "private-account-statement",
  "other-evidence",
]);
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
type ArchiveUploadResult = { VersionId?: string } | void;
let uploadStream: (
  params: ConstructorParameters<typeof Upload>[0]["params"],
) => Promise<ArchiveUploadResult> = async (params) =>
  await new Upload({ client: s3, params, leavePartsOnError: false }).done();
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

function publicDocument(document: Record<string, unknown>) {
  const {
    PK: _pk,
    SK: _sk,
    s3Key: _key,
    objectVersionId: _version,
    creatorIdempotencyKey: _owner,
    declaredSha256: _declaredHash,
    sha256: _verifiedHash,
    createdByRunId: _run,
    sourceRef: _source,
    ...safe
  } = document;
  return safe;
}

function publicLink(link: Record<string, unknown>) {
  const { createdByRunId: _run, sourceRef: _source, ...safe } = link;
  return safe;
}

async function verifyPdfObject(bucket: string, document: Record<string, unknown>) {
  const object = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: String(document.s3Key) }),
  );
  if (!object.Body) throw new Error("upload-missing");
  const digest = createHash("sha256");
  let size = 0;
  let prefix = Buffer.alloc(0);
  for await (const part of object.Body as unknown as AsyncIterable<Uint8Array>) {
    const bytes = Buffer.from(part);
    size += bytes.length;
    if (
      size > Number(document.declaredByteSize) ||
      size > Number(process.env.BOOKKEEPING_PDF_MAX_BYTES || 20 * 1024 * 1024)
    )
      throw new Error("object-size-limit");
    if (prefix.length < 5)
      prefix = Buffer.concat([prefix, bytes.subarray(0, 5 - prefix.length)]);
    digest.update(bytes);
  }
  return {
    size,
    sha256: digest.digest("hex"),
    pdf: prefix.toString("ascii") === "%PDF-",
    versionId: object.VersionId || "",
  };
}

async function deleteExactDocumentObject(
  bucket: string,
  document: Record<string, unknown>,
  versionId?: string,
) {
  if (!versionId) throw new Error("object-version-unavailable");
  await s3.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: String(document.s3Key),
      VersionId: versionId,
    }),
  );
}

async function headDocumentObject(bucket: string, key: string) {
  try {
    return await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode;
    if (
      status === 404 ||
      ["NoSuchKey", "NotFound", "NoSuchObject"].includes((error as Error).name)
    )
      return null;
    throw error;
  }
}

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
  if (path === "/api/bookkeeping/transactions/resolve" && method === "POST") {
    const body = parse(event.body || null);
    const sourceKeys = body?.sourceKeys;
    if (
      !Array.isArray(sourceKeys) ||
      sourceKeys.length < 1 ||
      sourceKeys.length > 100 ||
      sourceKeys.some((value) => typeof value !== "string" || !value || value.length > 300)
    )
      return json(400, { error: "Invalid request" });
    const resolved = [];
    const missing = [];
    for (const sourceKey of [...new Set(sourceKeys as string[])]) {
      const id = createHash("sha256").update(`source#${sourceKey}`).digest("hex");
      const item = await getBookkeepingItem(client, "bookkeeping", id);
      if (item?.sourceKey === sourceKey) resolved.push({ sourceKey, id: item.id });
      else missing.push(sourceKey);
    }
    return json(200, { resolved, missing });
  }
  if (path === "/api/bookkeeping/documents/hash-lookup" && method === "POST") {
    const body = parse(event.body || null);
    const hashes = body?.hashes;
    if (
      !Array.isArray(hashes) ||
      hashes.length < 1 ||
      hashes.length > 100 ||
      hashes.some((value) => typeof value !== "string" || !SHA256.test(value))
    )
      return json(400, { error: "Invalid request" });
    const results = [];
    for (const sha256 of hashes as string[]) {
      const lookup = await lookupDocumentHash(client, sha256);
      results.push(
        lookup.state === "active"
          ? {
              state: "active",
              documentId: lookup.document?.id,
              byteSize: lookup.document?.verifiedByteSize || lookup.document?.byteSize,
              documentType: lookup.document?.documentType,
              accountId: lookup.document?.accountId,
              statementMonth: lookup.document?.statementMonth,
            }
          : { state: lookup.state },
      );
    }
    return json(200, { results });
  }
  if (path === "/api/bookkeeping/links/lookup" && method === "POST") {
    const body = parse(event.body || null);
    const tuples = body?.tuples;
    if (
      !Array.isArray(tuples) ||
      tuples.length < 1 ||
      tuples.length > 100 ||
      tuples.some(
        (tuple) =>
          !tuple ||
          !OPAQUE.test(String(tuple.documentId || "")) ||
          !OPAQUE.test(String(tuple.transactionId || "")) ||
          !["evidence", "statement-coverage"].includes(String(tuple.coverageType)),
      )
    )
      return json(400, { error: "Invalid request" });
    const results = [];
    for (const tuple of tuples as Record<string, unknown>[]) {
      const id = createHash("sha256")
        .update(
          `link#${tuple.documentId}#${tuple.transactionId}#${tuple.coverageType}`,
        )
        .digest("hex");
      const link = await getBookkeepingItem(client, "link", id);
      results.push(link ? { state: "active", id: link.id } : { state: "absent" });
    }
    return json(200, { results });
  }
  if (
    path === "/api/bookkeeping/documents/hash-claims/backfill" &&
    method === "POST"
  ) {
    const body = parse(event.body || null);
    const result = await backfillDocumentHashClaims(client, body?.write === true);
    if (result.conflicts || result.unclaimable)
      return json(409, { error: "Hash claim conflict", ...result });
    return json(200, {
      ...result,
      ready: await documentHashClaimsReady(client),
    });
  }
  if (path === "/api/bookkeeping/documents/prepare" && method === "POST") {
    const body = parse(event.body || null);
    const byteSize = Number(body?.byteSize);
    const documentType = String(body?.documentType || "");
    const statement = ["bank-statement", "private-account-statement"].includes(documentType);
    const limit = Number(process.env.BOOKKEEPING_PDF_MAX_BYTES || 20 * 1024 * 1024);
    if (
      !body ||
      !SHA256.test(String(body.sha256 || "")) ||
      !Number.isSafeInteger(byteSize) ||
      byteSize < 5 ||
      byteSize > limit ||
      !DOCUMENT_TYPES.has(documentType) ||
      !OPAQUE.test(String(body.idempotencyKey || "")) ||
      !OPAQUE.test(String(body.runId || "")) ||
      !OPAQUE.test(String(body.sourceRef || "")) ||
      (statement &&
        (!OPAQUE.test(String(body.accountId || "")) ||
          !MONTH.test(String(body.statementMonth || "")))) ||
      (!statement && (body.accountId !== undefined || body.statementMonth !== undefined))
    )
      return json(400, { error: "Invalid request" });
    const bucket = process.env.BOOKKEEPING_DOCUMENTS_BUCKET;
    const kmsKey = process.env.BOOKKEEPING_DOCUMENTS_KMS_KEY;
    if (!bucket || !kmsKey)
      return json(503, { error: "Document storage unavailable" });
    if (!(await documentHashClaimsReady(client)))
      return json(503, { error: "Document hash claims not ready" });
    const sha256 = String(body.sha256);
    const uploadSeconds =
      process.env.NODE_ENV === "test"
        ? Number(process.env.BOOKKEEPING_UPLOAD_URL_SECONDS || 300)
        : Math.max(60, Number(process.env.BOOKKEEPING_UPLOAD_URL_SECONDS || 300));
    const uploadAuthorizationExpiresAt = new Date(
      Date.now() + uploadSeconds * 1000,
    ).toISOString();
    let prepared = await prepareDocument(client, {
      sha256,
      byteSize,
      documentType,
      ...(statement ? { accountId: String(body.accountId), statementMonth: String(body.statementMonth) } : {}),
      idempotencyKey: String(body.idempotencyKey),
      runId: String(body.runId),
      sourceRef: String(body.sourceRef),
      s3Key: "documents/{id}",
      expiresAt: new Date(Date.now() + Math.max(900, Number(process.env.BOOKKEEPING_PREPARE_TTL_SECONDS || 900)) * 1000).toISOString(),
      uploadAuthorizationExpiresAt,
    });
    if (
      ["pending", "retry"].includes(prepared.outcome) &&
      Date.parse(String(prepared.document?.prepareExpiresAt || "")) < Date.now()
    ) {
      const stale = prepared.document!;
      try {
        await markDocumentCleanupRequired(
          client,
          String(stale.id),
          String(stale.creatorIdempotencyKey),
          String(stale.createdByRunId),
        );
        const head = await headDocumentObject(bucket, String(stale.s3Key));
        if (head) await deleteExactDocumentObject(bucket, stale, head.VersionId);
        await removePendingDocumentClaim(client, String(stale.id), sha256, String(stale.creatorIdempotencyKey), String(stale.createdByRunId));
        prepared = await prepareDocument(client, {
          sha256,
          byteSize,
          documentType,
          ...(statement ? { accountId: String(body.accountId), statementMonth: String(body.statementMonth) } : {}),
          idempotencyKey: String(body.idempotencyKey),
          runId: String(body.runId),
          sourceRef: String(body.sourceRef),
          s3Key: "documents/{id}",
          expiresAt: new Date(Date.now() + Math.max(900, Number(process.env.BOOKKEEPING_PREPARE_TTL_SECONDS || 900)) * 1000).toISOString(),
          uploadAuthorizationExpiresAt,
        });
      } catch {
        return json(409, { error: "Pending cleanup required" });
      }
    }
    if (prepared.outcome === "cleanup-required") {
      const cleanup = prepared.document;
      if (
        !cleanup ||
        cleanup.creatorIdempotencyKey !== body.idempotencyKey ||
        cleanup.createdByRunId !== body.runId
      )
        return json(409, { error: "Pending cleanup required" });
      if (
        Date.parse(String(cleanup.uploadAuthorizationExpiresAt || "")) >=
        Date.now()
      )
        return json(409, { error: "Cleanup deferred" });
      try {
        const head = await headDocumentObject(bucket, String(cleanup.s3Key));
        if (head)
          await deleteExactDocumentObject(bucket, cleanup, head.VersionId);
        await removePendingDocumentClaim(
          client,
          String(cleanup.id),
          sha256,
          String(cleanup.creatorIdempotencyKey),
          String(cleanup.createdByRunId),
        );
        prepared = await prepareDocument(client, {
          sha256,
          byteSize,
          documentType,
          ...(statement
            ? {
                accountId: String(body.accountId),
                statementMonth: String(body.statementMonth),
              }
            : {}),
          idempotencyKey: String(body.idempotencyKey),
          runId: String(body.runId),
          sourceRef: String(body.sourceRef),
          s3Key: "documents/{id}",
          expiresAt: new Date(
            Date.now() +
              Math.max(
                900,
                Number(process.env.BOOKKEEPING_PREPARE_TTL_SECONDS || 900),
              ) *
                1000,
          ).toISOString(),
          uploadAuthorizationExpiresAt,
        });
      } catch {
        return json(503, { error: "Cleanup required" });
      }
    }
    if (prepared.outcome === "existing")
      return json(200, { outcome: "existing", document: publicDocument(prepared.document!) });
    if (prepared.outcome === "pending")
      return json(409, { error: "Content upload pending" });
    if (prepared.outcome === "retry") {
      await renewDocumentPrepareLease(
        client,
        String(prepared.document!.id),
        sha256,
        String(body.idempotencyKey),
        String(body.runId),
        new Date(
          Date.now() +
            Math.max(
              900,
              Number(process.env.BOOKKEEPING_PREPARE_TTL_SECONDS || 900),
            ) *
              1000,
        ).toISOString(),
        uploadAuthorizationExpiresAt,
      );
    }
    const checksum = Buffer.from(sha256, "hex").toString("base64");
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: String(prepared.document!.s3Key),
      ContentType: "application/pdf",
      ContentLength: byteSize,
      ChecksumSHA256: checksum,
      IfNoneMatch: "*",
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: kmsKey,
    });
    const uploadUrl = await signUrl(s3, command, { expiresIn: uploadSeconds });
    return json(prepared.outcome === "created" ? 201 : 200, {
      outcome: prepared.outcome,
      document: publicDocument(prepared.document!),
      uploadUrl,
      expiresIn: uploadSeconds,
      uploadHeaders: {
        "content-type": "application/pdf",
        "content-length": String(byteSize),
        "if-none-match": "*",
        "x-amz-checksum-sha256": checksum,
        "x-amz-server-side-encryption": "aws:kms",
        "x-amz-server-side-encryption-aws-kms-key-id": kmsKey,
      },
    });
  }
  const cancel = path.match(/^\/api\/bookkeeping\/documents\/([^/]+)\/cancel$/);
  if (cancel && method === "POST") {
    const body = parse(event.body || null);
    if (!body || !OPAQUE.test(String(body.idempotencyKey || "")) || !OPAQUE.test(String(body.runId || "")))
      return json(400, { error: "Invalid request" });
    const document = await getRawDocument(client, cancel[1]);
    if (!document) return json(200, { outcome: "absent" });
    if (
      document.creatorIdempotencyKey !== body.idempotencyKey ||
      document.createdByRunId !== body.runId ||
      !["pending", "cleanup-required"].includes(String(document.status))
    )
      return json(409, { error: "Cleanup refused" });
    if (
      Date.parse(String(document.uploadAuthorizationExpiresAt || "")) >= Date.now()
    )
      return json(409, { error: "Upload lease active" });
    const bucket = process.env.BOOKKEEPING_DOCUMENTS_BUCKET || "";
    try {
      if (document.status === "pending")
        await markDocumentCleanupRequired(
          client,
          cancel[1],
          String(body.idempotencyKey),
          String(body.runId),
        );
      const head = await headDocumentObject(bucket, String(document.s3Key));
      if (head) await deleteExactDocumentObject(bucket, document, head.VersionId);
      await removePendingDocumentClaim(client, cancel[1], String(document.declaredSha256), String(body.idempotencyKey), String(body.runId));
      return json(200, { outcome: "cancelled" });
    } catch {
      await markDocumentCleanupRequired(client, cancel[1], String(body.idempotencyKey), String(body.runId)).catch(() => undefined);
      return json(503, { error: "Cleanup required" });
    }
  }
  if (path === "/api/bookkeeping/documents/upload" && method === "POST") {
    return json(410, { error: "Use the atomic document prepare endpoint" });
  }
  const complete = path.match(
    /^\/api\/bookkeeping\/documents\/([^/]+)\/complete$/,
  );
  if (complete && method === "POST") {
    const doc = await getBookkeepingItem(client, "document", complete[1]);
    if (!doc)
      return json(404, { error: "Pending document not found" });
    if (doc.status === "active" && doc.declaredSha256) {
      const body = parse(event.body || null);
      if (
        !body ||
        doc.creatorIdempotencyKey !== body.idempotencyKey ||
        doc.createdByRunId !== body.runId
      )
        return json(409, { error: "Completion refused" });
      return json(200, { outcome: "existing", document: publicDocument(doc) });
    }
    if (doc.status !== "pending")
      return json(404, { error: "Pending document not found" });
    if (doc.declaredSha256) {
      const body = parse(event.body || null);
      if (
        !body ||
        !OPAQUE.test(String(body.idempotencyKey || "")) ||
        !OPAQUE.test(String(body.runId || "")) ||
        doc.creatorIdempotencyKey !== body.idempotencyKey ||
        doc.createdByRunId !== body.runId
      )
        return json(409, { error: "Completion refused" });
      const bucket = process.env.BOOKKEEPING_DOCUMENTS_BUCKET || "";
      let verified: Awaited<ReturnType<typeof verifyPdfObject>>;
      try {
        verified = await verifyPdfObject(bucket, await getRawDocument(client, complete[1]) || doc);
      } catch (error) {
        if ((error as Error).message === "upload-missing")
          return json(409, { error: "Upload unavailable" });
        try {
          const rawDocument = (await getRawDocument(client, complete[1]))!;
          await markDocumentCleanupRequired(
            client,
            complete[1],
            String(body.idempotencyKey),
            String(body.runId),
          );
          if (
            Date.parse(String(rawDocument.uploadAuthorizationExpiresAt || "")) >=
            Date.now()
          )
            return json(409, { error: "Cleanup deferred" });
          const head = await s3.send(
            new HeadObjectCommand({ Bucket: bucket, Key: String(rawDocument.s3Key) }),
          );
          await deleteExactDocumentObject(bucket, rawDocument, head.VersionId);
          await removePendingDocumentClaim(
            client,
            complete[1],
            String(doc.declaredSha256),
            String(body.idempotencyKey),
            String(body.runId),
          );
          return json(400, { error: "Uploaded object verification failed" });
        } catch {
          await markDocumentCleanupRequired(
            client,
            complete[1],
            String(body.idempotencyKey),
            String(body.runId),
          ).catch(() => undefined);
          return json(503, { error: "Cleanup required" });
        }
      }
      if (
        verified.size !== Number(doc.declaredByteSize) ||
        verified.sha256 !== doc.declaredSha256 ||
        !verified.pdf ||
        !verified.versionId
      ) {
        try {
          const rawDocument = (await getRawDocument(client, complete[1]))!;
          await markDocumentCleanupRequired(
            client,
            complete[1],
            String(body.idempotencyKey),
            String(body.runId),
          );
          if (
            Date.parse(String(rawDocument.uploadAuthorizationExpiresAt || "")) >=
            Date.now()
          )
            return json(409, { error: "Cleanup deferred" });
          await deleteExactDocumentObject(bucket, rawDocument, verified.versionId);
          await removePendingDocumentClaim(
            client,
            complete[1],
            String(doc.declaredSha256),
            String(body.idempotencyKey),
            String(body.runId),
          );
        } catch {
          await markDocumentCleanupRequired(
            client,
            complete[1],
            String(body.idempotencyKey),
            String(body.runId),
          ).catch(() => undefined);
          return json(503, { error: "Cleanup required" });
        }
        return json(400, { error: "Uploaded object verification failed" });
      }
      try {
        await activateDocument(
          client,
          complete[1],
          verified.sha256,
          String(body.idempotencyKey),
          String(body.runId),
          verified.versionId,
          verified.size,
        );
      } catch (error) {
        const current = await getBookkeepingItem(client, "document", complete[1]);
        if (current?.status === "active")
          return json(200, {
            outcome: "existing",
            document: publicDocument(current),
          });
        try {
          const rawDocument = (await getRawDocument(client, complete[1]))!;
          await markDocumentCleanupRequired(
            client,
            complete[1],
            String(body.idempotencyKey),
            String(body.runId),
          );
          if (
            Date.parse(String(rawDocument.uploadAuthorizationExpiresAt || "")) >=
            Date.now()
          )
            return json(503, { error: "Document activation failed" });
          await deleteExactDocumentObject(bucket, rawDocument, verified.versionId);
          await removePendingDocumentClaim(
            client,
            complete[1],
            verified.sha256,
            String(body.idempotencyKey),
            String(body.runId),
          );
        } catch {
          await markDocumentCleanupRequired(
            client,
            complete[1],
            String(body.idempotencyKey),
            String(body.runId),
          ).catch(() => undefined);
        }
        return json(503, { error: "Document activation failed" });
      }
      const active = await getBookkeepingItem(client, "document", complete[1]);
      return json(200, { outcome: "created", document: publicDocument(active!) });
    }
    return json(409, { error: "Legacy pending upload requires operator cleanup" });
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
              documentCount: includedDocs.length,
              businessStatementCount: accounts.length,
            },
            snapshotVersion: 1,
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
  const runRoute = path.match(
    /^\/api\/bookkeeping\/migration-runs\/([^/]+)\/(reconcile|rollback)$/,
  );
  if (runRoute && method === "POST") {
    const runId = runRoute[1];
    if (!OPAQUE.test(runId)) return json(400, { error: "Invalid request" });
    const body = parse(event.body || null) || {};
    if (runRoute[2] === "reconcile") {
      const kind = body.kind === "link" ? "link" : "document";
      let page: Awaited<ReturnType<typeof listRunOwnedPage>>;
      try {
        page = await listRunOwnedPage(
          client,
          kind,
          runId,
          typeof body.nextToken === "string" ? body.nextToken : undefined,
          Number(body.limit || 100),
        );
      } catch {
        return json(400, { error: "Invalid page token" });
      }
      return json(200, {
        runId,
        kind,
        items: page.items.map((item) =>
          kind === "document"
            ? {
                id: item.id,
                status: item.status,
                byteSize: item.verifiedByteSize || item.byteSize,
                documentType: item.documentType,
                accountId: item.accountId,
                statementMonth: item.statementMonth,
              }
            : {
                id: item.id,
                documentId: item.documentId,
                transactionId: item.transactionId,
                coverageType: item.coverageType,
              },
        ),
        nextToken: page.nextToken,
      });
    }
    let links = await listRunOwnedItems(client, "link", runId);
    let documents = await listRunOwnedItems(client, "document", runId);
    const refused = documents.filter(
      (document) =>
        Number(document.linkRefCount || 0) >
          links.filter((link) => link.documentId === document.id).length ||
        Number(document.reportRefCount || 0) > 0 ||
        Date.parse(String(document.uploadAuthorizationExpiresAt || "")) >=
          Date.now(),
    );
    const deferred = documents.filter(
      (document) =>
        Date.parse(String(document.uploadAuthorizationExpiresAt || "")) >=
        Date.now(),
    );
    if (body.write !== true)
      return json(200, {
        runId,
        write: false,
        links: links.length,
        documents: documents.length,
        eligibleDocuments: documents.length - refused.length,
        refusedDocuments: refused.length,
        deferredDocuments: deferred.length,
      });
    let linksDeleted = 0;
    let documentsDeleted = 0;
    let refusedDocuments = 0;
    let failedDocuments = 0;
    for (const link of links) {
      try {
        await deleteRunOwnedLink(client, link, runId);
        linksDeleted += 1;
      } catch (error) {
        if ((error as Error).name !== "TransactionCanceledException") throw error;
      }
    }
    documents = await listRunOwnedItems(client, "document", runId);
    for (const document of documents) {
      try {
        await markDocumentRollbackDeleting(client, document.id, runId);
      } catch (error) {
        if (
          ["ConditionalCheckFailedException", "TransactionCanceledException"].includes(
            (error as Error).name,
          )
        ) {
          refusedDocuments += 1;
          continue;
        }
        throw error;
      }
      const rawDocument = await getRawDocument(client, document.id);
      if (!rawDocument) continue;
      try {
        await deleteExactDocumentObject(
          process.env.BOOKKEEPING_DOCUMENTS_BUCKET || "",
          rawDocument,
          String(rawDocument.objectVersionId || ""),
        );
        await removeRollbackDocument(
          client,
          document.id,
          String(document.sha256 || document.declaredSha256),
          runId,
        );
        documentsDeleted += 1;
      } catch {
        failedDocuments += 1;
      }
    }
    links = await listRunOwnedItems(client, "link", runId);
    documents = await listRunOwnedItems(client, "document", runId);
    return json(200, {
      runId,
      write: true,
      linksDeleted,
      documentsDeleted,
      refusedDocuments,
      failedDocuments,
      remainingLinks: links.length,
      remainingDocuments: documents.length,
    });
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
        items: items.map((item) =>
          kind === "document"
            ? publicDocument(item)
            : kind === "link"
              ? publicLink(item)
              : item,
        ),
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
        const targetDocument = await getBookkeepingItem(
          client,
          "document",
          String(body.documentId),
        );
        if (
          targetDocument?.status !== "active" ||
          !(await getBookkeepingItem(client, "bookkeeping", String(body.transactionId)))
        )
          return json(404, { error: "Link target not found" });
        if (
          (body.runId !== undefined && !OPAQUE.test(String(body.runId))) ||
          (body.sourceRef !== undefined && !OPAQUE.test(String(body.sourceRef)))
        )
          return json(400, { error: "Invalid request" });
        const result = await createDocumentLink(client, {
          documentId: String(body.documentId),
          transactionId: String(body.transactionId),
          coverageType: String(body.coverageType),
          ...(body.runId ? { runId: String(body.runId) } : {}),
          ...(body.sourceRef ? { sourceRef: String(body.sourceRef) } : {}),
        });
        const safeLink = publicLink(result.item);
        return json(result.outcome === "created" ? 201 : 200, {
          ...safeLink,
          outcome: result.outcome,
          link: safeLink,
        });
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
    if (method === "DELETE" && id) {
      if (kind === "document")
        return json(405, { error: "Use a run-owned cleanup or rollback endpoint" });
      if (kind === "link") {
        const link = await getBookkeepingItem(client, "link", id);
        if (!link) return json(404, { error: "Not found" });
        await deleteDocumentLink(client, link);
        return { statusCode: 204, headers: {}, body: "" };
      }
      if (kind === "report") {
        const report = await getBookkeepingItem(client, "report", id);
        if (!report) return json(404, { error: "Not found" });
        await markReportDeleting(client, id);
        let cleanupFailed = false;
        for (const documentId of Array.isArray(report.documentIds)
          ? report.documentIds.map(String)
          : [])
          await removeDocumentReportReference(client, documentId, id).catch(
            (error) => {
              if ((error as Error).name !== "TransactionCanceledException")
                cleanupFailed = true;
            },
          );
        if (cleanupFailed)
          return json(503, { error: "Report cleanup incomplete" });
        await deleteDeletingReport(client, id);
        return { statusCode: 204, headers: {}, body: "" };
      }
      return (await deleteBookkeepingItem(client, kind, id))
        ? { statusCode: 204, headers: {}, body: "" }
        : json(404, { error: "Not found" });
    }
  }
  return json(404, { error: "Not found" });
}
