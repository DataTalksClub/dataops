import { html } from "./shared.js";

/**
 * Unified sponsor activity timeline + append-only notes.
 *
 * Reads the D workspace contract only:
 *   GET /api/sponsor-crm/activity/organization|contact|deal/:id?types=&limit=&cursor=
 *     -> { targetType, targetId, items, total, nextCursor, sources,
 *          relatedWork, tasksScope: 'open', reads }
 *   POST /api/sponsor-crm/notes/organization|contact|deal/:id { body, sourceKey? }
 *     -> 201 new note, 200 same id on idempotent replay (success),
 *        409 on conflicting body (surfaced as an honest error, never success).
 *
 * Timeline items (server shape): { ts, source, id, actor, text,
 * detail?, provenance }. Related work (open tasks only, never history):
 * { taskId, status, date, description, assigneeId?, href,
 *   scope: 'direct' | 'related-company' }.
 * Mail is read-only snippets; the store holds no bodies and there is no
 * compose/send path anywhere in this module.
 */

export const ACTIVITY_TYPES = Object.freeze([
  "note",
  "touch",
  "mail",
  "history",
  "deal-history",
]);

export const ACTIVITY_TYPE_LABELS = Object.freeze({
  note: "Note",
  touch: "Touch",
  mail: "Mail",
  history: "Record change",
  "deal-history": "Deal change",
});

export const DEFAULT_ACTIVITY_LIMIT = 30;

export function formatBerlinDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

export function formatBerlinDate(value) {
  const iso = String(value || "").slice(0, 10);
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return String(value || "");
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "Europe/Berlin",
  }).format(parsed);
}

function humanize(value, humanizeOptionLabel) {
  if (typeof humanizeOptionLabel === "function") return humanizeOptionLabel(value);
  return String(value ?? "")
    .replaceAll("-", " ")
    .replaceAll("_", " ");
}

export function provenanceLabel(item) {
  const provenance = item?.provenance || {};
  const parts = [];
  if (provenance.dealId) parts.push("deal activity");
  if (provenance.link === "direct") parts.push("directly linked");
  if (provenance.direction) parts.push(String(provenance.direction));
  if (item?.actor) parts.push(`by ${item.actor}`);
  return parts.join(" · ");
}

export function activityItemMarkup(item, context = {}) {
  const { escapeHtml, humanizeOptionLabel } = context;
  const escape = typeof escapeHtml === "function" ? escapeHtml : String;
  const type = ACTIVITY_TYPES.includes(item?.source) ? item.source : "history";
  const label = ACTIVITY_TYPE_LABELS[type] || humanize(type, humanizeOptionLabel);
  const provenance = provenanceLabel(item);
  const full = item?.detail && typeof item.detail.body === "string"
    ? item.detail.body
    : item?.detail && typeof item.detail.snippet === "string"
      ? item.detail.snippet
      : "";
  const text = String(item?.text ?? "");
  return html`<li class="crm-activity-item" data-activity-source="${escape(type)}">
    <div class="crm-activity-head">
      <strong>${escape(label)}</strong>
      <span>${escape(formatBerlinDateTime(item?.ts))}</span>
    </div>
    ${provenance ? html`<p class="crm-activity-provenance">${escape(provenance)}</p>` : ""}
    <p>${escape(text)}</p>
    ${full && full !== text
      ? html`<details><summary>Full text</summary><p>${escape(full)}</p></details>`
      : ""}
  </li>`;
}

export function activityListMarkup(items, context = {}) {
  const { escapeHtml } = context;
  const escape = typeof escapeHtml === "function" ? escapeHtml : String;
  if (!items?.length) {
    return html`<div class="honest-state">
      <strong>No activity yet</strong>
      <p>Notes, touches, filed mail and record changes will appear here.</p>
    </div>`;
  }
  return html`<ul class="crm-activity-list">${items.map((item) => activityItemMarkup(item, context)).join("")}</ul>`;
}

export function relatedWorkMarkup(items, context = {}) {
  const { escapeHtml } = context;
  const escape = typeof escapeHtml === "function" ? escapeHtml : String;
  if (!items?.length) return "";
  return html`<section aria-label="Related open work">
    <h4>Related open work</h4>
    <ul class="crm-activity-related">
      ${items
        .map(
          (task) => html`<li>
            <button type="button" data-open-task="${escape(task.taskId)}">
              <strong>${escape(task.description || "Open task")}</strong>
              <span>${escape(formatBerlinDate(task.date))}${task.scope === "related-company" ? " · related company" : ""}</span>
            </button>
          </li>`,
        )
        .join("")}
    </ul>
  </section>`;
}

export function activityPanelMarkup({ targetType, types = [] } = {}) {
  const selected = new Set(types.length ? types : ACTIVITY_TYPES);
  const options = ACTIVITY_TYPES.map(
    (type) => html`<option value="${type}"${selected.has(type) ? " selected" : ""}>${ACTIVITY_TYPE_LABELS[type]}</option>`,
  ).join("");
  return html`<div class="crm-activity-panel" data-activity-panel="${targetType}">
    <div class="crm-activity-tools">
      <label>Show
        <select data-activity-types multiple size="5">${options}</select>
      </label>
    </div>
    <div data-activity-list aria-live="polite"></div>
    <div data-activity-pager></div>
    <section aria-label="Related open work"><div data-activity-related></div></section>
    <form data-activity-note-form>
      <label>Add a note
        <textarea name="body" maxlength="2000" rows="3" required placeholder="What happened? Notes are permanent."></textarea>
      </label>
      <p data-activity-note-status role="status"></p>
      <footer><button class="primary-button" type="submit" data-activity-note-save>Add note</button></footer>
    </form>
  </div>`;
}

/**
 * Totally DOM-free loader: paging, type filter and idempotent note appends.
 * `api(path, options)` resolves parsed JSON and throws errors carrying
 * `.status` (the sponsors.js convention).
 */
export function createActivityLoader({ api, targetType, targetId, limit = DEFAULT_ACTIVITY_LIMIT }) {
  if (typeof api !== "function") throw new Error("createActivityLoader requires api");
  if (!["organization", "contact", "deal"].includes(targetType)) {
    throw new Error(`createActivityLoader: unknown target ${targetType}`);
  }
  const state = {
    items: [],
    relatedWork: [],
    sources: {},
    total: 0,
    nextCursor: null,
    types: [],
    status: "idle",
    error: "",
  };

  function query({ cursor = null } = {}) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (state.types.length) params.set("types", state.types.join(","));
    if (cursor) params.set("cursor", cursor);
    return `/activity/${targetType}/${encodeURIComponent(targetId)}?${params}`;
  }

  async function load({ types = state.types } = {}) {
    state.types = [...types];
    state.status = "loading";
    state.error = "";
    try {
      const result = await api(query());
      state.items = result.items || [];
      state.relatedWork = result.relatedWork || [];
      state.sources = result.sources || {};
      state.total = typeof result.total === "number" ? result.total : state.items.length;
      state.nextCursor = result.nextCursor ?? null;
      state.status = "ready";
    } catch (error) {
      state.status = "error";
      state.error = error?.message || "Could not load activity";
    }
    return state;
  }

  async function loadMore() {
    if (!state.nextCursor) return state;
    state.status = "loading-more";
    try {
      const result = await api(query({ cursor: state.nextCursor }));
      state.items = [...state.items, ...(result.items || [])];
      state.nextCursor = result.nextCursor ?? null;
      state.total = typeof result.total === "number" ? result.total : state.total;
      state.status = "ready";
    } catch (error) {
      // A bound-cursor rejection (400) means the filter changed under the
      // page: surface it and let the caller reload from the first page.
      state.status = "error";
      state.error = error?.message || "Could not load more activity";
    }
    return state;
  }

  /**
   * Append-only note. 2xx with an id is success (201 new, 200 idempotent
   * replay of the same body+sourceKey). 409 is a conflicting body under the
   * same key and is thrown as an error, never treated as success.
   */
  async function addNote({ body, sourceKey }) {
    const text = String(body || "").trim();
    if (!text) throw new Error("Note text is required");
    if (text.length > 2000) throw new Error("Note text must be 1..2000 characters");
    const result = await api(`/notes/${targetType}/${encodeURIComponent(targetId)}`, {
      method: "POST",
      body: JSON.stringify({ body: text, ...(sourceKey ? { sourceKey } : {}) }),
    });
    if (!result || typeof result.id !== "string") {
      throw new Error("Note was not saved: missing note id");
    }
    return result;
  }

  return { state, load, loadMore, addNote, query };
}

function defaultKey() {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return random;
  return `note-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/**
 * Wire a rendered activityPanelMarkup root: type filter, pager, note form
 * and related-work task buttons. All callbacks optional except rendering.
 */
export function wireActivityPanel(root, loader, context = {}) {
  const { escapeHtml, humanizeOptionLabel, safe, openTaskPanel, generateKey } = context;
  const fail = typeof safe === "function" ? safe : async (action) => action();
  const list = root.querySelector("[data-activity-list]");
  const pager = root.querySelector("[data-activity-pager]");
  const related = root.querySelector("[data-activity-related]");
  const form = root.querySelector("[data-activity-note-form]");
  const status = root.querySelector("[data-activity-note-status]");
  let noteKey = "";

  function paint() {
    const { state } = loader;
    if (!list) return;
    if (state.status === "loading" || state.status === "idle") {
      list.innerHTML = html`<div class="honest-state"><strong>Loading activity…</strong></div>`;
    } else if (state.status === "error") {
      list.innerHTML = html`<div class="honest-state">
        <strong>Activity unavailable</strong>
        <p>${(typeof escapeHtml === "function" ? escapeHtml : String)(state.error)}</p>
        <button type="button" data-activity-retry>Retry</button>
      </div>`;
    } else {
      list.innerHTML = activityListMarkup(state.items, { escapeHtml, humanizeOptionLabel });
    }
    if (related) {
      related.innerHTML = relatedWorkMarkup(state.relatedWork, { escapeHtml });
    }
    if (pager) {
      pager.innerHTML = loader.state.nextCursor && loader.state.status === "ready"
        ? html`<button type="button" data-activity-more>Show more (${loader.state.total - loader.state.items.length} remaining)</button>`
        : "";
    }
  }

  async function refresh() {
    await loader.load();
    paint();
  }

  root.querySelector("[data-activity-types]")?.addEventListener("change", async (event) => {
    const selected = [...event.target.selectedOptions || [...event.target.options || []].filter((o) => o.selected)].map((o) => o.value);
    await fail(async () => {
      await loader.load({ types: selected.filter((t) => ACTIVITY_TYPES.includes(t)) });
      paint();
    }, "Could not filter activity");
  });

  pager?.addEventListener("click", async (event) => {
    if (!event.target.closest("[data-activity-more]")) return;
    await fail(async () => {
      await loader.loadMore();
      paint();
    }, "Could not load more activity");
  });

  list?.addEventListener("click", async (event) => {
    if (!event.target.closest("[data-activity-retry]")) return;
    await fail(refresh, "Could not load activity");
  });

  related?.addEventListener("click", (event) => {
    const taskId = event.target.closest("[data-open-task]")?.dataset.openTask;
    if (taskId && typeof openTaskPanel === "function") openTaskPanel(taskId);
  });

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = form.elements?.body?.value ?? "";
    await fail(async () => {
      // Reuse the key across retries of the same draft so a retry is an
      // idempotent replay; mint a fresh key only after a saved note.
      if (!noteKey) noteKey = typeof generateKey === "function" ? generateKey() : defaultKey();
      if (status) status.textContent = "Saving note…";
      const saved = await loader.addNote({ body, sourceKey: noteKey });
      noteKey = "";
      if (form.elements?.body) form.elements.body.value = "";
      if (status) status.textContent = "Note saved.";
      await loader.load();
      paint();
      return saved;
    }, "Could not save note").catch(() => {
      if (status) status.textContent = "Note was not saved. Retry to send the same note.";
    });
  });

  return { paint, refresh };
}
