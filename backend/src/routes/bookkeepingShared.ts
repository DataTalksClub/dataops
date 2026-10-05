import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "crypto";
import { Upload } from "@aws-sdk/lib-storage";
import type { LambdaResponse } from "../types";

export const json = (statusCode: number, body: unknown): LambdaResponse => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
export const MONTH = /^\d{4}-\d{2}$/;
export const MONEY = /^(0|[1-9]\d{0,11})(\.\d{1,4})?$/;
export let s3 = new S3Client({});
export let signUrl = getSignedUrl;
type ArchiveUploadResult = { VersionId?: string } | void;
export let uploadStream: (
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

export function parse(body: string | null): Record<string, unknown> | null {
  try {
    return body ? JSON.parse(body) : null;
  } catch {
    return null;
  }
}

export function publicDocument(document: Record<string, unknown>) {
  const {
    PK: _pk,
    SK: _sk,
    s3Key: _key,
    objectVersionId: _version,
    creatorIdempotencyKey: _owner,
    declaredSha256: _declaredHash,
    sha256: _verifiedHash,
    sourceRef: _source,
    ...safe
  } = document;
  return safe;
}

export function publicLink(link: Record<string, unknown>) {
  const { sourceRef: _source, ...safe } = link;
  return safe;
}

export async function verifyPdfObject(bucket: string, document: Record<string, unknown>) {
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

export async function deleteExactDocumentObject(
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

export async function headDocumentObject(bucket: string, key: string) {
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
