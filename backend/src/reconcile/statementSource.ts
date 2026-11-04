import { GetObjectCommand } from "@aws-sdk/client-s3";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { getRawDocument } from "../db/bookkeeping";
import { getArtifact } from "../db/artifacts";
import { s3 } from "../routes/bookkeepingShared";

async function readStatementSourceBytes(client: DynamoDBDocumentClient, source: { documentId?: string; artifactId?: string }) {
  let bucket: string | undefined, key: string, filename: string, contentType: string;
  if (source.documentId) {
    const document = await getRawDocument(client, source.documentId);
    if (!document || document.status !== "active") throw new Error("Statement document unavailable");
    if (!["bank-statement", "private-account-statement"].includes(String(document.documentType))) throw new Error("Document is not a bank statement");
    bucket = process.env.BOOKKEEPING_DOCUMENTS_BUCKET;
    key = String(document.s3Key || "");
    filename = String(document.originalFilename || "statement.pdf");
    contentType = String(document.contentType || "application/pdf");
  } else {
    const artifact = source.artifactId ? await getArtifact(client, source.artifactId) : null;
    const location = /^s3:\/\/([^/]+)\/(.+)$/.exec(artifact?.storageUri || "");
    if (!artifact || artifact.metadata?.importState !== "complete" || !location || location[1] !== process.env.EMAIL_DOCUMENTS_BUCKET) throw new Error("Statement artifact unavailable");
    bucket = location[1]; key = location[2];
    filename = String(artifact.filename || "statement.pdf"); contentType = String(artifact.contentType || "application/pdf");
  }
  if (!bucket || !key) throw new Error("Statement storage unavailable");
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!object.Body) throw new Error("Statement object is empty");
  const chunks: Buffer[] = []; let size = 0;
  for await (const part of object.Body as unknown as AsyncIterable<Uint8Array>) {
    const chunk = Buffer.from(part); size += chunk.length;
    if (size > 25 * 1024 * 1024) throw new Error("Statement exceeds size limit");
    chunks.push(chunk);
  }
  return { bytes: Buffer.concat(chunks), filename, contentType };
}

let sourceReader = readStatementSourceBytes;
export function setStatementSourceReaderForTests(reader?: typeof readStatementSourceBytes) { sourceReader = reader || readStatementSourceBytes; }
export const statementSourceBytes: typeof readStatementSourceBytes = (...args) => sourceReader(...args);
