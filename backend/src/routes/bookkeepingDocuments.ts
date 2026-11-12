import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { LambdaEvent, LambdaResponse } from "../types";
import {
  activateDocument,
  getBookkeepingItem,
  getRawDocument,
  markDocumentCleanupRequired,
  prepareDocument,
  removePendingDocumentClaim,
  renewDocumentPrepareLease,
} from "../db/bookkeeping";
import {
  deleteExactDocumentObject,
  headDocumentObject,
  json,
  MONTH,
  parse,
  publicDocument,
  s3,
  signUrl,
  verifyDocumentObject,
} from "./bookkeepingShared";

import { extractDocumentFacts } from "./bookkeepingSuggestions";
import { bookkeepingDocumentsBucket } from "../runtimePaths";

const SHA256 = /^[a-f0-9]{64}$/;
const OPAQUE = /^[a-zA-Z0-9._:-]{1,160}$/;
function safeUploadFilename(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\\/g, "/").split("/").at(-1)!
    .replace(/[\u0000-\u001f\u007f"]/g, "_").trim().slice(0, 300);
}
const DOCUMENT_TYPES = new Set([
  "invoice",
  "receipt",
  "bank-statement",
  "private-account-statement",
  "other-evidence",
]);
/** Bank statements may be PDFs or tabular CSV exports; every other document type stays PDF-only. */
const STATEMENT_CONTENT_TYPES = new Set(["application/pdf", "text/csv"]);

export async function handleBookkeepingDocumentRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  if (path === "/api/bookkeeping/documents/prepare" && method === "POST") {
    const body = parse(event.body || null);
    const byteSize = Number(body?.byteSize);
    const documentType = String(body?.documentType || "");
    const statement = ["bank-statement", "private-account-statement"].includes(documentType);
    const filenameProvided = body?.originalFilename !== undefined;
    const originalFilename = filenameProvided ? safeUploadFilename(body?.originalFilename) : "";
    const requestedContentType = String(body?.contentType || "application/pdf").split(";")[0].trim().toLowerCase();
    if (statement && !STATEMENT_CONTENT_TYPES.has(requestedContentType))
      return json(400, { error: "Bank statement uploads accept PDF or CSV files only" });
    const limit = Number(process.env.BOOKKEEPING_PDF_MAX_BYTES || 20 * 1024 * 1024);
    if (
      !body ||
      !SHA256.test(String(body.sha256 || "")) ||
      !Number.isSafeInteger(byteSize) ||
      byteSize < 5 ||
      byteSize > limit ||
      !DOCUMENT_TYPES.has(documentType) ||
      !OPAQUE.test(String(body.idempotencyKey || "")) ||
      !OPAQUE.test(String(body.sourceRef || "")) ||
      (filenameProvided && !originalFilename) ||
      (statement &&
        (!OPAQUE.test(String(body.accountId || "")) ||
          !MONTH.test(String(body.statementMonth || "")) ||
          (body.contentType !== undefined &&
            !STATEMENT_CONTENT_TYPES.has(requestedContentType)))) ||
      (!statement &&
        ((body.accountId !== undefined || body.statementMonth !== undefined) ||
          (body.contentType !== undefined && String(body.contentType) !== "application/pdf")))
    )
      return json(400, { error: "Invalid request" });
    const bucket = process.env.BOOKKEEPING_DOCUMENTS_BUCKET;
    const kmsKey = process.env.BOOKKEEPING_DOCUMENTS_KMS_KEY;
    if (!bucket || !kmsKey)
      return json(503, { error: "Document storage unavailable" });
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
      contentType: statement && body.contentType ? String(body.contentType) : "application/pdf",
      ...(statement ? { accountId: String(body.accountId), statementMonth: String(body.statementMonth) } : {}),
      ...(originalFilename ? { originalFilename } : {}),
      idempotencyKey: String(body.idempotencyKey),
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
        );
        const head = await headDocumentObject(bucket, String(stale.s3Key));
        if (head) await deleteExactDocumentObject(bucket, stale, head.VersionId);
        await removePendingDocumentClaim(client, String(stale.id), sha256, String(stale.creatorIdempotencyKey));
        prepared = await prepareDocument(client, {
          sha256,
          byteSize,
          documentType,
          contentType: statement && body.contentType ? String(body.contentType) : "application/pdf",
          ...(statement ? { accountId: String(body.accountId), statementMonth: String(body.statementMonth) } : {}),
          ...(originalFilename ? { originalFilename } : {}),
          idempotencyKey: String(body.idempotencyKey),
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
        cleanup.creatorIdempotencyKey !== body.idempotencyKey
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
        );
        prepared = await prepareDocument(client, {
          sha256,
          byteSize,
          documentType,
          contentType: statement && body.contentType ? String(body.contentType) : "application/pdf",
          ...(statement
            ? {
                accountId: String(body.accountId),
                statementMonth: String(body.statementMonth),
              }
            : {}),
          ...(originalFilename ? { originalFilename } : {}),
          idempotencyKey: String(body.idempotencyKey),
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
    const contentType =
      prepared.outcome === "retry" || prepared.outcome === "created"
        ? statement && body.contentType
          ? String(body.contentType)
          : "application/pdf"
        : String(prepared.document!.contentType || "application/pdf");
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: String(prepared.document!.s3Key),
      ContentType: contentType,
      ContentLength: byteSize,
      ChecksumSHA256: checksum,
      IfNoneMatch: "*",
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: kmsKey,
    });
    const uploadUrl = await signUrl(s3, command, {
      expiresIn: uploadSeconds,
      // The upload contract requires this header. Hoisting it into the query
      // leaves the same header unsigned and S3 rejects the actual PUT.
      unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
    });
    return json(prepared.outcome === "created" ? 201 : 200, {
      outcome: prepared.outcome,
      document: publicDocument(prepared.document!),
      uploadUrl,
      expiresIn: uploadSeconds,
      uploadHeaders: {
        "content-type": contentType,
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
    if (!body || !OPAQUE.test(String(body.idempotencyKey || "")))
      return json(400, { error: "Invalid request" });
    const document = await getRawDocument(client, cancel[1]);
    if (!document) return json(200, { outcome: "absent" });
    if (
      document.creatorIdempotencyKey !== body.idempotencyKey ||
      !["pending", "cleanup-required"].includes(String(document.status))
    )
      return json(409, { error: "Cleanup refused" });
    if (
      Date.parse(String(document.uploadAuthorizationExpiresAt || "")) >= Date.now()
    )
      return json(409, { error: "Upload lease active" });
    const bucket = bookkeepingDocumentsBucket();
    try {
      if (document.status === "pending")
        await markDocumentCleanupRequired(
          client,
          cancel[1],
          String(body.idempotencyKey),
        );
      const head = await headDocumentObject(bucket, String(document.s3Key));
      if (head) await deleteExactDocumentObject(bucket, document, head.VersionId);
      await removePendingDocumentClaim(client, cancel[1], String(document.declaredSha256), String(body.idempotencyKey));
      return json(200, { outcome: "cancelled" });
    } catch {
      await markDocumentCleanupRequired(client, cancel[1], String(body.idempotencyKey)).catch(() => undefined);
      return json(503, { error: "Cleanup required" });
    }
  }
  const complete = path.match(
    /^\/api\/bookkeeping\/documents\/([^/]+)\/complete$/,
  );
  if (complete && method === "POST") {
    const doc = await getBookkeepingItem(client, "document", complete[1]);
    if (!doc)
      return json(404, { error: "Pending document not found" });
    if (doc.status === "active") {
      const body = parse(event.body || null);
      if (
        !body ||
        doc.creatorIdempotencyKey !== body.idempotencyKey
      )
        return json(409, { error: "Completion refused" });
      if (["invoice", "receipt"].includes(String(doc.documentType)) && !doc.facts) {
        try { return json(200,{outcome:"existing",document:await extractDocumentFacts(client,complete[1])}); }
        catch { return json(503,{error:"Document stored; extraction must be retried"}); }
      }
      return json(200, { outcome: "existing", document: publicDocument(doc) });
    }
    if (doc.status !== "pending")
      return json(404, { error: "Pending document not found" });
    const body = parse(event.body || null);
    if (
      !body ||
      !OPAQUE.test(String(body.idempotencyKey || "")) ||
      doc.creatorIdempotencyKey !== body.idempotencyKey
    )
      return json(409, { error: "Completion refused" });
    const bucket = bookkeepingDocumentsBucket();
    let verified: Awaited<ReturnType<typeof verifyDocumentObject>>;
    try {
      verified = await verifyDocumentObject(bucket, await getRawDocument(client, complete[1]) || doc);
    } catch (error) {
      if ((error as Error).message === "upload-missing")
        return json(409, { error: "Upload unavailable" });
      try {
        const rawDocument = (await getRawDocument(client, complete[1]))!;
        await markDocumentCleanupRequired(
          client,
          complete[1],
          String(body.idempotencyKey),
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
        );
        return json(400, { error: "Uploaded object verification failed" });
      } catch {
        await markDocumentCleanupRequired(
          client,
          complete[1],
          String(body.idempotencyKey),
        ).catch(() => undefined);
        return json(503, { error: "Cleanup required" });
      }
    }
    if (
      verified.size !== Number(doc.declaredByteSize) ||
      verified.sha256 !== doc.declaredSha256 ||
      !verified.contentOk ||
      !verified.versionId
    ) {
      try {
        const rawDocument = (await getRawDocument(client, complete[1]))!;
        await markDocumentCleanupRequired(
          client,
          complete[1],
          String(body.idempotencyKey),
        );
        if (
          Date.parse(String(rawDocument.uploadAuthorizationExpiresAt || "")) >=
          Date.now()
        ) {
          const message = !verified.contentOk
            ? ["bank-statement", "private-account-statement"].includes(String(doc.documentType))
              ? "Bank statement uploads accept PDF or CSV files only"
              : "Evidence uploads accept PDF files only"
            : "Cleanup deferred";
          return json(message === "Cleanup deferred" ? 409 : 400, { error: message });
        }
        await deleteExactDocumentObject(bucket, rawDocument, verified.versionId);
        await removePendingDocumentClaim(
          client,
          complete[1],
          String(doc.declaredSha256),
          String(body.idempotencyKey),
        );
      } catch {
        await markDocumentCleanupRequired(
          client,
          complete[1],
          String(body.idempotencyKey),
        ).catch(() => undefined);
        return json(503, { error: "Cleanup required" });
      }
      const message = !verified.contentOk
        ? ["bank-statement", "private-account-statement"].includes(String(doc.documentType))
          ? "Bank statement uploads accept PDF or CSV files only"
          : "Evidence uploads accept PDF files only"
        : "Uploaded object verification failed";
      return json(400, { error: message });
    }
    try {
      await activateDocument(
        client,
        complete[1],
        verified.sha256,
        String(body.idempotencyKey),
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
        );
      } catch {
        await markDocumentCleanupRequired(
          client,
          complete[1],
          String(body.idempotencyKey),
        ).catch(() => undefined);
      }
      return json(503, { error: "Document activation failed" });
    }
    let active = await getBookkeepingItem(client, "document", complete[1]);
    if (["invoice", "receipt"].includes(String(active?.documentType))) {
      try { const extracted=await extractDocumentFacts(client,complete[1]); if(extracted) active={...active!,facts:extracted.facts}; }
      catch { return json(503, {error:"Document stored; extraction must be retried",document:publicDocument(active!)}); }
    }
    return json(200, { outcome: "created", document: publicDocument(active!) });
  }
  const download = path.match(
    /^\/api\/bookkeeping\/documents\/([^/]+)\/download$/,
  );
  if (download && method === "GET") {
    const doc = await getBookkeepingItem(client, "document", download[1]);
    if (!doc || doc.status !== "active")
      return json(404, { error: "Document not found" });
    // ?disposition=inline lets the browser show the verified PDF in a tab
    // ("View invoice"); the default stays a download. Both are the same
    // short-lived signed URL to the private object.
    const inline = event.queryStringParameters?.disposition === "inline";
    const filename = String(doc.originalFilename || `${doc.documentType || "document"}-${doc.id}.pdf`)
      .replace(/["\\]/g, "_");
    const downloadUrl = await signUrl(
      s3,
      new GetObjectCommand({
        Bucket: bookkeepingDocumentsBucket(),
        Key: String(doc.s3Key),
        ResponseContentDisposition: `${inline ? "inline" : "attachment"}; filename="${filename}"`,
        ...(inline && String(doc.contentType || "application/pdf") === "application/pdf"
          ? { ResponseContentType: "application/pdf" }
          : {}),
      }),
      { expiresIn: 300 },
    );
    return json(200, { downloadUrl, expiresIn: 300 });
  }
  return null;
}
