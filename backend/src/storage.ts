import fs from 'fs/promises';
import path from 'path';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { FileRecord } from './types';

export const MAX_TASK_FILE_BYTES = 4 * 1024 * 1024;
export const DOWNLOAD_URL_SECONDS = 300;
type FileLocation = Pick<FileRecord, 'storagePath' | 'storageProvider' | 'storageUri'>;
export type StoredFile = FileLocation & { storageProvider: 's3' | 'local-dev'; storageUri: string };
let s3: Pick<S3Client, 'send'> | undefined;

export class FileStorageError extends Error {
  constructor(message: string, readonly statusCode: number, readonly code: string) { super(message); }
}

export function setFileStorageClientForTests(value?: Pick<S3Client, 'send'>): void { s3 = value; }
function client(): Pick<S3Client, 'send'> { return s3 ||= new S3Client({}); }
export function getUploadDir(): string { return process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads'); }

export function isLocalFilesystemStorageAllowed(): boolean {
  if (process.env.NODE_ENV === 'production' || process.env.AWS_LAMBDA_FUNCTION_NAME) return false;
  return process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'local'
    || process.env.IS_LOCAL === 'true' || process.env.IS_LOCAL === '1'
    || process.env.DATAOPS_FILE_STORAGE_PROVIDER === 'local-dev';
}

function bucket(): string {
  const value = process.env.TASK_FILES_BUCKET?.trim();
  if (!value) throw new FileStorageError('TASK_FILES_BUCKET is not configured', 503, 'file_storage_unavailable');
  return value;
}

function localPath(key: string): string {
  const root = path.resolve(getUploadDir());
  const target = path.resolve(root, key);
  if (!key || path.isAbsolute(key) || target === root || !target.startsWith(root + path.sep)) {
    throw new FileStorageError('Invalid file storage path', 400, 'invalid_file_path');
  }
  return target;
}

export function validateFilename(filename: string): void {
  if (!filename.trim() || filename.length > 255 || /[\x00-\x1f\x7f/\\]/.test(filename) || filename === '.' || filename === '..') {
    throw new FileStorageError('Filename must be a plain filename without path separators or control characters', 400, 'invalid_filename');
  }
}

function s3Key(file: FileLocation): string {
  const key = file.storagePath;
  if (!key.startsWith('tasks/') || key.split('/').some(part => !part || part === '.' || part === '..')
      || file.storageUri !== `s3://${bucket()}/${key}`) {
    throw new FileStorageError('File does not belong to the configured task storage', 409, 'file_storage_mismatch');
  }
  return key;
}

export async function saveFile(taskId: string, filename: string, data: Buffer, contentType: string): Promise<StoredFile> {
  validateFilename(filename);
  if (data.length > MAX_TASK_FILE_BYTES) throw new FileStorageError('File exceeds the 4 MiB upload limit', 413, 'file_too_large');
  // Every upload is immutable: another proof with the same name cannot replace this one.
  const key = `tasks/${encodeURIComponent(taskId)}/${randomUUID()}/${encodeURIComponent(filename)}`;
  const provider = process.env.DATAOPS_FILE_STORAGE_PROVIDER;
  if (provider && provider !== 's3' && provider !== 'local-dev') {
    throw new FileStorageError('Unsupported DATAOPS_FILE_STORAGE_PROVIDER', 503, 'file_storage_unavailable');
  }
  if (provider === 's3' || process.env.TASK_FILES_BUCKET) {
    const name = bucket();
    await client().send(new PutObjectCommand({ Bucket: name, Key: key, Body: data, ContentType: contentType, IfNoneMatch: '*' }));
    return { storageProvider: 's3', storagePath: key, storageUri: `s3://${name}/${key}` };
  }
  if (!isLocalFilesystemStorageAllowed()) throw new FileStorageError('TASK_FILES_BUCKET is not configured; local filesystem file storage is disabled', 503, 'file_storage_unavailable');
  const target = localPath(key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data, { flag: 'wx' });
  return { storageProvider: 'local-dev', storagePath: key, storageUri: `local-dev://${key}` };
}

export async function readFile(file: FileLocation): Promise<Buffer> {
  if (file.storageProvider === 's3') {
    try {
      const result = await client().send(new GetObjectCommand({ Bucket: bucket(), Key: s3Key(file) }));
      if (!result.Body) throw new FileStorageError('Stored file has no content', 404, 'file_not_found');
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') throw new FileStorageError('Stored file not found', 404, 'file_not_found');
      throw error;
    }
  }
  if (file.storageProvider !== 'local-dev' || !isLocalFilesystemStorageAllowed()) throw new FileStorageError('File storage provider is unavailable', 409, 'file_storage_unavailable');
  try { return await fs.readFile(localPath(file.storagePath)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new FileStorageError('Stored file not found', 404, 'file_not_found');
    throw error;
  }
}

export async function removeFile(file: FileLocation): Promise<void> {
  if (file.storageProvider === 's3') {
    await client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: s3Key(file) }));
    return;
  }
  if (file.storageProvider !== 'local-dev' || !isLocalFilesystemStorageAllowed()) throw new FileStorageError('File storage provider is unavailable', 409, 'file_storage_unavailable');
  await fs.rm(localPath(file.storagePath), { force: true });
}

/**
 * Determine MIME type from filename extension.
 */
export function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.csv': 'text/csv',
    '.xml': 'application/xml',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

/** RFC 5987 encoding for a filename in a Content-Disposition header value. */
export function encodeFilename(filename: string): string {
  return encodeURIComponent(filename).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function contentDispositionFor(filename: string): string {
  return `attachment; filename="download"; filename*=UTF-8''${encodeFilename(filename)}`;
}

export interface FileDownloadAuthorization {
  /** Absolute https (S3) or API-relative (local-dev) URL for the object. */
  url: string;
  expiresIn: number;
}

type DownloadSigner = (
  client: Pick<S3Client, 'send'>,
  command: GetObjectCommand,
  options: { expiresIn: number },
) => Promise<string>;
let signDownloadUrl: DownloadSigner = getSignedUrl as unknown as DownloadSigner;
export function setFileDownloadSignerForTests(value?: DownloadSigner): void { signDownloadUrl = value ?? (getSignedUrl as unknown as DownloadSigner); }

// Local-dev delivery links are signed with a per-process key: only the server
// process that minted a link accepts it, and no secret reaches deployment or
// infrastructure. Production never takes this path (local-dev storage is
// disabled there).
let localDownloadKey: Buffer | undefined;
function localKey(): Buffer { return localDownloadKey ||= randomBytes(32); }
export function setLocalDownloadKeyForTests(value?: Buffer): void { localDownloadKey = value; }

function localDownloadMac(fileId: string, expires: number): string {
  return createHmac('sha256', localKey()).update(`${fileId}:${expires}`).digest('hex');
}

export function localDownloadUrl(fileId: string, atMs: number = Date.now()): string {
  const expires = Math.floor(atMs / 1000) + DOWNLOAD_URL_SECONDS;
  return `/api/files/${encodeURIComponent(fileId)}/content?expires=${expires}&mac=${localDownloadMac(fileId, expires)}`;
}

export function verifyLocalDownloadLink(fileId: string, expires: unknown, mac: unknown): boolean {
  const seconds = Number(expires);
  if (!Number.isSafeInteger(seconds) || seconds * 1000 <= Date.now() || typeof mac !== 'string') return false;
  const expected = Buffer.from(localDownloadMac(fileId, seconds), 'hex');
  const provided = Buffer.from(mac, 'hex');
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

/**
 * Authorize one download of a stored file without moving its bytes through
 * the Lambda: S3 objects get a short-lived presigned GET; local-dev objects
 * (test/offline only) get a signed link to the scoped content route. Callers
 * must have authorized the download already; this never persists the link.
 */
export async function createFileDownloadAuthorization(file: FileRecord): Promise<FileDownloadAuthorization> {
  if (file.storageProvider === 's3') {
    const url = await signDownloadUrl(client(), new GetObjectCommand({
      Bucket: bucket(),
      Key: s3Key(file),
      ResponseContentType: file.contentType || getMimeType(file.filename),
      ResponseContentDisposition: contentDispositionFor(file.filename),
    }), { expiresIn: DOWNLOAD_URL_SECONDS });
    return { url, expiresIn: DOWNLOAD_URL_SECONDS };
  }
  if (file.storageProvider !== 'local-dev' || !isLocalFilesystemStorageAllowed()) {
    throw new FileStorageError('File storage provider is unavailable', 409, 'file_storage_unavailable');
  }
  return { url: localDownloadUrl(file.id), expiresIn: DOWNLOAD_URL_SECONDS };
}
