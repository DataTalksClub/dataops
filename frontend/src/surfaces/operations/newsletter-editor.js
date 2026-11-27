// The newsletter email editor on the issue page (/newsletter/<issueId>).
//
// Two panes, like a newsletter builder: on the left the email's subject and
// inbox preview, the ordered list of blocks (each opens into its own form) and
// "Add block" with a block-type picker; on the right a live preview of the
// whole email, re-rendered by DataOps from the unsaved form state as you type.
// "View full email" opens the review page with the exact rendered email and
// the owner's approval. Everything is stored in DataOps only; nothing is
// imported from or written to Relay here. Ids, history and delete sit in
// collapsed "More" / "Details" disclosures, away from the primary surface.

import { collectFields, createDom, failureText, fieldControl, formatWhen } from "./newsletter-editor-dom.js";

const enc = encodeURIComponent;
const APPROVAL_TEXT = {
  current: "Approved",
  stale: "Approval out of date",
  none: "Not approved",
};

/** One-line summary of a block for its collapsed row. */
function blockSummary(block) {
  const data = block.data || {};
  const text = data.title || data.summary || data.issue_label || data.events || data.links || data.html || "";
  return String(text).split("\n")[0].slice(0, 90);
}

export function createNewsletterEditor({
  documentRef,
  request,
  workApiUrl,
  confirmFn,
  setTimeoutFn = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeoutFn = (id) => globalThis.clearTimeout(id),
  previewDelayMs = 400,
}) {
  const dom = createDom(documentRef);
  const { el, button } = dom;
  const confirmUser = confirmFn || ((message) => globalThis.confirm(message));

  async function mount(container, issueId) {
    const base = workApiUrl(`/api/newsletter-issues/${enc(issueId)}/draft`);
    const section = el("section", "newsletter-editor");
    section.dataset.newsletterEditor = "";
    section.setAttribute("aria-labelledby", "newsletter-editor-title");
    const head = el("div", "newsletter-editor__head");
    const heading = el("h2", "newsletter-editor__title", "Email");
    heading.id = "newsletter-editor-title";
    const badge = el("span", "dk-badge");
    badge.dataset.approvalState = "";
    badge.hidden = true;
    const fullLink = el("a", "dk-button dk-button--sm dk-button--secondary", "View full email");
    fullLink.href = `/newsletter-issues/${enc(issueId)}/preview`;
    fullLink.target = "_blank";
    fullLink.rel = "noreferrer";
    fullLink.dataset.fullEmailLink = "";
    fullLink.hidden = true;
    head.append(heading, badge, fullLink);
    const status = el("p", "newsletter-editor__status");
    status.setAttribute("role", "status");
    status.dataset.editorStatus = "";
    const body = el("div", "newsletter-editor__body");
    section.append(head, status, body);
    container.append(section);

    let draft = null;
    let types = null;
    let openId = "";
    let pickerOpen = false;
    let previewTimer = null;
    let previewSeq = 0;
    let frame = null;
    let envelopeLines = null;
    let lastPreview = null;

    function say(message, tone = "info") {
      status.textContent = message;
      status.dataset.tone = tone;
    }

    function setDraft(next, message, tone = "success") {
      const hadApproval = draft?.approval?.state === "current";
      draft = next;
      render();
      if (message) {
        const withdrawn = hadApproval && draft.approval?.state !== "current" ? " The owner's approval was withdrawn; review again before sending." : "";
        say(`${message}${withdrawn}`, tone);
      }
      schedulePreview(0);
    }

    // ------------------------------------------------------------ live preview

    function editorState() {
      const envelope = section.querySelector("[data-envelope-form]");
      const subject = envelope?.querySelector('[name="subject"]')?.value ?? draft.subject;
      const previewText = envelope?.querySelector('[name="previewText"]')?.value ?? draft.previewText;
      const blocks = draft.blocks.map((block) => {
        const form = section.querySelector(`[data-block-form="${block.id}"]`);
        return { id: block.id, type: block.type, data: form && !block.readOnly ? collectFields(form) : block.data };
      });
      return { subject, previewText, blocks };
    }

    function schedulePreview(delay = previewDelayMs) {
      if (!draft || !frame) return;
      if (previewTimer) clearTimeoutFn(previewTimer);
      previewTimer = setTimeoutFn(refreshPreview, delay);
    }

    /** Put the latest rendered preview into the (possibly just rebuilt) pane. */
    function showPreview() {
      if (!lastPreview || !frame) return;
      frame.srcdoc = lastPreview.html;
      frame.dataset.previewState = "ready";
      envelopeLines.subject.textContent = lastPreview.subject || "(no subject yet)";
      envelopeLines.preview.textContent = lastPreview.previewText || "(no preview text yet)";
    }

    async function refreshPreview() {
      previewTimer = null;
      if (!draft || !frame) return;
      const seq = (previewSeq += 1);
      const state = editorState();
      try {
        const result = await request(`${base}/preview`, { method: "POST", body: JSON.stringify(state) });
        if (seq !== previewSeq) return;
        lastPreview = result.preview;
        showPreview();
      } catch (error) {
        if (seq !== previewSeq) return;
        frame.dataset.previewState = "failed";
        say(`Preview unavailable: ${error.message}`, "danger");
      }
    }

    // ------------------------------------------------------------ pieces

    function renderStart() {
      body.replaceChildren();
      const panel = el("div", "dk-card newsletter-editor__start");
      panel.dataset.startPanel = "";
      panel.append(
        el("p", "", "This issue has no email draft yet. Start it here and build it block by block; nothing is imported from anywhere."),
      );
      const start = button("Start the draft", "primary", "start-draft");
      start.dataset.startDraft = "";
      start.addEventListener("click", async () => {
        start.disabled = true;
        say("Starting the draft…");
        try {
          const result = await request(base, { method: "POST", body: "{}" });
          const staged = (result.sponsorStaging || []).filter((item) => item.status === "ok").length;
          setDraft(result.draft, staged ? `Draft started; the sponsor document was added.` : "Draft started. Add blocks on the left.");
        } catch (error) {
          start.disabled = false;
          say(`Could not start the draft: ${error.message}`, "danger");
        }
      });
      panel.append(start);
      body.append(panel);
    }

    function renderEnvelope() {
      const form = el("form", "dk-card newsletter-editor__envelope");
      form.dataset.envelopeForm = "";
      const subject = fieldControl(dom, { name: "subject", label: "Subject", kind: "text", required: true, default: "" }, draft.subject);
      const preview = fieldControl(dom, { name: "previewText", label: "Inbox preview text", kind: "text", required: false, default: "" }, draft.previewText);
      const save = button("Save subject", "secondary", "save-envelope");
      save.type = "submit";
      save.disabled = draft.locked;
      form.append(subject, preview, save);
      for (const input of [subject, preview].map((wrap) => wrap.querySelector("[data-block-field]"))) {
        input.disabled = draft.locked;
        input.addEventListener("input", () => schedulePreview());
      }
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        save.disabled = true;
        try {
          const fields = collectFields(form);
          const result = await request(base, { method: "PUT", body: JSON.stringify({ version: draft.version, subject: fields.subject, previewText: fields.previewText }) });
          setDraft(result.draft, result.changed ? "Subject saved." : "Subject unchanged.");
        } catch (error) {
          save.disabled = false;
          say(failureText(error), "danger");
        }
      });
      return form;
    }

    async function loadHistory(target, blockId = "") {
      target.replaceChildren(el("p", "dk-hint", "Loading history…"));
      try {
        const result = await request(`${base}/revisions${blockId ? `?block=${enc(blockId)}` : ""}`);
        target.replaceChildren();
        const list = el("ol", "newsletter-editor__history");
        list.dataset.history = "";
        for (const rev of [...result.revisions].reverse()) {
          const fields = (rev.changes || []).map((change) => change.field).join(", ");
          const who = rev.origin.startsWith("relay") || rev.origin === "import" ? `Relay (${rev.relayActor || "archived"})` : rev.actorName || "?";
          const parts = [formatWhen(rev.createdAt), rev.origin, rev.label || "", who, fields, rev.detail || ""].filter(Boolean);
          list.append(el("li", "", parts.join(" · ")));
        }
        target.append(result.revisions.length ? list : el("p", "dk-hint", "No history yet."));
      } catch (error) {
        target.replaceChildren(el("p", "dk-field-error", `History unavailable: ${error.message}`));
      }
    }

    async function guarded(run, failurePrefix = "") {
      try {
        await run();
      } catch (error) {
        say(`${failurePrefix}${failureText(error)}`, "danger");
      }
    }

    function renderBlock(block, index) {
      const item = el("li", "dk-card newsletter-editor__block");
      item.dataset.blockId = block.id;
      if (block.problems?.length) item.dataset.incomplete = "";
      const row = el("div", "newsletter-editor__block-row");
      const toggle = el("button", "newsletter-editor__block-toggle");
      toggle.type = "button";
      toggle.dataset.blockToggle = block.id;
      toggle.setAttribute("aria-expanded", String(openId === block.id));
      toggle.append(el("strong", "", block.label), el("span", "newsletter-editor__snippet", blockSummary(block) || "Empty"));
      if (block.problems?.length) {
        const warn = el("span", "dk-badge dk-badge--warning", "Needs content");
        warn.dataset.blockProblems = "";
        toggle.append(warn);
      }
      if (block.sponsor && block.sponsorDocUrl) toggle.append(el("span", "dk-badge", "From sponsor doc"));
      toggle.addEventListener("click", () => {
        openId = openId === block.id ? "" : block.id;
        render();
      });
      const up = button("↑", "secondary", "up");
      const down = button("↓", "secondary", "down");
      up.setAttribute("aria-label", `Move ${block.label} up`);
      down.setAttribute("aria-label", `Move ${block.label} down`);
      up.disabled = !block.canMove || index === 0;
      down.disabled = !block.canMove || index === draft.blocks.length - 1;
      const move = (direction) => guarded(async () => {
        const result = await request(`${base}/blocks/${enc(block.id)}/move`, { method: "POST", body: JSON.stringify({ direction }) });
        setDraft(result.draft, `Moved ${block.label} ${direction}.`);
      });
      up.addEventListener("click", () => move("up"));
      down.addEventListener("click", () => move("down"));
      row.append(toggle, up, down);
      item.append(row);
      if (openId !== block.id) return item;

      const form = el("form", "newsletter-editor__block-form");
      form.dataset.blockForm = block.id;
      if (block.problems?.length) {
        const problems = el("ul", "newsletter-editor__problems");
        for (const problem of block.problems) problems.append(el("li", "", problem));
        form.append(problems);
      }
      if (block.readOnly) {
        const values = el("dl", "newsletter-editor__values");
        values.dataset.blockReadonly = "";
        for (const field of block.fields || []) {
          if (block.data?.[field.name]) values.append(el("dt", "", field.label), el("dd", "", block.data[field.name]));
        }
        form.append(values);
        if (block.sponsorDocUrl) {
          form.append(el("p", "dk-hint", "This sponsor block comes from the slot's sponsor document; every doc save updates it here."));
          const link = el("a", "dk-link", "Edit in sponsor doc");
          link.href = block.sponsorDocUrl;
          link.target = "_blank";
          link.rel = "noreferrer";
          link.dataset.sponsorDocLink = "";
          form.append(link);
        }
      } else {
        for (const field of block.fields || []) {
          const control = fieldControl(dom, field, block.data?.[field.name]);
          control.querySelector("[data-block-field]").addEventListener("input", () => schedulePreview());
          form.append(control);
        }
        const save = button("Save block", "primary", "save");
        save.type = "submit";
        form.append(save);
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          save.disabled = true;
          try {
            const result = await request(`${base}/blocks/${enc(block.id)}`, { method: "PUT", body: JSON.stringify({ version: block.version, data: collectFields(form) }) });
            setDraft(result.draft, result.changed ? `Saved ${block.label}.` : `${block.label}: no changes.`);
          } catch (error) {
            save.disabled = false;
            say(failureText(error), "danger");
          }
        });
      }
      const more = el("details", "newsletter-editor__more");
      more.dataset.blockMore = "";
      more.append(el("summary", "", "More"));
      const changed = block.updatedByName ? ` · last change ${block.updatedByName}, ${formatWhen(block.updatedAt)}` : "";
      more.append(el("p", "dk-hint dk-mono", `${block.type} · ${block.id} · v${block.version}${changed}`));
      const history = el("div", "");
      const historyButton = button("History", "secondary", "history");
      historyButton.addEventListener("click", () => loadHistory(history, block.id));
      more.append(historyButton);
      if (block.canDelete) {
        const remove = button("Delete block", "danger", "delete");
        remove.addEventListener("click", () => guarded(async () => {
          if (!confirmUser(`Delete "${block.label}" from this draft?`)) return;
          const result = await request(`${base}/blocks/${enc(block.id)}`, { method: "DELETE" });
          if (openId === block.id) openId = "";
          setDraft(result.draft, `Deleted ${block.label}.`);
        }));
        more.append(remove);
      }
      more.append(history);
      form.append(more);
      item.append(form);
      return item;
    }

    async function renderPicker(target) {
      target.replaceChildren(el("p", "dk-hint", "Loading block types…"));
      try {
        types ||= (await request(`${base}/types`)).types;
      } catch (error) {
        target.replaceChildren(el("p", "dk-field-error", `Block types unavailable: ${error.message}`));
        return;
      }
      target.replaceChildren();
      const grid = el("div", "newsletter-editor__picker");
      grid.dataset.blockPicker = "";
      grid.setAttribute("role", "group");
      grid.setAttribute("aria-label", "Block type");
      for (const type of types) {
        // Sponsor blocks are never offered: they come only from the slot's sponsor document.
        if (!type.addable) continue;
        const choice = button(type.label, "secondary", "pick");
        choice.dataset.blockType = type.type;
        choice.addEventListener("click", () => guarded(async () => {
          const result = await request(`${base}/blocks`, { method: "POST", body: JSON.stringify({ type: type.type }) });
          pickerOpen = false;
          openId = result.block.id;
          setDraft(result.draft, `Added ${type.label}. Fill it in on the left; the preview follows as you type.`);
        }));
        grid.append(choice);
      }
      target.append(grid);
    }

    function renderDetails() {
      const details = el("details", "newsletter-editor__details");
      details.dataset.editorDetails = "";
      details.append(el("summary", "", "Details and history"));
      const facts = el("dl", "newsletter-editor__facts");
      const fact = (label, value) => facts.append(el("dt", "", label), el("dd", "dk-mono", value));
      fact("Issue", draft.issueId);
      fact("Draft version", String(draft.version));
      fact("Payload sha256", draft.payloadHash);
      fact("Browser view", draft.webViewUrl);
      const approval = draft.approval || {};
      if (approval.approvedAt) {
        fact("Approved", [approval.approvedByName || approval.approvedBy, formatWhen(approval.approvedAt), `v${approval.draftVersion}`].join(" · "));
      }
      const delivery = draft.delivery;
      if (delivery) {
        fact("Relay", [delivery.state, delivery.campaignKey, formatWhen(delivery.scheduledAt), delivery.relayStatus].filter(Boolean).join(" · "));
      }
      const history = el("div", "");
      const historyButton = button("Load history", "secondary", "draft-history");
      historyButton.addEventListener("click", () => loadHistory(history));
      details.append(facts, historyButton, history);
      return details;
    }

    function render() {
      body.replaceChildren();
      badge.hidden = false;
      const state = draft.approval?.state || "none";
      badge.textContent = APPROVAL_TEXT[state] || state;
      badge.className = `dk-badge ${state === "current" ? "dk-badge--success" : state === "stale" ? "dk-badge--warning" : ""}`.trim();
      badge.dataset.approvalState = state;
      fullLink.hidden = false;

      const panes = el("div", "newsletter-editor__panes");
      const left = el("div", "newsletter-editor__left");
      left.dataset.editorLeft = "";
      if (draft.locked) {
        const when = formatWhen(draft.delivery?.scheduledAt);
        const lock = el("p", "newsletter-editor__locked", `Scheduled in Relay for ${when}. The draft is locked; cancel the schedule on the full email page to edit it.`);
        lock.dataset.draftLocked = "";
        left.append(lock);
      }
      for (const [slot, sync] of Object.entries(draft.sponsorSync || {})) {
        if (sync && sync.ok === false) {
          const failed = el("p", "dk-field-error", `Sponsor doc (${slot}) was not added: ${sync.error || "unknown error"}`);
          failed.dataset.sponsorSyncFailed = slot;
          left.append(failed);
        }
      }
      left.append(renderEnvelope());
      const list = el("ol", "newsletter-editor__blocks");
      list.dataset.blockList = "";
      draft.blocks.forEach((block, index) => list.append(renderBlock(block, index)));
      left.append(list);
      if (!draft.locked) {
        const add = button(pickerOpen ? "Close block types" : "Add block", "primary", "add");
        add.dataset.addBlock = "";
        const pickerBox = el("div", "newsletter-editor__add");
        add.addEventListener("click", () => {
          pickerOpen = !pickerOpen;
          add.textContent = pickerOpen ? "Close block types" : "Add block";
          if (pickerOpen) renderPicker(pickerBox);
          else pickerBox.replaceChildren();
        });
        if (pickerOpen) renderPicker(pickerBox);
        left.append(add, pickerBox);
      }

      const right = el("div", "newsletter-editor__right");
      right.dataset.editorRight = "";
      const envelope = el("dl", "newsletter-editor__envelope-preview");
      const subjectLine = el("dd", "", draft.subject || "(no subject yet)");
      const previewLine = el("dd", "", draft.previewText || "(no preview text yet)");
      envelope.append(el("dt", "", "Subject"), subjectLine, el("dt", "", "Preview"), previewLine);
      envelopeLines = { subject: subjectLine, preview: previewLine };
      frame = el("iframe", "newsletter-editor__frame");
      frame.title = "Live email preview";
      frame.setAttribute("sandbox", "");
      frame.dataset.livePreview = "";
      frame.dataset.previewState = "loading";
      if (draft.problems?.length) {
        const things = `${draft.problems.length} thing${draft.problems.length === 1 ? "" : "s"}`;
        const count = el("p", "dk-hint", `${things} to finish before the owner can approve: ${draft.problems.map((p) => p.message).join(" ")}`);
        count.dataset.draftProblems = "";
        right.append(count);
      }
      right.append(el("h3", "newsletter-editor__pane-title", "Live preview"), envelope, frame);
      panes.append(left, right);
      body.append(panes, renderDetails());
      // Opening or closing a block rebuilds the panes: keep showing the last preview.
      showPreview();
    }

    say("Loading the email draft…");
    try {
      draft = (await request(base)).draft;
      say("");
      render();
      schedulePreview(0);
    } catch (error) {
      if (error.code === "draft_missing") {
        say("");
        renderStart();
      } else {
        say(`Email draft unavailable: ${error.message}`, "danger");
      }
    }
    return section;
  }

  return { mount };
}
