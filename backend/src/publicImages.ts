import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { FileStorageError, getUploadDir, isLocalFilesystemStorageAllowed } from './storage';

export const MAX_PUBLIC_IMAGE_BYTES = 4 * 1024 * 1024;
export const PUBLIC_IMAGE_PREFIX = 'public-images';

const PUBLIC_IMAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

let s3: Pick<S3Client, 'send'> | undefined;
export function setPublicImageStorageClientForTests(value?: Pick<S3Client, 'send'>): void {
  s3 = value;
}
function client(): Pick<S3Client, 'send'> {
  return (s3 ||= new S3Client({}));
}

function configuredBucket(): string {
  const value = process.env.TASK_FILES_BUCKET?.trim();
  if (!value) throw new FileStorageError('TASK_FILES_BUCKET is not configured', 503, 'file_storage_unavailable');
  return value;
}

function useS3Storage(): boolean {
  const provider = process.env.DATAOPS_FILE_STORAGE_PROVIDER;
  if (provider && provider !== 's3' && provider !== 'local-dev') {
    throw new FileStorageError('Unsupported DATAOPS_FILE_STORAGE_PROVIDER', 503, 'file_storage_unavailable');
  }
  return provider === 's3' || Boolean(process.env.TASK_FILES_BUCKET?.trim());
}

/** Sniff magic bytes so only real raster images (PNG, JPEG, GIF, WebP) are stored and served publicly. */
export function detectPublicImageFormat(data: Buffer): { ext: 'png' | 'jpg' | 'gif' | 'webp'; contentType: string } | null {
  if (data.length >= 8
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) {
    return { ext: 'png', contentType: 'image/png' };
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { ext: 'jpg', contentType: 'image/jpeg' };
  }
  if (data.length >= 6) {
    const sig = data.subarray(0, 6).toString('ascii');
    if (sig === 'GIF87a' || sig === 'GIF89a') {
      return { ext: 'gif', contentType: 'image/gif' };
    }
  }
  if (data.length >= 12
    && data.subarray(0, 4).toString('ascii') === 'RIFF'
    && data.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { ext: 'webp', contentType: 'image/webp' };
  }
  return null;
}

export function validatePublicImageId(rawId: string): { id: string; key: string; contentType: string } {
  const id = String(rawId || '').trim().toLowerCase();
  const match = PUBLIC_IMAGE_ID_RE.exec(id);
  if (!match) {
    throw new FileStorageError('Invalid public image id', 400, 'invalid_image_id');
  }
  return {
    id,
    key: `${PUBLIC_IMAGE_PREFIX}/${id}`,
    contentType: CONTENT_TYPE_BY_EXT[match[1]],
  };
}

function localImagePath(key: string): string {
  const root = path.resolve(getUploadDir());
  const target = path.resolve(root, key);
  if (!target.startsWith(root + path.sep)) {
    throw new FileStorageError('Invalid public image path', 400, 'invalid_file_path');
  }
  return target;
}

export interface StoredPublicImage {
  id: string;
  path: string;
  contentType: string;
  sizeBytes: number;
}

/** Store an immutable public image in the shared S3 bucket (or local-dev dir in tests/local dev). */
export async function savePublicImage(data: Buffer): Promise<StoredPublicImage> {
  if (!data || data.length === 0) {
    throw new FileStorageError('Image file is empty', 400, 'empty_image');
  }
  if (data.length > MAX_PUBLIC_IMAGE_BYTES) {
    throw new FileStorageError('Image exceeds the 4 MiB upload limit', 413, 'file_too_large');
  }
  const detected = detectPublicImageFormat(data);
  if (!detected) {
    throw new FileStorageError('Unsupported image format. Upload a PNG, JPEG, GIF, or WebP image.', 400, 'unsupported_image_format');
  }
  const id = `${randomUUID()}.${detected.ext}`;
  const key = `${PUBLIC_IMAGE_PREFIX}/${id}`;

  if (useS3Storage()) {
    await client().send(new PutObjectCommand({
      Bucket: configuredBucket(),
      Key: key,
      Body: data,
      ContentType: detected.contentType,
      CacheControl: 'public, max-age=31536000, immutable',
      IfNoneMatch: '*',
    }));
  } else {
    if (!isLocalFilesystemStorageAllowed()) {
      throw new FileStorageError('TASK_FILES_BUCKET is not configured; local filesystem file storage is disabled', 503, 'file_storage_unavailable');
    }
    const target = localImagePath(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data, { flag: 'wx' });
  }

  return {
    id,
    path: `/api/public-images/${id}`,
    contentType: detected.contentType,
    sizeBytes: data.length,
  };
}

/** Read a public image by id from the shared S3 bucket or local-dev storage. */
export async function readPublicImage(rawId: string): Promise<{ data: Buffer; contentType: string }> {
  const { key, contentType } = validatePublicImageId(rawId);
  if (useS3Storage()) {
    try {
      const result = await client().send(new GetObjectCommand({ Bucket: configuredBucket(), Key: key }));
      if (!result.Body) throw new FileStorageError('Stored image has no content', 404, 'image_not_found');
      return {
        data: Buffer.from(await result.Body.transformToByteArray()),
        contentType: result.ContentType || contentType,
      };
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') {
        throw new FileStorageError('Image not found', 404, 'image_not_found');
      }
      throw error;
    }
  }
  if (!isLocalFilesystemStorageAllowed()) {
    throw new FileStorageError('File storage provider is unavailable', 409, 'file_storage_unavailable');
  }
  try {
    return { data: await fs.readFile(localImagePath(key)), contentType };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new FileStorageError('Image not found', 404, 'image_not_found');
    }
    throw error;
  }
}

/** Delete a public image by id (used for cleanup). */
export async function removePublicImage(rawId: string): Promise<void> {
  const { key } = validatePublicImageId(rawId);
  if (useS3Storage()) {
    await client().send(new DeleteObjectCommand({ Bucket: configuredBucket(), Key: key }));
    return;
  }
  if (!isLocalFilesystemStorageAllowed()) {
    throw new FileStorageError('File storage provider is unavailable', 409, 'file_storage_unavailable');
  }
  await fs.rm(localImagePath(key), { force: true });
}
