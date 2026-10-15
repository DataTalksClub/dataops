// Person-facing rendering for the work surfaces. Every surface that shows a
// teammate — the account menu, the queue's WHO column, card task owners, the
// Users page — builds its avatar here, so letters and photos cannot drift.
import { avatarInitials, createAvatar, updateAvatar } from "../dakit/avatar.js";

// One person, up to two letters ("?" for an empty name).
export const personInitials = avatarInitials;

// Google profile photos take a size suffix (`=s96-c`): ask for 64px, cropped,
// which is sharp at every avatar size up to 32px on a 2x screen and keeps one
// cached URL per person. Any other host is left to dakit, which only loads
// https URLs.
const PHOTO_SIZE = "=s64-c";

export function personPhotoUrl(picture) {
  if (!picture) return "";
  try {
    const url = new URL(String(picture));
    if (url.protocol !== "https:" || !url.hostname.endsWith(".googleusercontent.com")) return "";
    // Current photos end in `=s96-c`; legacy ones carry a `/s96-c/` segment.
    if (/\/s\d+(-c)?\/[^/]+$/.test(url.pathname)) url.pathname = url.pathname.replace(/\/s\d+(-c)?\/([^/]+)$/, "/s64-c/$2");
    else url.pathname = url.pathname.replace(/=[^/=]*$/, "") + PHOTO_SIZE;
    return url.href;
  } catch {
    return "";
  }
}

// A decorative `.dk-avatar` for one person: initials, plus their SSO photo
// when the person has signed in and it loads. `person` is a user record or a
// name string.
export function personAvatar(person, { document: doc = globalThis.document, size = "", className = "" } = {}) {
  const { name, picture } = typeof person === "string" ? { name: person } : person || {};
  return createAvatar({ document: doc, name, src: personPhotoUrl(picture), size, className });
}

// Re-point an avatar that already sits in the page (e.g. the account trigger).
export function updatePersonAvatar(element, person, doc = element.ownerDocument) {
  const { name, picture } = typeof person === "string" ? { name: person } : person || {};
  return updateAvatar(element, { name, src: personPhotoUrl(picture) }, doc);
}
