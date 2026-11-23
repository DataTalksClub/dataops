// The newsletter issue editor: every block of the issue (intro, sponsor, event
// spotlight, course updates, events list, recording, article...) as an
// editable form, with add / reorder (buttons or drag) / delete, per-block
// history and the two-way Relay sync. Edits save to DataOps (one revision
// each); "Sync with Relay" pushes DataOps changes (edits, new, moved and
// deleted blocks), pulls Relay edits, and is refused as a whole on conflicts.
// Sponsor blocks are read-only here: their content comes from the sponsor doc.

import { createAddPanel } from "./newsletter-blocks-add.js";
import { renderBlockCard } from "./newsletter-blocks-card.js";
import { createDom, formatWhen } from "./newsletter-blocks-dom.js";

const enc = encodeURIComponent;

export function createNewsletterBlocksSection({ documentRef, request, workApiUrl, confirmFn }) {
  const dom = createDom(documentRef);
  const { el, button } = dom;
  const confirmUser = confirmFn || ((message) => globalThis.confirm(message));

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
    const drag = { id: "" };

    function say(message, tone = "info") {
      status.textContent = message;
      status.dataset.tone = tone;
    }

    function update(next, message) {
      set = next;
      renderSet();
      say(message, "success");
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
      const hint = "This issue has no blocks in DataOps yet. Import them once from its Relay issue.";
      form.append(el("p", "dk-hint", hint), keyLabel, targetLabel, submit);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        submit.disabled = true;
        say("Importing blocks from Relay…");
        try {
          const result = await request(`${base}/import`, {
            method: "POST",
            body: JSON.stringify({ issueKey: key.value.trim(), target: target.value }),
          });
          update(result.blocks, `Imported ${result.blocks.blocks.length} blocks from Relay ${result.blocks.relay.target} ${result.blocks.relay.issueKey}.`);
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

    const cardContext = () => ({
      dom,
      request,
      base,
      drag,
      confirmFn: confirmUser,
      onChange: update,
      onFail: (message) => say(message, "danger"),
      onMove: async (block, move) => {
        const result = await request(`${base}/${enc(block.id)}/move`, { method: "POST", body: JSON.stringify(move) });
        update(result.blocks, "Block moved. Sync with Relay to reorder it there.");
      },
      onDelete: async (block) => {
        const result = await request(`${base}/${enc(block.id)}`, { method: "DELETE" });
        update(result.blocks, `Deleted ${block.label}. Sync with Relay to remove it there.`);
      },
    });

    function renderBar() {
      const bar = el("div", "newsletter-blocks__bar");
      const pending = set.blocks.filter((block) => block.changedSinceSync).length;
      const summary = `Relay ${set.relay.target} · ${set.relay.issueKey} · ${set.blocks.length} blocks`;
      bar.append(el("span", "", `${summary}${pending ? ` · ${pending} edited, not synced` : ""}`));
      if (set.relayIssue?.subject) bar.append(el("span", "dk-hint", `Subject: ${set.relayIssue.subject}`));
      if (set.lastSync) bar.append(el("span", "dk-hint", `Last sync ${formatWhen(set.lastSync.at)} by ${set.lastSync.byName || "?"}: ${set.lastSync.summary}`));
      if (set.orderChanged) bar.append(el("span", "dk-badge dk-badge--warning", "Order changed, not synced"));
      for (const gone of set.deletedPending || []) {
        const note = el("span", "dk-badge dk-badge--warning", `Deleted here, still in Relay until sync: ${gone.label || gone.type}`);
        note.dataset.deletedPending = gone.id;
        bar.append(note);
      }
      for (const [slot, state] of Object.entries(set.sponsorSync || {})) {
        if (state && state.ok === false) {
          const failed = el("span", "dk-field-error", `Sponsor doc sync failed (${slot}): ${state.error || "unknown error"}`);
          failed.dataset.sponsorSyncFailed = slot;
          bar.append(failed);
        }
      }
      return bar;
    }

    function renderSet() {
      body.replaceChildren();
      const bar = renderBar();
      const check = button("Check Relay", "secondary", "check");
      const sync = button("Sync with Relay", "primary", "sync");
      const addBtn = button("Add block", "secondary", "add");
      const report = el("div", "newsletter-blocks__report");
      const add = createAddPanel({
        dom,
        request,
        base,
        onChange: update,
        onFail: (message) => say(message, "danger"),
      });
      check.addEventListener("click", () => runSync(true, report));
      sync.addEventListener("click", () => runSync(false, report));
      addBtn.addEventListener("click", () => add.open(set));
      const actions = el("div", "newsletter-blocks__actions");
      actions.append(addBtn, check, sync);
      bar.append(actions);
      body.append(bar, add.panel, report);
      const list = el("div", "newsletter-blocks__list");
      const ctx = cardContext();
      set.blocks.forEach((block, index) => list.append(renderBlockCard(ctx, block, index, set.blocks.length)));
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
