/* dakit 0.2.0 e58478f */
// Dakit avatar: a person's initials, with their photo on top when there is one.
//
// ES module, no globals:
//   import { createAvatar, updateAvatar, avatarInitials } from "dakit/dist/avatar.js";
//
//   createAvatar({ name: "Orin Vale", src, size: "xs" })   → <span class="dk-avatar dk-avatar--xs">
//   updateAvatar(element, { name, src }, document?)        re-point an existing .dk-avatar
//
// The initials are always rendered. The photo is an <img> laid over them, so
// while it loads, when there is none, and after it fails to load, the avatar
// still reads as the person. A failed photo is removed, not left as a broken
// image. The photo is requested with no referrer: photo hosts such as Google's
// may refuse hotlinked requests that carry one, and the page URL is nobody
// else's business.
//
// The avatar is decorative (aria-hidden): the caller puts the name next to
// it or on the owning element's accessible label.

const SIZES = new Set(["xs", "sm", "lg"]);

// One person, up to two letters: the first letter of the first two words,
// uppercased; "?" for an empty name.
export function avatarInitials(name) {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts.slice(0, 2).map((part) => [...part][0]).join("").toUpperCase();
}

// Only an absolute https URL becomes an <img>; anything else (empty, relative,
// http, data:, javascript:) leaves the initials alone.
function photoUrl(src) {
  if (!src) return "";
  try {
    const url = new URL(String(src));
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

// The document defaults to the element's own; pass it for detached or test
// documents. Re-pointing to the same photo keeps the loaded <img>.
export function updateAvatar(element, { name = "", initials, src = "" } = {}, doc = element.ownerDocument) {
  const href = photoUrl(src);
  const label = doc.createElement("span");
  label.className = "dk-avatar__initials";
  label.textContent = initials || avatarInitials(name);
  const current = element.querySelector("img");
  const img = href && current?.getAttribute("src") === href ? current : href ? photo(doc, element, href) : null;
  element.replaceChildren(...(img ? [label, img] : [label]));
  element.setAttribute("aria-hidden", "true");
  element.classList.toggle("dk-avatar--photo", Boolean(img));
  if (img) element.dataset.avatarPhoto = "shown";
  else delete element.dataset.avatarPhoto;
  return element;
}

function photo(doc, element, href) {
  const img = doc.createElement("img");
  img.alt = "";
  img.decoding = "async";
  img.setAttribute("referrerpolicy", "no-referrer");
  img.addEventListener("error", () => {
    img.remove();
    element.classList.remove("dk-avatar--photo");
    element.dataset.avatarPhoto = "failed";
  }, { once: true });
  img.setAttribute("src", href);
  return img;
}

export function createAvatar({ document: doc = globalThis.document, name = "", initials, src = "", size = "", className = "" } = {}) {
  const element = doc.createElement("span");
  element.className = ["dk-avatar", SIZES.has(size) ? `dk-avatar--${size}` : "", className].filter(Boolean).join(" ");
  return updateAvatar(element, { name, initials, src }, doc);
}
