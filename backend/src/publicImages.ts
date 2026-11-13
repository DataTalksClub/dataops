import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { inflateSync } from 'zlib';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { FileStorageError, getUploadDir, isLocalFilesystemStorageAllowed } from './storage';

export const MAX_PUBLIC_IMAGE_BYTES = 4 * 1024 * 1024;
export const MIN_PUBLIC_IMAGE_DIMENSION = 1;
export const MAX_PUBLIC_IMAGE_DIMENSION = 10000;
export const MAX_PUBLIC_IMAGE_PIXELS = 40_000_000;
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

export interface ValidatedPublicImage {
  ext: 'png' | 'jpg' | 'gif' | 'webp';
  contentType: string;
  width: number;
  height: number;
}

function assertValidDimensions(width: number, height: number): void {
  if (
    !Number.isInteger(width)
    || !Number.isInteger(height)
    || width < MIN_PUBLIC_IMAGE_DIMENSION
    || height < MIN_PUBLIC_IMAGE_DIMENSION
    || width > MAX_PUBLIC_IMAGE_DIMENSION
    || height > MAX_PUBLIC_IMAGE_DIMENSION
    || width * height > MAX_PUBLIC_IMAGE_PIXELS
  ) {
    throw new FileStorageError(
      `Image dimensions (${width}x${height}) are out of bounds; must be between ${MIN_PUBLIC_IMAGE_DIMENSION}x${MIN_PUBLIC_IMAGE_DIMENSION} and ${MAX_PUBLIC_IMAGE_DIMENSION}x${MAX_PUBLIC_IMAGE_DIMENSION} pixels (max 40 megapixels).`,
      400,
      'invalid_image_dimensions',
    );
  }
}

function validatePng(data: Buffer): { width: number; height: number } {
  let offset = 8;
  let width = 0;
  let height = 0;
  let seenIhdr = false;
  let seenIend = false;
  const idatChunks: Buffer[] = [];

  while (offset < data.length) {
    if (offset + 12 > data.length) {
      throw new FileStorageError('PNG image is truncated and could not be decoded.', 400, 'undecodable_image');
    }
    const length = data.readUInt32BE(offset);
    if (length > 0x7fffffff || offset + 12 + length > data.length) {
      throw new FileStorageError('PNG image is truncated and could not be decoded.', 400, 'undecodable_image');
    }
    const type = data.subarray(offset + 4, offset + 8).toString('ascii');
    const chunkData = data.subarray(offset + 8, offset + 8 + length);

    if (!seenIhdr) {
      if (type !== 'IHDR' || length !== 13) {
        throw new FileStorageError('PNG image is missing a valid IHDR header.', 400, 'undecodable_image');
      }
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      const colorType = chunkData[9];
      const compression = chunkData[10];
      const filter = chunkData[11];
      const interlace = chunkData[12];
      if (compression !== 0 || filter !== 0 || (interlace !== 0 && interlace !== 1) || ![0, 2, 3, 4, 6].includes(colorType)) {
        throw new FileStorageError('PNG image has an invalid IHDR specification.', 400, 'undecodable_image');
      }
      seenIhdr = true;
    } else if (type === 'IDAT') {
      idatChunks.push(chunkData);
    } else if (type === 'IEND') {
      if (length !== 0) {
        throw new FileStorageError('PNG image has an invalid IEND chunk.', 400, 'undecodable_image');
      }
      seenIend = true;
      offset += 12 + length;
      break;
    }

    offset += 12 + length;
  }

  if (!seenIhdr || !seenIend || idatChunks.length === 0) {
    throw new FileStorageError('PNG image is incomplete (missing IEND or IDAT) and could not be decoded.', 400, 'undecodable_image');
  }
  assertValidDimensions(width, height);
  try {
    const decompressed = inflateSync(Buffer.concat(idatChunks));
    if (decompressed.length === 0) {
      throw new Error('empty decompressed stream');
    }
  } catch {
    throw new FileStorageError('PNG image data is truncated or corrupted and could not be decoded.', 400, 'undecodable_image');
  }
  return { width, height };
}

function validateJpeg(data: Buffer): { width: number; height: number } {
  let offset = 2;
  let width = 0;
  let height = 0;
  let seenSof = false;
  let seenSos = false;

  while (offset < data.length) {
    if (data[offset] !== 0xff) {
      throw new FileStorageError('JPEG image is corrupted and could not be decoded.', 400, 'undecodable_image');
    }
    while (offset < data.length && data[offset] === 0xff) offset++;
    if (offset >= data.length) break;
    const marker = data[offset++];
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) continue;
    if (marker === 0xd9) {
      if (!seenSof || !seenSos) {
        throw new FileStorageError('JPEG image is missing frame headers.', 400, 'undecodable_image');
      }
      assertValidDimensions(width, height);
      return { width, height };
    }
    if (offset + 2 > data.length) break;
    const segLen = data.readUInt16BE(offset);
    if (segLen < 2 || offset + segLen > data.length) {
      throw new FileStorageError('JPEG image is truncated and could not be decoded.', 400, 'undecodable_image');
    }
    const isSof = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      if (segLen < 7) {
        throw new FileStorageError('JPEG image has a malformed frame header.', 400, 'undecodable_image');
      }
      height = data.readUInt16BE(offset + 3);
      width = data.readUInt16BE(offset + 5);
      seenSof = true;
    }
    offset += segLen;
    if (marker === 0xda) {
      seenSos = true;
      // Scan for EOI marker (0xFF 0xD9) after SOS entropy-coded segment.
      let foundEoi = false;
      for (let i = data.length - 2; i >= offset; i--) {
        if (data[i] === 0xff && data[i + 1] === 0xd9) {
          foundEoi = true;
          break;
        }
      }
      if (!foundEoi || !seenSof) {
        throw new FileStorageError('JPEG image is truncated (missing EOI) and could not be decoded.', 400, 'undecodable_image');
      }
      assertValidDimensions(width, height);
      return { width, height };
    }
  }

  throw new FileStorageError('JPEG image is truncated and could not be decoded.', 400, 'undecodable_image');
}

function validateGif(data: Buffer): { width: number; height: number } {
  if (data.length < 14 || data[data.length - 1] !== 0x3b) {
    throw new FileStorageError('GIF image is truncated and could not be decoded.', 400, 'undecodable_image');
  }
  const width = data.readUInt16LE(6);
  const height = data.readUInt16LE(8);
  assertValidDimensions(width, height);
  return { width, height };
}

function validateWebp(data: Buffer): { width: number; height: number } {
  if (data.length < 20) {
    throw new FileStorageError('WebP image is truncated and could not be decoded.', 400, 'undecodable_image');
  }
  const riffSize = data.readUInt32LE(4);
  if (riffSize < 4 || data.length < 8 + riffSize) {
    throw new FileStorageError('WebP image is truncated and could not be decoded.', 400, 'undecodable_image');
  }
  const chunk = data.subarray(12, 16).toString('ascii');
  let width = 0;
  let height = 0;
  if (chunk === 'VP8X' && data.length >= 30) {
    width = 1 + (data[24] | (data[25] << 8) | (data[26] << 16));
    height = 1 + (data[27] | (data[28] << 8) | (data[29] << 16));
  } else if (chunk === 'VP8L' && data.length >= 25 && data[20] === 0x2f) {
    const b0 = data[21];
    const b1 = data[22];
    const b2 = data[23];
    const b3 = data[24];
    width = 1 + (((b1 & 0x3f) << 8) | b0);
    height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
  } else if (chunk === 'VP8 ' && data.length >= 30 && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
    width = data.readUInt16LE(26) & 0x3fff;
    height = data.readUInt16LE(28) & 0x3fff;
  } else {
    throw new FileStorageError('WebP image header could not be decoded.', 400, 'undecodable_image');
  }
  assertValidDimensions(width, height);
  return { width, height };
}

/** Fully validate image format, structural integrity/decoding, and pixel dimensions. */
export function validatePublicImage(data: Buffer): ValidatedPublicImage {
  const detected = detectPublicImageFormat(data);
  if (!detected) {
    throw new FileStorageError('Unsupported image format. Upload a PNG, JPEG, GIF, or WebP image.', 400, 'unsupported_image_format');
  }
  const dims = detected.ext === 'png'
    ? validatePng(data)
    : detected.ext === 'jpg'
      ? validateJpeg(data)
      : detected.ext === 'gif'
        ? validateGif(data)
        : validateWebp(data);
  return { ...detected, ...dims };
}

export interface StoredPublicImage {
  id: string;
  path: string;
  contentType: string;
  sizeBytes: number;
  width: number;
  height: number;
}

/** Store an immutable public image in the shared S3 bucket (or local-dev dir in tests/local dev). */
export async function savePublicImage(data: Buffer): Promise<StoredPublicImage> {
  if (!data || data.length === 0) {
    throw new FileStorageError('Image file is empty', 400, 'empty_image');
  }
  if (data.length > MAX_PUBLIC_IMAGE_BYTES) {
    throw new FileStorageError('Image exceeds the 4 MiB upload limit', 413, 'file_too_large');
  }
  const validated = validatePublicImage(data);
  const id = `${randomUUID()}.${validated.ext}`;
  const key = `${PUBLIC_IMAGE_PREFIX}/${id}`;

  if (useS3Storage()) {
    await client().send(new PutObjectCommand({
      Bucket: configuredBucket(),
      Key: key,
      Body: data,
      ContentType: validated.contentType,
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
    contentType: validated.contentType,
    sizeBytes: data.length,
    width: validated.width,
    height: validated.height,
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
