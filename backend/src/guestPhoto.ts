/**
 * The guest photo rule: event pictures show the speaker portrait large, so a
 * guest photo must be at least 800 px on its shorter side, in JPG, PNG or WebP.
 *
 * Applied wherever DataOps takes a guest photo it can read: the guest form's
 * photo upload, a guest form save that points the photo at a hosted image,
 * and a People register photo that points at a hosted image. A photo linked
 * from another site cannot be measured here; the form asks for the size up
 * front instead.
 */
import { readPublicImage, validatePublicImage, type ValidatedPublicImage } from './publicImages';
import { FileStorageError } from './storage';

export const MIN_GUEST_PHOTO_SIDE = 800;

export const GUEST_PHOTO_REQUIREMENT =
  'At least 800 × 800 pixels (a square headshot works best), one face, no text or logos. JPG, PNG or WebP.';

export const GUEST_PHOTO_TOO_SMALL_MESSAGE =
  'Thanks! The photo is a bit too small for our event picture. Could you upload a larger one, at least 800 × 800 pixels? A square headshot works best.';

export const GUEST_PHOTO_FORMAT_MESSAGE =
  'Please upload the photo as a JPG, PNG or WebP file, at least 800 × 800 pixels. A square headshot works best.';

export class GuestPhotoError extends FileStorageError {
  constructor(message: string, code: 'guest_photo_too_small' | 'guest_photo_format' | 'guest_photo_missing') {
    super(message, 400, code);
  }
}

/** Reject a decoded image that cannot serve as an event picture portrait. */
export function assertGuestPhoto(image: Pick<ValidatedPublicImage, 'ext' | 'width' | 'height'>): void {
  if (image.ext === 'gif') throw new GuestPhotoError(GUEST_PHOTO_FORMAT_MESSAGE, 'guest_photo_format');
  if (Math.min(image.width, image.height) < MIN_GUEST_PHOTO_SIDE) {
    throw new GuestPhotoError(
      `${GUEST_PHOTO_TOO_SMALL_MESSAGE} (This one is ${image.width} × ${image.height}.)`,
      'guest_photo_too_small',
    );
  }
}

/** Decode uploaded bytes and apply the guest photo rule. */
export function assertGuestPhotoBytes(data: Buffer): ValidatedPublicImage {
  const image = validatePublicImage(data);
  assertGuestPhoto(image);
  return image;
}

/** The public image id when `url` points at DataOps public image hosting, else null. */
export function hostedPublicImageId(url: string): string | null {
  const value = String(url || '').trim();
  if (!value) return null;
  let pathname = value;
  try {
    pathname = new URL(value, 'https://dataops.invalid').pathname;
  } catch {
    return null;
  }
  const match = /^\/api\/public-images\/([^/]+)\/?$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Apply the guest photo rule to a photo URL when DataOps hosts the image.
 * Photos linked from elsewhere are left to the operator's review.
 */
export async function assertHostedGuestPhoto(url: string | null | undefined): Promise<void> {
  const id = hostedPublicImageId(url || '');
  if (!id) return;
  let data: Buffer;
  try {
    ({ data } = await readPublicImage(id));
  } catch (error) {
    if (error instanceof FileStorageError && (error.code === 'image_not_found' || error.code === 'invalid_image_id')) {
      throw new GuestPhotoError('That photo could not be found. Please upload it again.', 'guest_photo_missing');
    }
    throw error;
  }
  assertGuestPhotoBytes(data);
}
