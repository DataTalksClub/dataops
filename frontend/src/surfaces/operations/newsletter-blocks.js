// The issue page's "Content blocks" section: every block of the newsletter
// issue (intro, sponsor, event spotlight, course updates, events list,
// recording, article...) as an editable form, with per-block history and the
// two-way Relay sync. Edits save to DataOps (one revision each); "Sync with
// Relay" pushes DataOps edits and pulls Relay edits, and is refused as a whole
// when a block changed on both sides.

const enc = encodeURIComponent;
const MULTILINE = new Set(["markdown", "lines", "html"]);

function formatWhen(iso) {
  if (!iso) return "";
  return String(iso).slice(0, 16).replace("T", " ");
}

export function createNewsletterBlocksSection({ documentRef, request, workApiUrl }) {
  const el = (tag, className, text) => {
    const node = (documentRef || globalThis.document).createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (label, variant, action) => {
    const node = el("button", `dk-button dk-button--sm${variant ? ` dk-button--${variant}` : ""}`, label);
    node.type = "button";
    if (action) node.dataset.blocksAction = action;
    return node;
  };

  async function mount(container, issueId) {
    const base = workApiUrl(`/api/newsletter-issues/${enc(issueId)}/blocks`);
    const section = el("section", "newsletter-blocks");
    section.dataset.newsletterBlocks = "";
    section.setAttribute("aria-labelledby", "newsletter-blocks-title");
    const heading = el("h2", "newsletter-blocks__title", "Content blocks");
    heading.id = "newsletter-blocks-title";
    const status = el("p", "newsletter-blocks__status");
    status.setAttribute("role", "status");
    status.dataset.blocksStatus = "";
    const body = el("div", "newsletter-blocks__body");
    section.append(heading, status, body);
    container.append(section);

    let set = null;

    function say(message, tone = "info") {
      status.textContent = message;
      status.dataset.tone = tone;
    }

    function renderImport() {
      body.replaceChildren();
      const form = el("form", "newsletter-blocks__import");
      form.dataset.blocksImport = "";
      const keyLabel = el("label", "dk-label", "Relay issue key");
      const key = el("input", "dk-input");
      key.name = "issueKey";
      key.placeholder = "weekly-304";
      key.required = true;
      keyLabel.append(key);
      const targetLabel = el("label", "dk-label", "Relay");
      const target = el("select", "dk-select");
      target.name = "target";
      for (const value of ["production", "dev"]) {
        const option = el("option", "", value);
        option.value = value;
        target.append(option);
      }
      targetLabel.append(target);
      const submit = button("Import blocks from Relay", "primary");
      submit.type = "submit";
      form.append(el("p", "dk-hint", "This issue has no blocks in DataOps yet. Import them once from its Relay issue."), keyLabel, targetLabel, submit);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        submit.disabled = true;
        say("Importing blocks from Relay…");
        try {
          const result = await request(`${base}/import`, {
            method: "POST",
            body: JSON.stringify({ issueKey: key.value.trim(), target: target.value }),
          });
          set = result.blocks;
          say(`Imported ${set.blocks.length} blocks from Relay ${set.relay.target} ${set.relay.issueKey}.`, "success");
          renderSet();
        } catch (error) {
          say(`Import failed: ${error.message}`, "danger");
          submit.disabled = false;
        }
      });
      body.append(form);
    }

    function syncReport(result) {
      const list = el("ul", "newsletter-blocks__plan");
      list.dataset.blocksPlan = "";
      for (const step of result.plan || result.conflicts || []) {
        const item = el("li", step.action === "conflict" ? "newsletter-blocks__conflict" : "");
        item.textContent = `#${step.relayBlockId} ${step.type}: ${step.action} (${step.reason})`;
        list.append(item);
      }
      return list;
    }

    async function runSync(dryRun, report) {
      say(dryRun ? "Comparing with Relay…" : "Syncing with Relay…");
      report.replaceChildren();
      try {
        const result = await request(`${base}/sync`, { method: "POST", body: JSON.stringify({ dryRun }) });
        report.append(syncReport(result));
        if (!dryRun) {
          set = result.blocks;
          renderSet();
          say(`Synced with Relay: pushed ${result.pushed.length}, pulled ${result.pulled.length}.`, "success");
          return;
        }
        say(`Relay check: ${result.summary}. Nothing written.`);
      } catch (error) {
        say(error.message, "danger");
        if (error.payload?.plan || error.payload?.conflicts) report.append(syncReport(error.payload));
      }
    }

    function fieldControl(block, field) {
      const wrap = el("label", "dk-label newsletter-blocks__field");
      wrap.append(el("span", "", `${field.label}${field.required ? " *" : ""}`));
      const multiline = MULTILINE.has(field.kind);
      const input = el(multiline ? "textarea" : "input", multiline ? "dk-textarea" : "dk-input");
      input.name = field.name;
      input.value = block.data?.[field.name] || "";
      if (!multiline) input.type = field.kind === "url" ? "url" : "text";
      if (multiline) input.rows = Math.min(14, Math.max(3, input.value.split("\n").length + 1));
      if (field.default) input.placeholder = field.default;
      input.dataset.blockField = field.name;
      wrap.append(input);
      return wrap;
    }

    async function showHistory(block, target) {
      target.replaceChildren(el("p", "dk-hint", "Loading history…"));
      try {
        const result = await request(`${base}/revisions?block=${enc(String(block.relayBlockId))}`);
        target.replaceChildren();
        for (const rev of [...result.revisions].reverse()) {
          const who = rev.origin.startsWith("relay") ? `Relay (${rev.relayActor || "?"})` : rev.actorName || "?";
          const entry = el("details", "newsletter-blocks__revision");
          entry.append(el("summary", "", `rev ${rev.revision} · ${rev.origin} · ${who} · ${formatWhen(rev.createdAt)} · ${rev.changes.map((c) => c.field).join(", ") || "no changes"}`));
          for (const change of rev.changes) {
            entry.append(el("strong", "", change.field));
            if (rev.before) entry.append(el("pre", "newsletter-blocks__before", change.before || "(empty)"));
            entry.append(el("pre", "newsletter-blocks__after", change.after || "(empty)"));
          }
          target.append(entry);
        }
        if (!result.revisions.length) target.append(el("p", "dk-hint", "No revisions."));
      } catch (error) {
        target.replaceChildren(el("p", "dk-field-error", `History unavailable: ${error.message}`));
      }
    }

    function blockCard(block) {
      const form = el("form", "dk-card newsletter-blocks__block");
      form.dataset.blockId = block.id;
      const head = el("div", "newsletter-blocks__head");
      head.append(el("strong", "", block.label));
      head.append(el("span", "dk-mono newsletter-blocks__meta", `${block.type} · Relay #${block.relayBlockId} · v${block.version}`));
      const badge = el(
        "span",
        `dk-badge ${block.changedSinceSync ? "dk-badge--warning" : "dk-badge--success"}`,
        block.changedSinceSync ? "Edited, not synced" : "In sync",
      );
      badge.dataset.blockState = block.changedSinceSync ? "edited" : "in-sync";
      head.append(badge);
      if (block.updatedByName) head.append(el("span", "dk-hint", `Last change: ${block.updatedByName}, ${formatWhen(block.updatedAt)}`));
      form.append(head);
      for (const field of block.fields || []) form.append(fieldControl(block, field));
      const error = el("p", "dk-field-error");
      error.hidden = true;
      const actions = el("div", "newsletter-blocks__actions");
      const save = button("Save block", "primary", "save");
      save.type = "submit";
      const historyBtn = button("History", "secondary", "history");
      const history = el("div", "newsletter-blocks__history");
      actions.append(save, historyBtn);
      form.append(error, actions, history);
      historyBtn.addEventListener("click", () => showHistory(block, history));
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const data = {};
        for (const input of form.querySelectorAll("[data-block-field]")) data[input.name] = input.value;
        save.disabled = true;
        error.hidden = true;
        try {
          const result = await request(`${base}/${enc(block.id)}`, {
            method: "PUT",
            body: JSON.stringify({ version: block.version, data }),
          });
          set = result.blocks;
          renderSet();
          say(result.changed ? `Saved ${block.label}. Sync with Relay to publish it there.` : `${block.label}: no changes.`, "success");
        } catch (failure) {
          const fields = failure.payload?.fields ? ` (${Object.entries(failure.payload.fields).map(([k, v]) => `${k}: ${v}`).join(", ")})` : "";
          error.textContent = `${failure.message}${fields}`;
          error.hidden = false;
          save.disabled = false;
        }
      });
      return form;
    }

    function renderSet() {
      body.replaceChildren();
      const bar = el("div", "newsletter-blocks__bar");
      const pending = set.blocks.filter((block) => block.changedSinceSync).length;
      bar.append(
        el(
          "span",
          "",
          `Relay ${set.relay.target} · ${set.relay.issueKey} · ${set.blocks.length} blocks${pending ? ` · ${pending} edited, not synced` : ""}`,
        ),
      );
      if (set.relayIssue?.subject) bar.append(el("span", "dk-hint", `Subject: ${set.relayIssue.subject}`));
      if (set.lastSync) bar.append(el("span", "dk-hint", `Last sync ${formatWhen(set.lastSync.at)} by ${set.lastSync.byName || "?"}: ${set.lastSync.summary}`));
      const check = button("Check Relay", "secondary", "check");
      const sync = button("Sync with Relay", "primary", "sync");
      const report = el("div", "newsletter-blocks__report");
      check.addEventListener("click", () => runSync(true, report));
      sync.addEventListener("click", () => runSync(false, report));
      const actions = el("div", "newsletter-blocks__actions");
      actions.append(check, sync);
      bar.append(actions);
      body.append(bar, report);
      const list = el("div", "newsletter-blocks__list");
      for (const block of set.blocks) list.append(blockCard(block));
      body.append(list);
    }

    say("Loading content blocks…");
    try {
      set = (await request(base)).blocks;
      say("");
      renderSet();
    } catch (error) {
      if (error.code === "blocks_not_imported") {
        say("");
        renderImport();
      } else {
        say(`Content blocks unavailable: ${error.message}`, "danger");
      }
    }
    return section;
  }

  return { mount };
}
