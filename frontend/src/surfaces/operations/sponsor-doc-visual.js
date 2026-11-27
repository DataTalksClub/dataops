import { isLoadableImageSrc, mountInlineImageWithFallback } from "./sponsor-doc-email-card.js";

const MAX_BRIEF_IMAGE_BYTES = 4 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 30000;
const ALLOWED_IMAGE_TYPES = /^image\/(?:png|jpe?g|gif|webp)$/i;
const ALLOWED_IMAGE_EXT = /\.(?:png|jpe?g|gif|webp)$/i;
const ALLOWED_PHOTO_TYPES = /^image\/(?:png|jpe?g|webp)$/i;
const ALLOWED_PHOTO_EXT = /\.(?:png|jpe?g|webp)$/i;
/** The guest photo rule the server enforces; shown before the guest picks a file. */
export const GUEST_PHOTO_UPLOAD_HINT = "JPG, PNG or WebP, at least 800 × 800 px. A square headshot works best.";

/** Fields rendered as an image (preview + Upload/Replace), never as a raw URL text box. */
export function isImageOnlyVisualField(fieldDef) {
  return fieldDef?.key === "graphicsUrl";
}

/** A visible reason the file cannot be uploaded, or "" when it is fine. */
export function briefImageFileError(file, { photo = false } = {}) {
  const type = String(file?.type || "");
  const name = String(file?.name || "");
  const typeOk = photo
    ? (type ? ALLOWED_PHOTO_TYPES.test(type) : ALLOWED_PHOTO_EXT.test(name))
    : (type ? ALLOWED_IMAGE_TYPES.test(type) : ALLOWED_IMAGE_EXT.test(name));
  if (!typeOk) {
    return photo
      ? `"${name || "This file"}" is ${type || "not an image"}. Upload the photo as a JPG, PNG or WebP image.`
      : `"${name || "This file"}" is ${type || "not an image"}. Upload a PNG, JPG, WebP, or GIF image.`;
  }
  if (typeof file?.size === "number" && file.size > MAX_BRIEF_IMAGE_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    return `"${name || "This image"}" is ${mb} MiB, over the 4 MiB limit. Upload a smaller image.`;
  }
  return "";
}

function withUploadTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Upload timed out after ${Math.round(ms / 1000)} s. Check your connection and try again.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Mount visual upload controls and inline image preview (with visible error
 * fallback on broken/unresolvable images) for brief visual/photo fields.
 */
export function mountSponsorDocVisualControls({
  el,
  actionBtn,
  fieldWrap,
  fieldDef,
  control,
  docId,
  accessCode,
  request,
  busy,
  draftContent,
  fieldErrors,
  getUploadedVisualName,
  setUploadedVisualName,
  updateCount,
  updateLivePreview,
  announce,
}) {
  const visualControls = el("div", "sponsor-doc-visual-upload");
  visualControls.dataset.sponsorVisualControls = fieldDef.key;

  const isPhotoField = fieldDef.key === "photoUrl";
  const imageOnly = isImageOnlyVisualField(fieldDef);
  const fileInputId = `sponsor-visual-file-${fieldDef.key}`;
  const uploadClass = "dk-button dk-button--secondary dk-button--sm sponsor-doc-visual-upload__label";
  const uploadLabel = el("label", uploadClass, isPhotoField ? "Upload photo" : "Upload visual");
  uploadLabel.setAttribute("for", fileInputId);
  uploadLabel.dataset.sponsorVisualUploadLabel = fieldDef.key;

  const fileInput = el("input", "sponsor-doc-visual-upload__input");
  fileInput.type = "file";
  fileInput.id = fileInputId;
  fileInput.accept = isPhotoField ? "image/png,image/jpeg,image/webp" : "image/png,image/jpeg,image/gif,image/webp";
  fileInput.dataset.sponsorVisualUpload = fieldDef.key;
  fileInput.disabled = busy;

  const statusSpan = el("span", "sponsor-doc-visual-upload__status");
  statusSpan.dataset.sponsorVisualStatus = "";

  const visualPreview = el("div", imageOnly
    ? "sponsor-doc-visual-preview sponsor-doc-visual-dropzone"
    : "sponsor-doc-visual-preview");
  visualPreview.dataset.sponsorVisualPreview = fieldDef.key;

  // Image-only fields keep upload errors in their own slot, so a failed
  // replace never hides the image that is still saved.
  const errorSlot = el("div", "sponsor-doc-visual-error-slot");
  errorSlot.dataset.sponsorVisualErrorSlot = fieldDef.key;

  function reportClientUploadAlert(status, message) {
    if (typeof fetch !== "function") return;
    const page = typeof window !== "undefined" && window.location ? window.location.pathname : "";
    try {
      Promise.resolve(fetch("/api/client-errors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          surface: "sponsor-doc-visual",
          check: `image-upload:${fieldDef.key}`,
          status,
          message,
          page,
        }),
      })).catch(() => {});
    } catch {
      // ignore non-browser test environments
    }
  }

  function clearUploadError() {
    errorSlot.replaceChildren();
    if (fieldErrors[fieldDef.key]) {
      delete fieldErrors[fieldDef.key];
      control.removeAttribute("aria-invalid");
      fieldWrap.querySelector(`[data-sponsor-field-error="${fieldDef.key}"]`)?.remove?.();
    }
  }

  function showVisualError(message) {
    fieldErrors[fieldDef.key] = message;
    control.setAttribute("aria-invalid", "true");
    const errBox = el("div", "sponsor-doc-visual-error", message);
    errBox.setAttribute("role", "alert");
    errBox.dataset.sponsorVisualError = fieldDef.key;
    if (imageOnly) {
      errorSlot.replaceChildren(errBox);
      return;
    }
    visualPreview.hidden = false;
    visualPreview.replaceChildren(errBox);
  }

  function renderInlineVisualPreview(rawVal) {
    const v = String(rawVal || "").trim();
    visualPreview.replaceChildren();
    // In the editor an uploaded image is a small thumbnail next to Replace/Remove;
    // the email preview and the delivered image keep their full width.
    if (imageOnly) visualPreview.classList.toggle("is-thumbnail", Boolean(v) && isLoadableImageSrc(v));
    if (!v) {
      if (isPhotoField || imageOnly) {
        visualPreview.hidden = false;
        const placeholder = el("p", "dk-hint sponsor-doc-photo-placeholder", imageOnly
          ? "No image yet. Drag one here or upload it."
          : "No photo yet — upload a portrait at least 800 × 800 px, or paste a link to one, to see a preview.");
        placeholder.dataset.sponsorPhotoPlaceholder = "";
        visualPreview.append(placeholder);
      } else {
        visualPreview.hidden = true;
      }
      return;
    }
    visualPreview.hidden = false;
    if (isLoadableImageSrc(v)) {
      mountInlineImageWithFallback({
        el,
        container: visualPreview,
        src: v,
        alt: fieldDef.label || "Brief visual",
        imgClass: "sponsor-doc-visual-preview__img",
        imgDatasetKey: "sponsorVisualImage",
        imgDatasetValue: fieldDef.key,
        errorDatasetKey: "sponsorVisualError",
        errorDatasetValue: fieldDef.key,
      });
    } else if (imageOnly) {
      const errBox = el("div", "sponsor-doc-visual-error",
        `The saved value "${v}" is not an image. Upload the image to replace it.`);
      errBox.setAttribute("role", "alert");
      errBox.dataset.sponsorVisualError = fieldDef.key;
      visualPreview.append(errBox);
    } else {
      showVisualError(
        `Image cannot be displayed: "${v}" is a filename, not a hosted image URL. Upload the image or paste a full https:// URL.`,
      );
    }
  }

  const removeLabel = isPhotoField ? "Remove photo" : imageOnly ? "Remove" : "Remove visual";
  const clearBtn = actionBtn("dk-button dk-button--secondary dk-button--sm", removeLabel, "clear-visual", () => {
    setUploadedVisualName("");
    draftContent[fieldDef.key] = "";
    control.value = "";
    control.placeholder = fieldDef.placeholder || "";
    fileInput.value = "";
    clearUploadError();
    updateCount("");
    syncVisualControls();
    renderInlineVisualPreview("");
    updateLivePreview();
  });

  function syncVisualControls() {
    const v = String(draftContent[fieldDef.key] || "").trim();
    const name = getUploadedVisualName();
    if (imageOnly) {
      uploadLabel.textContent = v ? "Replace" : "Upload image";
      statusSpan.textContent = name ? `Uploaded ${name}.` : "";
      clearBtn.hidden = !v;
      return;
    }
    if (/^data:image\//i.test(v)) {
      statusSpan.textContent = name ? `Uploaded visual: ${name}` : "Uploaded visual attached";
      clearBtn.hidden = false;
    } else if (v) {
      statusSpan.textContent = name ? `Uploaded visual: ${name}` : "Using linked image URL";
      clearBtn.hidden = false;
    } else {
      statusSpan.textContent = isPhotoField ? GUEST_PHOTO_UPLOAD_HINT : "Upload PNG, JPG, WebP, or GIF to preview right away";
      clearBtn.hidden = true;
    }
  }

  async function uploadFile(file) {
    if (!file) return;
    const invalid = briefImageFileError(file, { photo: isPhotoField });
    if (invalid) {
      showVisualError(invalid);
      statusSpan.textContent = "";
      announce(invalid);
      reportClientUploadAlert(/limit/.test(invalid) ? 413 : 415, invalid);
      fileInput.value = "";
      return;
    }
    statusSpan.textContent = "Uploading image…";
    fileInput.disabled = true;
    visualPreview.dataset.uploading = "true";
    try {
      const formData = typeof FormData === "function" ? new FormData() : null;
      if (formData) {
        if (typeof Blob === "function" && !(file instanceof Blob) && typeof file.arrayBuffer === "function") {
          const buf = await file.arrayBuffer();
          formData.append("file", new Blob([buf], { type: file.type || "image/png" }), file.name || "upload.png");
        } else {
          formData.append("file", file, file.name || "upload.png");
        }
      }
      const headers = accessCode ? { "x-sponsor-doc-code": accessCode } : {};
      // The photo field asks the server to hold the upload to the guest photo rule.
      const uploadPath = `/api/sponsor-docs/${encodeURIComponent(docId)}/images${isPhotoField ? "?field=photoUrl" : ""}`;
      const payload = await withUploadTimeout(request(uploadPath, {
        method: "POST",
        headers,
        body: formData || file,
      }), UPLOAD_TIMEOUT_MS);
      const hostedUrl = payload?.image?.url || payload?.image?.path || "";
      if (!hostedUrl) throw new Error("Upload did not return an image URL.");
      const name = file.name || "uploaded-visual.png";
      setUploadedVisualName(name);
      draftContent[fieldDef.key] = hostedUrl;
      control.value = hostedUrl;
      control.placeholder = fieldDef.placeholder || "";
      clearUploadError();
      updateCount(hostedUrl);
      syncVisualControls();
      renderInlineVisualPreview(hostedUrl);
      updateLivePreview();
      announce(`Uploaded visual ${name} for live preview.`);
    } catch (err) {
      // A photo the guest needs to replace is a request to them, not an upload failure.
      const guestPhotoRule = /^guest_photo_/.test(String(err?.code || ""));
      const msg = guestPhotoRule && err?.message
        ? err.message
        : `Image upload failed: ${err?.message || "please try again."}`;
      showVisualError(msg);
      statusSpan.textContent = "";
      announce(msg);
      if (!guestPhotoRule) reportClientUploadAlert(err?.status || 0, msg);
      syncVisualControls();
    } finally {
      delete visualPreview.dataset.uploading;
      fileInput.disabled = busy;
      fileInput.value = "";
    }
  }

  fileInput.addEventListener("change", (event) => {
    const file = fileInput.files?.[0] || event?.target?.files?.[0] || event?.detail?.file;
    return uploadFile(file);
  });

  if (imageOnly) {
    visualPreview.addEventListener("dragover", (event) => {
      if (busy) return;
      event.preventDefault?.();
      visualPreview.classList.add("is-dragover");
    });
    visualPreview.addEventListener("dragleave", () => visualPreview.classList.remove("is-dragover"));
    visualPreview.addEventListener("drop", (event) => {
      event.preventDefault?.();
      visualPreview.classList.remove("is-dragover");
      if (busy) return undefined;
      return uploadFile(event?.dataTransfer?.files?.[0]);
    });
  } else {
    control.addEventListener("input", () => {
      syncVisualControls();
      renderInlineVisualPreview(control.value);
    });
  }

  syncVisualControls();
  renderInlineVisualPreview(draftContent[fieldDef.key]);
  visualControls.append(uploadLabel, fileInput, statusSpan, clearBtn);
  if (imageOnly) {
    const row = el("div", "sponsor-doc-visual-row");
    row.append(visualPreview, visualControls);
    fieldWrap.append(row, errorSlot);
  }
  else fieldWrap.append(visualControls, visualPreview);
}
