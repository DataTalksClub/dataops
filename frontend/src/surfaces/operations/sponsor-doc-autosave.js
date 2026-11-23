import { reportClientFailure } from "../../core/guarded-fetch.js";

/** Debounce between the last edit and the automatic save. */
export const SPONSOR_DOC_AUTOSAVE_DELAY_MS = 1200;

// The guest time choice is confirmed with its own "Save time choice" button
// (it records a booking intent), so autosave keeps its saved value.
const EXPLICIT_SAVE_KEYS = ["slotChoice"];

/**
 * Never tell the visitor to reload after a failed save: a reload throws the
 * unsaved edits away. Timeouts, network errors and 5xx (already reported to
 * the server by the request layer) get a save-specific explanation.
 */
export function notSavedMessage(err) {
  const status = err?.status;
  let cause;
  if (status === "timeout") cause = "the server took too long to respond.";
  else if (status === "network") cause = "the connection failed.";
  else if (typeof status === "number" && status >= 500) cause = `the server returned an error (${status}).`;
  if (cause) {
    return `NOT SAVED: ${cause} Your edits are still in this form; do not reload. Click Retry save, or keep editing and it retries. The DataTalks.Club team has been notified.`;
  }
  return `NOT SAVED: ${err?.message || "Failed to save changes."} Your edits are still in this form.`;
}

/**
 * 5xx, timeouts and network errors are already reported by the request layer;
 * report the rest (4xx) too so no failed save goes unnoticed.
 */
export function reportSaveFailure(err) {
  if (typeof err?.status === "number" && err.status < 500) {
    reportClientFailure({ surface: "sponsor-doc", check: "PUT /api/sponsor-docs", status: err.status, message: String(err.message || "") });
  }
}

/**
 * Autosave for the sponsor doc page: every edit (typing, helper buttons,
 * uploads, selects) is saved after a short debounce, without re-rendering the
 * form, and the visible status line shows saving / saved / NOT SAVED.
 * `baseline` is the content last persisted.
 */
export function createSponsorDocAutosave({
  el,
  actionBtn,
  root,
  request,
  announce,
  ctx,
  delayMs = SPONSOR_DOC_AUTOSAVE_DELAY_MS,
}) {
  let baseline = null;
  let timer = null;
  let inFlight = null;
  let state = "saved";
  let error = "";

  function savedContent() {
    const content = ctx.savableContent();
    for (const key of EXPLICIT_SAVE_KEYS) {
      if (!baseline || !(key in baseline)) delete content[key];
      else content[key] = baseline[key];
    }
    return content;
  }

  function markClean(content = ctx.savableContent()) {
    baseline = { ...content };
  }

  function forgetBaseline() {
    baseline = null;
  }

  function isDirty() {
    if (!ctx.doc() || !baseline) return false;
    const draft = savedContent();
    const keys = new Set([...Object.keys(baseline), ...Object.keys(draft)]);
    for (const key of keys) {
      if (String(baseline[key] ?? "") !== String(draft[key] ?? "")) return true;
    }
    return false;
  }

  function setSaved() {
    state = "saved";
    error = "";
  }

  function setError(message) {
    state = "error";
    error = message;
  }

  function fillStatus(node) {
    const tone = { saved: "success", pending: "warning", saving: "info", error: "danger" }[state] || "info";
    node.className = `dk-callout dk-callout--${tone} sponsor-doc-save-status`;
    node.dataset.sponsorSaveStatus = "";
    node.dataset.sponsorSaveState = state;
    node.setAttribute("role", state === "error" ? "alert" : "status");
    const body = el("div", "dk-callout__body");
    if (state === "error") {
      body.append(el("span", "", `${error} `));
      body.append(actionBtn("dk-button dk-button--secondary dk-button--sm", "Retry save", "retry-save", () => run()));
    } else if (state === "saving") {
      body.textContent = "Saving…";
    } else if (state === "pending") {
      body.textContent = "Unsaved changes · saving automatically…";
    } else {
      const label = ctx.savedLabel();
      body.textContent = label ? `All changes saved · ${label}` : "Changes save automatically.";
    }
    node.replaceChildren(body);
  }

  function statusNode() {
    const node = el("div");
    fillStatus(node);
    return node;
  }

  function refresh() {
    for (const node of root?.querySelectorAll?.("[data-sponsor-save-status]") || []) fillStatus(node);
  }

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function schedule(delay = delayMs) {
    if (!ctx.editing()) return;
    if (!isDirty()) {
      if (state === "pending") state = "saved";
      refresh();
      return;
    }
    if (state !== "error" && state !== "saving") state = "pending";
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      run();
    }, delay);
    refresh();
  }

  async function run() {
    clearTimer();
    if (inFlight) {
      await inFlight;
      return run();
    }
    if (!ctx.editing()) return undefined;
    if (ctx.busy()) {
      // A manual save / submit is running; it sends the same content.
      schedule();
      return undefined;
    }
    if (!isDirty()) {
      if (state !== "error") state = "saved";
      refresh();
      return undefined;
    }
    const content = savedContent();
    const docId = ctx.docId();
    state = "saving";
    refresh();
    inFlight = (async () => {
      try {
        const code = ctx.accessCode();
        const payload = await request(`/api/sponsor-docs/${encodeURIComponent(docId)}`, {
          method: "PUT",
          headers: code ? { "x-sponsor-doc-code": code } : {},
          body: JSON.stringify({ content }),
        });
        if (ctx.docId() !== docId || !ctx.doc()) return;
        ctx.setDoc(payload.doc);
        markClean(content);
        setSaved();
        announce("All changes saved.");
      } catch (err) {
        setError(notSavedMessage(err));
        if (err?.fields && typeof err.fields === "object") {
          ctx.setFieldErrors(err.fields);
          for (const key of Object.keys(err.fields)) {
            root?.querySelector?.(`[data-sponsor-field="${key}"]`)?.setAttribute?.("aria-invalid", "true");
          }
        }
        reportSaveFailure(err);
        announce(error);
      } finally {
        inFlight = null;
      }
    })();
    await inFlight;
    // Edits made while the request was in flight get their own save.
    if (state === "saved" && isDirty()) schedule();
    else refresh();
    return undefined;
  }

  /** Before a manual save: drop the pending timer and let a running save finish. */
  async function settle() {
    clearTimer();
    if (inFlight) await inFlight;
  }

  /** Save now if a save is pending (tab hidden / page unloading). */
  function flush() {
    if (timer) run();
  }

  /** Save on every edit event; warn before leaving with unsaved work; flush on tab hide. */
  function attach(documentRef) {
    root.addEventListener("input", () => schedule());
    root.addEventListener("change", () => schedule());
    globalThis.addEventListener?.("beforeunload", (event) => {
      if (!ctx.editing() || !(isDirty() || inFlight || ctx.busy())) return;
      flush();
      event.preventDefault();
      event.returnValue = "";
    });
    documentRef.addEventListener?.("visibilitychange", () => {
      if (documentRef.visibilityState === "hidden") flush();
    });
  }

  return {
    attach, clearTimer, fillStatus, flush, forgetBaseline, markClean, run, schedule, setError, setSaved, settle, statusNode,
  };
}
