import { createHash, randomUUID } from 'crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createArtifactIfAbsent } from '../db/artifacts';
import { extractInvoiceText, pdfText } from './extract';
import type { Invoice, InvoiceFields } from './model';
import { saveInvoice } from './store';

// Base64 plus the JSON envelope must fit the Lambda synchronous request limit.
export const MAX_INVOICE_DOCUMENT_BYTES = 4 * 1024 * 1024;
export class InvoiceDocumentError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}
let s3 = new S3Client({});
let extractText = pdfText;
export function setInvoiceDocumentForTests(value: { s3?: S3Client; extract?: typeof pdfText } = {}) {
  s3 = value.s3 || new S3Client({});
  extractText = value.extract || pdfText;
}

export function decodeInvoiceDocument(body: Record<string, unknown>): Buffer {
  if (typeof body.filename !== 'string' || body.filename.length > 255 ||
      /[\x00-\x1f\x7f/\\]/.test(body.filename) || !/\.pdf$/i.test(body.filename) ||
      body.contentType !== 'application/pdf') {
    throw new InvoiceDocumentError('A PDF filename and application/pdf contentType are required', 400);
  }
  if (body.reextract !== undefined && typeof body.reextract !== 'boolean')
    throw new InvoiceDocumentError('reextract must be a boolean', 400);
  if (typeof body.contentBase64 !== 'string' || !body.contentBase64.length)
    throw new InvoiceDocumentError('contentBase64 must contain the PDF', 400);
  if (body.contentBase64.length > Math.ceil(MAX_INVOICE_DOCUMENT_BYTES / 3) * 4)
    throw new InvoiceDocumentError('PDF exceeds the 4 MiB upload limit', 413);
  const bytes = Buffer.from(body.contentBase64, 'base64');
  if (bytes.length > MAX_INVOICE_DOCUMENT_BYTES)
    throw new InvoiceDocumentError('PDF exceeds the 4 MiB upload limit', 413);
  if (bytes.toString('base64') !== body.contentBase64 || bytes.subarray(0, 5).toString() !== '%PDF-')
    throw new InvoiceDocumentError('Document must be a PDF encoded as base64', 400);
  return bytes;
}

export async function replaceInvoiceDocument(
  client: DynamoDBDocumentClient, record: Invoice, body: Record<string, unknown>, actor: string,
): Promise<Invoice> {
  if (body.revision !== record.revision)
    throw new InvoiceDocumentError('Review changed: reload the current revision', 409);
  if (record.status !== 'pending')
    throw new InvoiceDocumentError('Only pending drafts can replace their document', 409);
  const bytes = decodeInvoiceDocument(body);
  let text: string;
  try { text = await extractText(bytes); }
  catch { throw new InvoiceDocumentError('Document must be a readable PDF', 400); }
  const bucket = process.env.EMAIL_DOCUMENTS_BUCKET;
  if (!bucket) throw new InvoiceDocumentError('EMAIL_DOCUMENTS_BUCKET is not configured', 503);
  const prefix = (process.env.EMAIL_DOCUMENT_DESTINATION_PREFIX || 'artifacts/').replace(/^\/+|\/+$/g, '');
  const artifactId = randomUUID();
  const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const key = `${prefix}/invoices/${record.id}/${artifactId}/${String(body.filename).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  // Immutable storage, in the same bucket/prefix and with the same KMS policy
  // as intake. Failed or conflicting requests never delete prior uploads.
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: bytes, ContentType: 'application/pdf',
    IfNoneMatch: '*', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: process.env.EMAIL_DOCUMENTS_KMS_KEY,
    Metadata: { sha256: checksum.slice(7) },
  }));
  const reservation = await createArtifactIfAbsent(client, {
    id: artifactId, type: 'invoice', title: body.filename, filename: body.filename,
    status: 'needs-review', storageProvider: 's3', storageUri: `s3://${bucket}/${key}`,
    contentType: 'application/pdf', checksum, sizeBytes: bytes.length,
    visibility: 'sensitive', dataClass: 'sensitive', sourceType: 'system',
    tags: ['invoice-document'],
    metadata: { importState: 'complete', documentKind: 'invoice-replacement', invoiceId: record.id, replacedArtifactId: record.source.artifactId },
  });
  if (!reservation.created) throw new Error('document-artifact-conflict');
  const next = structuredClone(record);
  next.source.artifactId = artifactId;
  next.source.checksum = checksum;
  if (body.reextract === true) {
    // New document evidence replaces old document evidence. Actual bank EUR
    // amounts, payment evidence and other operator ledger fields stay owned
    // by the operator. Old email hints must not identify the replacement.
    const parsed = extractInvoiceText(text);
    const documentFields: Array<keyof InvoiceFields> = [
      'counterparty', 'description', 'amount', 'currency', 'transactionDate', 'paidDate', 'invoiceNumber', 'vatId',
    ];
    for (const name of documentFields) {
      delete next.fields[name];
      if (parsed.fields[name] !== undefined)
        (next.fields as Record<string, unknown>)[name] = parsed.fields[name];
    }
    next.extraction = parsed.extraction;
  }
  delete next.verification;
  next.revision += 1;
  next.audit.push({
    action: 'document-replaced', actor, at: new Date().toISOString(), revision: next.revision,
    oldDocument: { artifactId: record.source.artifactId, checksum: record.source.checksum },
    newDocument: { artifactId, checksum }, reextracted: body.reextract === true,
  });
  return saveInvoice(client, next, record);
}
