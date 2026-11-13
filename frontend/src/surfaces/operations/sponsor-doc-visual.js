import { isLoadableImageSrc, mountInlineImageWithFallback } from "./sponsor-doc-email-card.js";

const MAX_BRIEF_IMAGE_BYTES = 4 * 1024 * 1024;

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

  const fileInputId = `sponsor-visual-file-${fieldDef.key}`;
  const uploadClass = "dk-button dk-button--secondary dk-button--sm sponsor-doc-visual-upload__label";
  const uploadLabel = el("label", uploadClass, "Upload visual");
  uploadLabel.setAttribute("for", fileInputId);

  const fileInput = el("input", "sponsor-doc-visual-upload__input");
  fileInput.type = "file";
  fileInput.id = fileInputId;
  fileInput.accept = "image/png,image/jpeg,image/gif,image/webp,image/*";
  fileInput.dataset.sponsorVisualUpload = fieldDef.key;
  fileInput.disabled = busy;

  const statusSpan = el("span", "sponsor-doc-visual-upload__status");
  statusSpan.dataset.sponsorVisualStatus = "";

  const visualPreview = el("div", "sponsor-doc-visual-preview");
  visualPreview.dataset.sponsorVisualPreview = fieldDef.key;

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

  function showVisualError(message) {
    fieldErrors[fieldDef.key] = message;
    control.setAttribute("aria-invalid", "true");
    visualPreview.hidden = false;
    visualPreview.replaceChildren();
    const errBox = el("div", "sponsor-doc-visual-error", message);
    errBox.setAttribute("role", "alert");
    errBox.dataset.sponsorVisualError = fieldDef.key;
    visualPreview.append(errBox);
  }

  function renderInlineVisualPreview(rawVal) {
    const v = String(rawVal || "").trim();
    visualPreview.replaceChildren();
    if (!v) {
      visualPreview.hidden = true;
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
    } else {
      showVisualError(
        `Image cannot be displayed: "${v}" is a filename, not a hosted image URL. Upload the image or paste a full https:// URL.`,
      );
    }
  }

  const clearBtn = actionBtn("dk-button dk-button--secondary dk-button--sm", "Remove visual", "clear-visual", () => {
    setUploadedVisualName("");
    draftContent[fieldDef.key] = "";
    control.value = "";
    control.placeholder = fieldDef.placeholder || "";
    fileInput.value = "";
    updateCount("");
    syncVisualControls();
    renderInlineVisualPreview("");
    updateLivePreview();
  });

  function syncVisualControls() {
    const v = String(draftContent[fieldDef.key] || "").trim();
    const name = getUploadedVisualName();
    if (/^data:image\//i.test(v)) {
      statusSpan.textContent = name ? `Uploaded visual: ${name}` : "Uploaded visual attached";
      clearBtn.hidden = false;
    } else if (v) {
      statusSpan.textContent = name ? `Uploaded visual: ${name}` : "Using linked image URL";
      clearBtn.hidden = false;
    } else {
      statusSpan.textContent = "Upload PNG, JPG, WebP, or GIF to preview right away";
      clearBtn.hidden = true;
    }
  }

  fileInput.addEventListener("change", async (event) => {
    const file = fileInput.files?.[0] || event?.target?.files?.[0] || event?.detail?.file;
    if (!file) return;
    if (typeof file.size === "number" && file.size > MAX_BRIEF_IMAGE_BYTES) {
      const msg = "This image exceeds the 4 MiB limit. Please upload a smaller image or paste an image URL.";
      showVisualError(msg);
      statusSpan.textContent = msg;
      announce(msg);
      reportClientUploadAlert(413, msg);
      fileInput.value = "";
      return;
    }
    statusSpan.textContent = "Uploading image…";
    fileInput.disabled = true;
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
      const payload = await request(`/api/sponsor-docs/${encodeURIComponent(docId)}/images`, {
        method: "POST",
        headers,
        body: formData || file,
      });
      const hostedUrl = payload?.image?.url || payload?.image?.path || "";
      if (!hostedUrl) throw new Error("Upload did not return an image URL.");
      const name = file.name || "uploaded-visual.png";
      setUploadedVisualName(name);
      draftContent[fieldDef.key] = hostedUrl;
      control.value = hostedUrl;
      control.placeholder = fieldDef.placeholder || "";
      if (fieldErrors[fieldDef.key]) {
        delete fieldErrors[fieldDef.key];
        control.removeAttribute("aria-invalid");
        fieldWrap.querySelector(`[data-sponsor-field-error="${fieldDef.key}"]`)?.remove?.();
      }
      updateCount(hostedUrl);
      syncVisualControls();
      renderInlineVisualPreview(hostedUrl);
      updateLivePreview();
      announce(`Uploaded visual ${name} for live preview.`);
    } catch (err) {
      const msg = err?.message || "Could not upload image. Please try again.";
      showVisualError(msg);
      statusSpan.textContent = msg;
      announce(msg);
    } finally {
      fileInput.disabled = busy;
      fileInput.value = "";
    }
  });

  control.addEventListener("input", () => {
    syncVisualControls();
    renderInlineVisualPreview(control.value);
  });

  syncVisualControls();
  renderInlineVisualPreview(draftContent[fieldDef.key]);
  visualControls.append(uploadLabel, fileInput, statusSpan, clearBtn);
  fieldWrap.append(visualControls, visualPreview);
}
