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
  verifyPdfObject,
} from "./bookkeepingShared";

const SHA256 = /^[a-f0-9]{64}$/;
const OPAQUE = /^[a-zA-Z0-9._:-]{1,160}$/;
const DOCUMENT_TYPES = new Set([
  "invoice",
  "receipt",
  "bank-statement",
  "private-account-statement",
  "other-evidence",
]);

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
          ...(statement ? { accountId: String(body.accountId), statementMonth: String(body.statementMonth) } : {}),
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
          ...(statement
            ? {
                accountId: String(body.accountId),
                statementMonth: String(body.statementMonth),
              }
            : {}),
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
    const bucket = process.env.BOOKKEEPING_DOCUMENTS_BUCKET || "";
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
    if (doc.status === "active" && doc.declaredSha256) {
      const body = parse(event.body || null);
      if (
        !body ||
        doc.creatorIdempotencyKey !== body.idempotencyKey
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
          doc.creatorIdempotencyKey !== body.idempotencyKey
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
        !verified.pdf ||
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
          )
            return json(409, { error: "Cleanup deferred" });
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
        return json(400, { error: "Uploaded object verification failed" });
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
  return null;
}
