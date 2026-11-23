// One block of the issue editor: edit form (or read-only values for sponsor
// blocks), move/delete controls and the per-block revision history.

import { collectFields, failureText, fieldControl, formatWhen } from "./newsletter-blocks-dom.js";

const STATE_LABELS = { new: "New, not in Relay", edited: "Edited, not synced", "in-sync": "In sync" };

export function pushState(block) {
  return block.pushState || (block.changedSinceSync ? "edited" : "in-sync");
}

async function showHistory({ dom, request, base }, block, target) {
  target.replaceChildren(dom.el("p", "dk-hint", "Loading history…"));
  try {
    const key = block.relayBlockId ?? block.id;
    const result = await request(`${base}/revisions?block=${encodeURIComponent(String(key))}`);
    target.replaceChildren();
    for (const rev of [...result.revisions].reverse()) {
      const who = rev.origin.startsWith("relay") ? `Relay (${rev.relayActor || "?"})` : rev.actorName || "?";
      const fieldsChanged = rev.changes.map((c) => c.field).join(", ") || rev.detail || "no changes";
      const entry = dom.el("details", "newsletter-blocks__revision");
      entry.append(dom.el("summary", "", `rev ${rev.revision} · ${rev.origin} · ${who} · ${formatWhen(rev.createdAt)} · ${fieldsChanged}`));
      for (const change of rev.changes) {
        entry.append(dom.el("strong", "", change.field));
        if (rev.before) entry.append(dom.el("pre", "newsletter-blocks__before", change.before || "(empty)"));
        entry.append(dom.el("pre", "newsletter-blocks__after", change.after || "(empty)"));
      }
      target.append(entry);
    }
    if (!result.revisions.length) target.append(dom.el("p", "dk-hint", "No revisions."));
  } catch (error) {
    target.replaceChildren(dom.el("p", "dk-field-error", `History unavailable: ${error.message}`));
  }
}

function readOnlyValues(dom, block) {
  const list = dom.el("dl", "newsletter-blocks__values");
  list.dataset.blockReadonly = "";
  for (const field of block.fields || []) {
    const value = block.data?.[field.name];
    if (!value) continue;
    list.append(dom.el("dt", "", field.label), dom.el("dd", "", value));
  }
  return list;
}

function deleteHint(block) {
  if (block.canDelete) return "Delete this block";
  if (block.sponsor === "primary") return "The main sponsor block is pinned and cannot be deleted";
  if (block.sponsor) return "A secondary sponsor block is removed by removing the slot from its sponsor doc";
  return "This block cannot be deleted";
}

function moveHint(block, label) {
  if (block.canMove === false) {
    return block.sponsor === "primary" ? "The main sponsor block is pinned first and cannot be moved" : "This block cannot be moved";
  }
  return label;
}

/**
 * ctx: { dom, request, base, confirmFn, onChange(set, message), onFail(message), onMove(block, body), onDelete(block) }
 */
export function renderBlockCard(ctx, block, index, count) {
  const { dom } = ctx;
  const form = dom.el("form", "dk-card newsletter-blocks__block");
  form.dataset.blockId = block.id;
  if (block.canMove !== false) form.draggable = true;
  const head = dom.el("div", "newsletter-blocks__head");
  head.append(dom.el("strong", "", block.label));
  const relayRef = block.relayBlockId ? `Relay #${block.relayBlockId}` : "not in Relay yet";
  head.append(dom.el("span", "dk-mono newsletter-blocks__meta", `${block.type} · ${relayRef} · v${block.version}`));
  const state = pushState(block);
  const badge = dom.el("span", `dk-badge ${state === "in-sync" ? "dk-badge--success" : "dk-badge--warning"}`, STATE_LABELS[state]);
  badge.dataset.blockState = state === "in-sync" ? "in-sync" : state;
  head.append(badge);
  if (block.pinned) head.append(dom.el("span", "dk-badge", "Pinned: first content block"));
  if (block.updatedByName) head.append(dom.el("span", "dk-hint", `Last change: ${block.updatedByName}, ${formatWhen(block.updatedAt)}`));
  form.append(head);

  const error = dom.el("p", "dk-field-error");
  error.hidden = true;
  error.dataset.blockError = "";
  const showError = (message) => {
    error.textContent = message;
    error.hidden = false;
    ctx.onFail(message);
  };

  const actions = dom.el("div", "newsletter-blocks__actions");
  let save = null;
  if (block.readOnly) {
    form.append(readOnlyValues(dom, block));
    const note = dom.el("p", "dk-hint", "Sponsor block: its content comes only from the sponsor doc and syncs automatically on every doc save.");
    form.append(note);
    if (block.sponsorDocUrl) {
      const link = dom.el("a", "dk-link", "Edit in sponsor doc");
      link.href = block.sponsorDocUrl;
      link.dataset.sponsorDocLink = "";
      actions.append(link);
    }
  } else {
    for (const field of block.fields || []) form.append(fieldControl(dom, field, block.data?.[field.name]));
    save = dom.button("Save block", "primary", "save");
    save.type = "submit";
    actions.append(save);
  }

  const up = dom.button("↑ Up", "secondary", "up");
  const down = dom.button("↓ Down", "secondary", "down");
  const remove = dom.button("Delete", "secondary", "delete");
  const historyBtn = dom.button("History", "secondary", "history");
  up.disabled = block.canMove === false || index === 0;
  down.disabled = block.canMove === false || index === count - 1;
  up.title = moveHint(block, "Move up");
  down.title = moveHint(block, "Move down");
  remove.disabled = block.canDelete === false;
  remove.title = deleteHint(block);
  actions.append(up, down, remove, historyBtn);
  const history = dom.el("div", "newsletter-blocks__history");
  form.append(error, actions, history);

  const guarded = (run) => async (event) => {
    error.hidden = true;
    try {
      await run(event);
    } catch (failure) {
      showError(failureText(failure));
    }
  };
  up.addEventListener("click", guarded(() => ctx.onMove(block, { direction: "up" })));
  down.addEventListener("click", guarded(() => ctx.onMove(block, { direction: "down" })));
  remove.addEventListener("click", guarded(async () => {
    if (!ctx.confirmFn(`Delete "${block.label}"? It is removed from Relay on the next sync.`)) return;
    await ctx.onDelete(block);
  }));
  historyBtn.addEventListener("click", () => showHistory(ctx, block, history));
  form.addEventListener("dragstart", (event) => {
    ctx.drag.id = block.id;
    event.dataTransfer?.setData?.("text/plain", block.id);
  });
  form.addEventListener("dragover", (event) => event.preventDefault());
  form.addEventListener("drop", guarded(async (event) => {
    event.preventDefault();
    const dragged = ctx.drag.id;
    ctx.drag.id = "";
    if (dragged && dragged !== block.id) await ctx.onMove({ id: dragged }, { to: index });
  }));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!save) return;
    save.disabled = true;
    error.hidden = true;
    try {
      const result = await ctx.request(`${ctx.base}/${encodeURIComponent(block.id)}`, {
        method: "PUT",
        body: JSON.stringify({ version: block.version, data: collectFields(form) }),
      });
      ctx.onChange(result.blocks, result.changed ? `Saved ${block.label}. Sync with Relay to publish it there.` : `${block.label}: no changes.`);
    } catch (failure) {
      showError(failureText(failure));
      save.disabled = false;
    }
  });
  return form;
}
