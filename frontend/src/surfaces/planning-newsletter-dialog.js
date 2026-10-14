import {
  createBlockEditor,
  parseMarkdownBlocks,
  serializeBlocksToMarkdown,
} from "./document-editor/block-editor.js";

export const NEWSLETTER_TEMPLATES = {
  weekly: `# DataTalks.Club Weekly

Welcome to this week's issue of the DataTalks.Club newsletter!
Here are the latest community highlights, articles, and discussions.

## 📰 Articles & Tutorials
- [Zero-dependency search in Node.js](https://datatalks.club)
- [Building production feature pipelines](https://datatalks.club)
- [Modern dbt workflow best practices](https://datatalks.club)

## 📅 Community Events & Meetups
- **Weekly Live Q&A**: Thursday at 17:00 UTC
- **Hands-on Workshop**: LLMOps in Production

## 💼 Opportunities
- **Senior Data Engineer** @ AI Startup (Remote EU)
- **Analytics Engineer** @ FinTech (Berlin / Hybrid)

> [!NOTE]
> Got feedback or a project to share? Reply directly to this email!`,

  sponsor: `> [!IMPORTANT]
> **⭐ PARTNER SPOTLIGHT: Sponsor Name**
> Scale your data stack with fast, reliable pipelines.
> Explore the developer sandbox at https://example.com`,

  events: `## 📅 Upcoming Community Events
- 🎙️ **Podcast Live Stream**: Modern analytics with special guests
- 💻 **Open Community Hours**: Friday on Slack`,

  jobs: `## 💼 Job Opportunities
- **Senior Machine Learning Engineer** (Remote)
- **Data Platform Lead** (Berlin / Hybrid)`,
};

function formatInline(escaped) {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
    );
}

export function renderMarkdownToHtml(md, escapeHtml) {
  if (!md) return "";
  const lines = String(md).split("\n");
  const renderedBlocks = [];
  let i = 0;

  while (i < lines.length) {
    if (!lines[i].trim()) {
      i++;
      continue;
    }
    const line = lines[i];

    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      const match = buf[0].match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
      if (match) {
        const type = match[1].toUpperCase();
        if (match[2].trim()) buf[0] = match[2].trim();
        else buf.shift();
        const roles = { NOTE: "info", TIP: "success", IMPORTANT: "info", WARNING: "warning", CAUTION: "danger" };
        const role = roles[type];
        const inner = buf.map((l) => formatInline(escapeHtml(l))).join("<br>");
        renderedBlocks.push(
          `<div class="newsletter-callout newsletter-callout-${type.toLowerCase()}" ` +
            `style="padding: 12px 16px; margin: 14px 0; border: 1px solid var(--dk-border-default); ` +
            `background: var(--dk-${role}-bg); color: var(--dk-${role}-text); border-radius: 6px; line-height: 1.5;"><strong>${type}</strong><br>${inner}</div>`,
        );
      } else {
        const inner = buf.map((l) => formatInline(escapeHtml(l))).join("<br>");
        renderedBlocks.push(
          `<blockquote style="margin: 12px 0; padding: 12px; ` +
            `border: 1px solid var(--dk-border-default); color: var(--dk-text-muted); font-style: italic;">${inner}</blockquote>`,
        );
      }
      continue;
    }

    const hMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (hMatch) {
      renderedBlocks.push(`<h${hMatch[1].length}>${formatInline(escapeHtml(hMatch[2]))}</h${hMatch[1].length}>`);
      i++;
      continue;
    }

    if (/^(?:---|\*\*\*|___)\s*$/.test(line)) {
      renderedBlocks.push("<hr>");
      i++;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(`<li>${formatInline(escapeHtml(lines[i].replace(/^\s*[-*]\s+/, "")))}</li>`);
        i++;
      }
      renderedBlocks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${formatInline(escapeHtml(lines[i].replace(/^\s*\d+\.\s+/, "")))}</li>`);
        i++;
      }
      renderedBlocks.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    const pLines = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^([>#-]|---|\*\*\*|\d+\.)/.test(lines[i])) {
      pLines.push(lines[i]);
      i++;
    }
    renderedBlocks.push(`<p>${pLines.map((l) => formatInline(escapeHtml(l))).join("<br>")}</p>`);
  }

  return renderedBlocks.join("\n");
}

export function renderNewsletterDialogMarkup(newsletterStatusOptions) {
  return `
    <dialog class="dk-dialog" style="--dk-dialog-width: 760px; max-width: 95vw;">
      <form method="dialog">
        <div class="dk-dialog__head newsletter-dialog-head">
          <div class="newsletter-dialog-head-title">
            <h2 data-dialog-title>Newsletter slot</h2>
            <p data-dialog-subtitle>
              Keep the publication plan, content drafting, and email preview together.
            </p>
          </div>
          <div class="dk-tabs newsletter-dialog-tabs" role="tablist" aria-label="Issue views">
            <button type="button" data-dialog-tab="details" class="dk-tab"
              role="tab" id="newsletter-tab-details"
              aria-controls="newsletter-pane-details" aria-selected="true" tabindex="0">Details</button>
            <button type="button" data-dialog-tab="compose" class="dk-tab"
              role="tab" id="newsletter-tab-compose"
              aria-controls="newsletter-pane-compose" aria-selected="false" tabindex="-1">Compose</button>
            <button type="button" data-dialog-tab="preview" class="dk-tab"
              role="tab" id="newsletter-tab-preview"
              aria-controls="newsletter-pane-preview" aria-selected="false" tabindex="-1">Email preview</button>
            <button type="button" data-dialog-tab="schedule" class="dk-tab"
              role="tab" id="newsletter-tab-schedule"
              aria-controls="newsletter-pane-schedule" aria-selected="false" tabindex="-1">Schedule &amp; checklist</button>
          </div>
        </div>
        <div class="dk-dialog__body">
          <input name="id" type="hidden">
          <input name="version" type="hidden">

          <div class="issue-pane" data-pane="details" role="tabpanel" id="newsletter-pane-details" aria-labelledby="newsletter-tab-details">
            <div class="planner-form-grid">
              <label>Publication date <input name="publicationDate" type="date" required></label>
              <label>Publication time <input name="publicationTime" type="time" placeholder="14:00" title="Time in Europe/Berlin"></label>
              <label>Campaign number <input name="campaignNumber" type="number" min="1"></label>
              <label class="planner-field-wide">
                Campaign label <input name="campaignLabel" required maxlength="200">
              </label>
              <label>Status
                <select name="status">${newsletterStatusOptions}</select>
              </label>
              <label>Booked by <input name="bookedByDisplayName" autocomplete="off"></label>
              <label class="planner-field-wide">
                Sponsor booking reference <input name="sponsorBookingId" autocomplete="off">
              </label>
              <label class="planner-field-wide">Public campaign URL <input name="publicUrl" type="url"></label>
              <label class="planner-field-wide">Planning note <textarea name="planningNote" rows="4"></textarea></label>
            </div>
          </div>

          <div class="issue-pane" data-pane="compose" role="tabpanel" id="newsletter-pane-compose" aria-labelledby="newsletter-tab-compose" hidden>
            <div class="newsletter-composer-header">
              <div class="newsletter-composer-field">
                <label for="newsletter-issue-subject">Subject Line</label>
                <input
                  id="newsletter-issue-subject"
                  name="issueSubject"
                  placeholder="e.g. DataTalks.Club Weekly: Latest Community Trends">
              </div>
              <div class="newsletter-composer-field">
                <label for="newsletter-issue-preheader">Preview Text / Preheader</label>
                <input
                  id="newsletter-issue-preheader"
                  name="issuePreheader"
                  placeholder="e.g. In this issue: Vector search benchmarks and new open-source releases.">
              </div>
              <div class="newsletter-quick-templates">
                <span>Quick insert:</span>
                <button type="button" class="newsletter-template-btn" data-insert-template="weekly">+ Weekly Template</button>
                <button type="button" class="newsletter-template-btn" data-insert-template="sponsor">+ Sponsor Spotlight</button>
                <button type="button" class="newsletter-template-btn" data-insert-template="events">+ Events Section</button>
                <button type="button" class="newsletter-template-btn" data-insert-template="jobs">+ Jobs Section</button>
              </div>
            </div>
            <div class="newsletter-blocks-wrapper" data-blocks-editor></div>
          </div>

          <div class="issue-pane" data-pane="preview" role="tabpanel" id="newsletter-pane-preview" aria-labelledby="newsletter-tab-preview" hidden>
            <div class="newsletter-preview-toolbar">
              <div class="dk-tabs dk-tabs--sm" role="radiogroup" aria-label="Preview width">
                <button type="button" class="dk-tab" role="radio" aria-checked="true" tabindex="0" data-device="desktop">Desktop <span class="dk-count">600px</span></button>
                <button type="button" class="dk-tab" role="radio" aria-checked="false" tabindex="-1" data-device="mobile">Mobile <span class="dk-count">360px</span></button>
              </div>
              <button type="button" class="newsletter-template-btn" data-copy-preview>Copy preview text</button>
            </div>
            <div class="preview-envelope">
              <div class="envelope-row">
                <span class="envelope-label">From:</span>
                <span class="envelope-value">Alexey Grigorev &lt;newsletter@datatalks.club&gt;</span>
              </div>
              <div class="envelope-row">
                <span class="envelope-label">To:</span>
                <span class="envelope-value">DataTalks.Club Subscribers (45,000+ engineers)</span>
              </div>
              <div class="envelope-row">
                <span class="envelope-label">Subject:</span>
                <strong class="envelope-value" data-preview-subject>—</strong>
              </div>
              <div class="envelope-row">
                <span class="envelope-label">Preheader:</span>
                <span class="envelope-value" data-preview-preheader style="color: var(--dk-text-muted);">—</span>
              </div>
              <div class="envelope-row">
                <span class="envelope-label">Scheduled:</span>
                <span class="envelope-value" data-preview-date>—</span>
              </div>
            </div>
            <div class="preview-email-container">
              <div class="email-sim-card" data-sim-card>
                <div class="email-sim-header">
                  <div class="email-sim-brand-banner">
                    <span class="email-sim-wordmark-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                        <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
                        <polyline points="2 17 12 22 22 17"></polyline>
                        <polyline points="2 12 12 17 22 12"></polyline>
                      </svg>
                    </span>
                    <h2 class="email-sim-brand">
                      <span>DataTalks<span class="wordmark-dot">.</span>Club</span>
                      <span class="wordmark-badge">Weekly</span>
                    </h2>
                  </div>
                  <div class="email-sim-issue-line" data-sim-issue-line>Issue</div>
                </div>
                <div class="email-sim-sponsor-banner" data-sim-sponsor hidden></div>
                <div class="email-sim-body" data-sim-body></div>
                <div class="email-sim-footer">
                  <p><strong>DataTalks.Club</strong> · The global community for data enthusiasts</p>
                  <p>
                    <a href="#">Slack</a> · <a href="#">YouTube</a> · <a href="#">Podcast</a>
                    · <a href="#">LinkedIn</a>
                  </p>
                  <p>
                    <small>
                      You received this email because you subscribed to weekly community updates.
                      <a href="#">Unsubscribe</a>
                    </small>
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div class="issue-pane" data-pane="schedule" role="tabpanel" id="newsletter-pane-schedule" aria-labelledby="newsletter-tab-schedule" hidden>
            <div class="newsletter-status-banner" data-status-banner>
              <span class="status-banner-badge" data-status-banner-badge hidden></span>
              <span class="status-banner-text" data-status-banner-text>Editorial campaign slot planned.</span>
            </div>
            <div class="newsletter-stepper">
              <div class="stepper-step is-active" data-step="1"><span class="stepper-num">1</span><span>Slot Planned</span></div>
              <div class="stepper-step" data-step="2"><span class="stepper-num">2</span><span>Draft</span></div>
              <div class="stepper-step" data-step="3"><span class="stepper-num">3</span><span>In Review</span></div>
              <div class="stepper-step" data-step="4"><span class="stepper-num">4</span><span>Scheduled</span></div>
              <div class="stepper-step" data-step="5"><span class="stepper-num">5</span><span>Sent</span></div>
            </div>

            <div class="newsletter-confirm-card" data-confirm-card hidden>
              <h4 data-confirm-title>Confirm Action</h4>
              <p data-confirm-message>Are you sure?</p>
              <div class="newsletter-confirm-buttons">
                <button type="button" class="primary-button" data-confirm-proceed>Confirm</button>
                <button type="button" class="quiet-button" data-confirm-cancel>Cancel</button>
              </div>
            </div>

            <div class="newsletter-action-bar" data-action-bar>
              <button type="button" class="newsletter-template-btn" data-action="start-draft" data-set-status="draft">Start Drafting</button>
              <button type="button" class="newsletter-template-btn" data-action="submit-review" data-set-status="review">Submit for Review</button>
              <button type="button" class="primary-button" data-action="prompt-schedule" data-set-status="scheduled">Schedule Issue</button>
              <button type="button" class="newsletter-template-btn" data-action="prompt-send" data-set-status="sent">Mark as Sent</button>
              <button type="button" class="quiet-button" data-action="return-draft">Return to Draft</button>
            </div>

            <div class="newsletter-schedule-timing">
              <h3>Schedule & Timing</h3>
              <div class="planner-form-grid">
                <label>Send date <input name="schedulePublicationDate" type="date"></label>
                <label>Send time (Europe/Berlin) <input name="schedulePublicationTime" type="time" placeholder="14:00"></label>
              </div>
              <div class="newsletter-schedule-explainer">
                <p>
                  <strong>What scheduling does:</strong>
                  Locks the editorial draft and queues the issue for automated dispatch at the selected Europe/Berlin time.
                </p>
                <p>
                  <strong>When the email goes out:</strong>
                  Subscribers receive the email promptly at the scheduled time.
                  Revisions after scheduling require returning to Draft or Review.
                </p>
              </div>
            </div>

            <div class="newsletter-checklist-box">
              <h3>Publication Readiness Checklist</h3>
              <div class="checklist-item" data-check-date><span class="check-icon">✓</span><span>Publication date chosen</span></div>
              <div class="checklist-item" data-check-time><span class="check-icon">✓</span><span>Send time set</span></div>
              <div class="checklist-item" data-check-subject><span class="check-icon">○</span><span>Subject line & preview text provided</span></div>
              <div class="checklist-item" data-check-content><span class="check-icon">○</span><span>Newsletter content drafted</span></div>
              <div class="checklist-item" data-check-sponsor><span class="check-icon">○</span><span>Sponsor deliverable context</span></div>
              <div class="checklist-item" data-check-card><span class="check-icon">○</span><span>Workflow card connected</span></div>
            </div>

            <div class="newsletter-safety-badge">
              <span>🔒</span>
              <span>Guarded environment: emails are never dispatched to real recipients in this system.</span>
            </div>
          </div>

          <p class="planner-form-error" role="alert"></p>
        </div>
        <div class="dk-dialog__foot">
          <button class="primary-button" data-save>Save issue</button>
          <button value="cancel">Cancel</button>
        </div>
      </form>
    </dialog>
  `;
}

export function setupNewsletterDialog(options) {
  const {
    surface,
    dialog,
    form,
    context,
    escapeHtml,
    renderNewsletterMarkdown,
    attachInlineEditor,
    formatShortPlanningDate,
    api,
    load,
  } = options;

  const blockEditor = createBlockEditor(context, {
    renderMarkdown: renderNewsletterMarkdown,
    attachInlineEditor,
    slashMenuItems: [{
      type: "callout",
      title: "Sponsor Spotlight",
      description: "Feature a newsletter partner.",
      shortcut: "sponsor",
      template: NEWSLETTER_TEMPLATES.sponsor,
    }],
  });

  let currentEditingItem = null;
  let currentBlocks = [];
  let currentDevice = "desktop";

  function renderBlocksEditor(focusBlockIndex = -1) {
    const editorWrap = dialog.querySelector("[data-blocks-editor]");
    if (!editorWrap) return;
    editorWrap.replaceChildren();
    if (!currentBlocks || currentBlocks.length === 0) {
      currentBlocks = [
        {
          id: `blk-0-${Date.now()}`,
          type: "paragraph",
          raw: "Welcome to this week's issue of DataTalks.Club!",
        },
      ];
    }
    const container = blockEditor.renderBlocksContainer({
      blocks: currentBlocks,
      focusBlockIndex,
      onChange: (idx, newRaw, options = {}) => {
        if (currentBlocks[idx]) {
          currentBlocks[idx] = {
            ...currentBlocks[idx], ...parseMarkdownBlocks(newRaw)[0], raw: newRaw,
          };
        }
        if (options.focusBlockIndex != null) renderBlocksEditor(options.focusBlockIndex);
      },
      onMoveBlock: (fromIdx, toIdx) => {
        const [moved] = currentBlocks.splice(fromIdx, 1);
        currentBlocks.splice(toIdx, 0, moved);
        renderBlocksEditor();
      },
      onInsertBlock: (atIdx, template) => {
        currentBlocks.splice(atIdx, 0, {
          ...(parseMarkdownBlocks(template)[0] || { type: "paragraph" }),
          id: `blk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          raw: template || "",
        });
        renderBlocksEditor(atIdx);
      },
      onDeleteBlock: (idx) => {
        currentBlocks.splice(idx, 1);
        renderBlocksEditor();
      },
    });
    editorWrap.append(container);
  }

  function updatePreviewPane() {
    const subjectInput = form?.elements?.issueSubject || dialog.querySelector('[name="issueSubject"]');
    const preheaderInput = form?.elements?.issuePreheader || dialog.querySelector('[name="issuePreheader"]');
    const labelInput = form?.elements?.campaignLabel || dialog.querySelector('[name="campaignLabel"]');
    const dateInput = form?.elements?.publicationDate || dialog.querySelector('[name="publicationDate"]');
    const timeInput = form?.elements?.publicationTime || dialog.querySelector('[name="publicationTime"]');
    const numInput = form?.elements?.campaignNumber || dialog.querySelector('[name="campaignNumber"]');
    const bookerInput = form?.elements?.bookedByDisplayName ||
      dialog.querySelector('[name="bookedByDisplayName"]');

    const subject = (subjectInput?.value || labelInput?.value || "DataTalks.Club Weekly").trim();
    const preheader = (preheaderInput?.value || "").trim();
    const dateVal = dateInput?.value || context.todayIsoDate();
    const timeVal = (timeInput?.value || "").trim();
    const numVal = numInput?.value || "";
    const booker = bookerInput?.value || "";

    const subjectEl = dialog.querySelector("[data-preview-subject]");
    const preheaderEl = dialog.querySelector("[data-preview-preheader]");
    const dateEl = dialog.querySelector("[data-preview-date]");
    const issueLineEl = dialog.querySelector("[data-sim-issue-line]");
    const sponsorEl = dialog.querySelector("[data-sim-sponsor]");
    const bodyEl = dialog.querySelector("[data-sim-body]");

    if (subjectEl) subjectEl.textContent = subject;
    if (preheaderEl) preheaderEl.textContent = preheader || "(No preview text set)";
    if (dateEl) dateEl.textContent = `${formatShortPlanningDate(dateVal)}${timeVal ? ` at ${timeVal}` : ""} (Europe/Berlin)`;
    if (issueLineEl) {
      issueLineEl.textContent = `${numVal ? `Issue #${numVal} · ` : ""}${formatShortPlanningDate(dateVal)}`;
    }

    if (sponsorEl) {
      if (booker) {
        sponsorEl.hidden = false;
        if (sponsorEl.removeAttribute) sponsorEl.removeAttribute("hidden");
        sponsorEl.innerHTML = `⭐ <strong>PARTNER SPOTLIGHT: ${escapeHtml(booker)}</strong><br>` +
          `Proud community sponsor supporting this week's issue.`;
      } else {
        sponsorEl.hidden = true;
        if (sponsorEl.setAttribute) sponsorEl.setAttribute("hidden", "");
      }
    }

    if (bodyEl) {
      const markdownBody = serializeBlocksToMarkdown(currentBlocks || []);
      bodyEl.innerHTML = renderMarkdownToHtml(markdownBody, escapeHtml);
    }
  }

  let pendingConfirmation = null;

  function updateSchedulePane() {
    const dateInput = form?.elements?.publicationDate || dialog.querySelector('[name="publicationDate"]');
    const timeInput = form?.elements?.publicationTime || dialog.querySelector('[name="publicationTime"]');
    const schedDateInput = form?.elements?.schedulePublicationDate || dialog.querySelector('[name="schedulePublicationDate"]');
    const schedTimeInput = form?.elements?.schedulePublicationTime || dialog.querySelector('[name="schedulePublicationTime"]');
    const labelInput = form?.elements?.campaignLabel || dialog.querySelector('[name="campaignLabel"]');
    const subjectInput = form?.elements?.issueSubject || dialog.querySelector('[name="issueSubject"]');
    const statusSelect = form?.elements?.status || dialog.querySelector('[name="status"]');
    const linkedCard = currentEditingItem?.card || null;
    const bookerInput = form?.elements?.bookedByDisplayName ||
      dialog.querySelector('[name="bookedByDisplayName"]');

    // Keep schedule timing inputs synced with form values
    if (schedDateInput && dateInput) {
      if (dateInput.value && !schedDateInput.value) schedDateInput.value = dateInput.value;
      else if (schedDateInput.value && !dateInput.value) dateInput.value = schedDateInput.value;
    }
    if (schedTimeInput && timeInput) {
      if (timeInput.value && !schedTimeInput.value) schedTimeInput.value = timeInput.value;
      else if (!schedTimeInput.value && !timeInput.value) {
        schedTimeInput.value = "14:00";
        timeInput.value = "14:00";
      }
    }

    const hasDate = Boolean(dateInput?.value || schedDateInput?.value);
    const timeVal = (timeInput?.value || schedTimeInput?.value || "14:00").trim();
    const hasTime = Boolean(timeVal);
    const subjectText = (subjectInput?.value || labelInput?.value || "").trim();
    const hasSubject = Boolean(subjectText);
    const hasContent = (currentBlocks || []).some((b) => b.raw && b.raw.trim().length > 0);
    const statusVal = statusSelect?.value || "open";
    const hasCard = Boolean(linkedCard);
    const isReserved = statusVal === "reserved" || Boolean(bookerInput?.value);
    const hasBooker = Boolean(bookerInput?.value);

    const checkDate = dialog.querySelector("[data-check-date]");
    const checkTime = dialog.querySelector("[data-check-time]");
    const checkSubject = dialog.querySelector("[data-check-subject]");
    const checkContent = dialog.querySelector("[data-check-content]");
    const checkSponsor = dialog.querySelector("[data-check-sponsor]");
    const checkCard = dialog.querySelector("[data-check-card]");

    const setCheck = (el, ready, readyText, pendingText) => {
      if (!el) return;
      el.className = `checklist-item ${ready ? "is-ready" : "is-pending"}`;
      const icon = el.querySelector(".check-icon");
      if (icon) icon.textContent = ready ? "✓" : "○";
      const label = el.querySelector("span:last-child");
      if (label) label.textContent = ready ? readyText : pendingText;
    };

    const dateVal = dateInput?.value || schedDateInput?.value || "";
    setCheck(checkDate, hasDate, `Publication date chosen: ${formatShortPlanningDate(dateVal)}`, "Choose publication date");
    setCheck(checkTime, hasTime, `Send time: ${timeVal} (Europe/Berlin)`, "Set send time in Europe/Berlin");
    setCheck(checkSubject, hasSubject, `Subject line ready: "${subjectText.slice(0, 30)}…"`, "Provide subject line & title");
    setCheck(checkContent, hasContent, `Content drafted (${currentBlocks.length} blocks)`, "Draft newsletter content");
    setCheck(
      checkSponsor,
      !isReserved || hasBooker,
      isReserved ? `Sponsor confirmed: ${bookerInput?.value || ""}` : "Open editorial / sponsor slot",
      "Confirm sponsor booking context",
    );
    setCheck(checkCard, hasCard, `Card linked: ${linkedCard?.title || ""}`, "Create or link a card from the slot row (optional)");

    const stepIdx = {
      open: 1, reserved: 1, draft: 2, drafting: 2, review: 3, scheduled: 4, sent: 5, cancelled: 0,
    }[statusVal] || 1;

    dialog.querySelectorAll(".stepper-step").forEach((stepEl) => {
      const num = Number(stepEl.dataset.step);
      stepEl.classList.toggle("is-done", num < stepIdx);
      stepEl.classList.toggle("is-active", num === stepIdx);
    });

    // Update status banner
    const bannerEl = dialog.querySelector("[data-status-banner]");
    const bannerBadge = dialog.querySelector("[data-status-banner-badge]");
    const bannerText = dialog.querySelector("[data-status-banner-text]");
    if (bannerEl && bannerBadge && bannerText) {
      bannerEl.className = "newsletter-status-banner";
      if (statusVal === "drafting" || statusVal === "draft") {
        bannerEl.classList.add("is-draft");
        bannerBadge.hidden = false;
        bannerBadge.style.display = "";
        bannerBadge.textContent = "Draft";
        bannerText.textContent = "Content drafting is in progress. Edits can be made in Compose.";
      } else if (statusVal === "review") {
        bannerEl.classList.add("is-review");
        bannerBadge.hidden = false;
        bannerBadge.style.display = "";
        bannerBadge.textContent = "In Review";
        bannerText.textContent = "Editorial review underway. Check readiness before scheduling.";
      } else if (statusVal === "scheduled") {
        bannerEl.classList.add("is-scheduled");
        bannerBadge.hidden = false;
        bannerBadge.style.display = "";
        bannerBadge.textContent = "Scheduled";
        bannerText.textContent =
          `Scheduled for automated dispatch on ${formatShortPlanningDate(dateVal)} at ${timeVal} (Europe/Berlin).`;
      } else if (statusVal === "sent") {
        bannerEl.classList.add("is-sent");
        bannerBadge.hidden = false;
        bannerBadge.style.display = "";
        bannerBadge.textContent = "Sent";
        bannerText.textContent = "Issue published and marked sent. Publication archived.";
      } else {
        bannerEl.classList.add("is-open");
        if (isReserved) {
          bannerBadge.hidden = false;
          bannerBadge.style.display = "";
          bannerBadge.textContent = "Reserved";
          bannerText.textContent = "Slot reserved for sponsor booking.";
        } else {
          bannerBadge.hidden = true;
          bannerBadge.style.display = "none";
          bannerText.textContent = "Editorial campaign slot planned.";
        }
      }
    }

    // Update action buttons and confirmation card visibility
    const startDraftBtn = dialog.querySelector('[data-action="start-draft"]');
    const submitReviewBtn = dialog.querySelector('[data-action="submit-review"]');
    const promptScheduleBtn = dialog.querySelector('[data-action="prompt-schedule"]');
    const promptSendBtn = dialog.querySelector('[data-action="prompt-send"]');
    const returnDraftBtn = dialog.querySelector('[data-action="return-draft"]');
    const actionBar = dialog.querySelector("[data-action-bar]");
    const confirmCard = dialog.querySelector("[data-confirm-card]");

    if (confirmCard) {
      confirmCard.hidden = !pendingConfirmation;
      if (pendingConfirmation) {
        if (confirmCard.removeAttribute) confirmCard.removeAttribute("hidden");
      } else {
        if (confirmCard.setAttribute) confirmCard.setAttribute("hidden", "");
      }
      if (actionBar) {
        actionBar.hidden = Boolean(pendingConfirmation);
        if (pendingConfirmation) {
          if (actionBar.setAttribute) actionBar.setAttribute("hidden", "");
        } else {
          if (actionBar.removeAttribute) actionBar.removeAttribute("hidden");
        }
      }
    }

    const setVisible = (el, show) => {
      if (!el) return;
      el.hidden = !show;
      if (show) {
        if (el.removeAttribute) el.removeAttribute("hidden");
      } else {
        if (el.setAttribute) el.setAttribute("hidden", "");
      }
      if (el.style) el.style.display = show ? "" : "none";
    };

    const actionMap = {
      open: [true, false, false, false, false],
      reserved: [true, false, false, false, false],
      draft: [false, true, true, false, false],
      drafting: [false, true, true, false, false],
      review: [false, false, true, true, true],
      scheduled: [false, false, false, true, true],
      sent: [false, false, false, false, false],
    };
    const [canDraft, canReview, canSchedule, canSend, canReturn] =
      actionMap[statusVal] || actionMap.open;

    setVisible(startDraftBtn, canDraft);
    setVisible(submitReviewBtn, canReview);
    setVisible(promptScheduleBtn, canSchedule);
    setVisible(promptSendBtn, canSend);
    setVisible(returnDraftBtn, canReturn);
    if (returnDraftBtn && canReturn) {
      returnDraftBtn.textContent = statusVal === "scheduled"
        ? "Unschedule (Return to Draft)"
        : "Return to Draft";
    }
  }

  function switchDialogTab(tabName) {
    blockEditor.slashMenu.close();
    dialog.querySelectorAll("[data-dialog-tab]").forEach((btn) => {
      const selected = btn.dataset.dialogTab === tabName;
      btn.setAttribute("aria-selected", selected ? "true" : "false");
      btn.tabIndex = selected ? 0 : -1;
    });
    dialog.querySelectorAll("[data-pane]").forEach((pane) => {
      const match = pane.dataset.pane === tabName;
      pane.hidden = !match;
      if (match) {
        if (pane.removeAttribute) pane.removeAttribute("hidden");
      } else {
        if (pane.setAttribute) pane.setAttribute("hidden", "");
      }
    });
    const titleEl = dialog.querySelector("[data-dialog-title]");
    const subEl = dialog.querySelector("[data-dialog-subtitle]");
    if (tabName === "compose") {
      if (titleEl) titleEl.textContent = "Compose Issue";
      if (subEl) subEl.textContent = "Draft newsletter content using blocks, headings, lists, and callouts.";
      renderBlocksEditor();
    } else if (tabName === "preview") {
      if (titleEl) titleEl.textContent = "Email Preview";
      if (subEl) subEl.textContent = "Simulated newsletter rendering for desktop and mobile subscribers.";
      updatePreviewPane();
    } else if (tabName === "schedule") {
      if (titleEl) titleEl.textContent = "Schedule & Checklist";
      if (subEl) subEl.textContent = "Verify publication readiness and set send time in Europe/Berlin.";
      updateSchedulePane();
    } else {
      if (titleEl) titleEl.textContent = "Newsletter slot";
      if (subEl) subEl.textContent = "Keep the publication plan and booking context together.";
    }
  }

  function openIssueDialog(item, initialTab = "details") {
    currentEditingItem = item || null;
    pendingConfirmation = null;
    form.reset();
    form.querySelector('[role="alert"]').textContent = "";

    if (item) {
      for (const key of Object.keys(item)) {
        if (form.elements[key]) form.elements[key].value = item[key] || "";
      }
    }

    if (form.elements.publicationTime) {
      form.elements.publicationTime.value = item?.publicationTime || "14:00";
    }
    const schedDate = dialog.querySelector('[name="schedulePublicationDate"]');
    const schedTime = dialog.querySelector('[name="schedulePublicationTime"]');
    if (schedDate) schedDate.value = item?.publicationDate || "";
    if (schedTime) schedTime.value = item?.publicationTime || "14:00";

    const draftKey = item ? `dataops-newsletter-draft-${item.id}` : null;
    const storedDraft = (draftKey && typeof localStorage !== "undefined")
      ? localStorage.getItem(draftKey)
      : null;
    let rawDraft = storedDraft || item?.planningNote || "";

    let subject = item?.campaignLabel || "";
    let preheader = "";
    if (rawDraft.startsWith("# Subject: ")) {
      const lines = rawDraft.split("\n");
      subject = lines[0].replace("# Subject: ", "").trim();
      rawDraft = lines.slice(1).join("\n").trim();
      if (rawDraft.startsWith("> Preheader: ")) {
        const subLines = rawDraft.split("\n");
        preheader = subLines[0].replace("> Preheader: ", "").trim();
        rawDraft = subLines.slice(1).join("\n").trim();
      }
    }

    const subjectInput = form?.elements?.issueSubject || dialog.querySelector('[name="issueSubject"]');
    const preheaderInput = form?.elements?.issuePreheader || dialog.querySelector('[name="issuePreheader"]');
    if (subjectInput) subjectInput.value = subject;
    if (preheaderInput) preheaderInput.value = preheader;

    currentBlocks = parseMarkdownBlocks(rawDraft);
    if (currentBlocks.length === 0 && item?.campaignLabel) {
      currentBlocks = [
        {
          id: `blk-0-${Date.now()}`,
          type: "paragraph",
          raw: "Welcome to this week's newsletter!",
        },
      ];
    }

    switchDialogTab(initialTab);
    if (dialog.showModal) {
      dialog.showModal();
    }
  }

  dialog.querySelectorAll("[data-dialog-tab]").forEach((btn) => {
    btn.onclick = () => switchDialogTab(btn.dataset.dialogTab);
  });

  dialog.querySelectorAll("[data-insert-template]").forEach((btn) => {
    btn.onclick = () => {
      const tplKey = btn.dataset.insertTemplate;
      let tplText = NEWSLETTER_TEMPLATES[tplKey];
      if (!tplText) return;
      if (tplKey === "sponsor") {
        const bookerInput = form?.elements?.bookedByDisplayName || dialog.querySelector('[name="bookedByDisplayName"]');
        const booker = (bookerInput?.value || currentEditingItem?.bookedByDisplayName || "").trim();
        const sponsorName = booker || "Featured Partner";
        tplText = tplText.replace(/Sponsor Name/g, sponsorName);
      }
      const newBlocks = parseMarkdownBlocks(tplText);
      currentBlocks = [...(currentBlocks || []), ...newBlocks];
      renderBlocksEditor();
    };
  });

  dialog.querySelectorAll("[data-device]").forEach((btn) => {
    btn.onclick = () => {
      const device = btn.dataset.device;
      currentDevice = device;
      dialog.querySelectorAll("[data-device]").forEach((b) => {
        b.setAttribute("aria-checked", b === btn ? "true" : "false");
        b.tabIndex = b === btn ? 0 : -1;
      });
      const card = dialog.querySelector("[data-sim-card]");
      if (card) {
        card.classList.toggle("is-mobile", device === "mobile");
      }
    };
  });

  // Schedule timing inputs change sync
  const schedDateInput = dialog.querySelector('[name="schedulePublicationDate"]');
  const schedTimeInput = dialog.querySelector('[name="schedulePublicationTime"]');
  if (schedDateInput) {
    schedDateInput.oninput = () => {
      if (form.elements.publicationDate) form.elements.publicationDate.value = schedDateInput.value;
      updateSchedulePane();
      updatePreviewPane();
    };
  }
  if (schedTimeInput) {
    schedTimeInput.oninput = () => {
      if (form.elements.publicationTime) form.elements.publicationTime.value = schedTimeInput.value;
      updateSchedulePane();
      updatePreviewPane();
    };
  }

  // Action button clicks
  dialog.querySelectorAll("[data-action]").forEach((btn) => {
    btn.onclick = () => {
      const action = btn.dataset.action;
      const statusSelect = form.elements.status;
      const dateInput = form.elements.publicationDate;
      const timeInput = form.elements.publicationTime || dialog.querySelector('[name="publicationTime"]');
      const subjectInput = form.elements.issueSubject || dialog.querySelector('[name="issueSubject"]');
      const labelInput = form.elements.campaignLabel || dialog.querySelector('[name="campaignLabel"]');
      const subjectText = (subjectInput?.value || labelInput?.value || "").trim();
      const hasDate = Boolean(dateInput?.value || schedDateInput?.value);
      const hasSubject = Boolean(subjectText);
      const hasContent = (currentBlocks || []).some((b) => b.raw && b.raw.trim().length > 0);
      const timeVal = (timeInput?.value || schedTimeInput?.value || "14:00").trim();
      const alertEl = form.querySelector('[role="alert"]');

      if (action === "start-draft") {
        if (statusSelect) statusSelect.value = "draft";
        updateSchedulePane();
      } else if (action === "submit-review") {
        if (statusSelect) statusSelect.value = "review";
        updateSchedulePane();
      } else if (action === "return-draft") {
        if (statusSelect) statusSelect.value = "draft";
        updateSchedulePane();
      } else if (action === "prompt-schedule") {
        if (!hasDate || !hasSubject || !hasContent) {
          if (alertEl) {
            alertEl.textContent = "Cannot schedule: Publication date, subject line, and draft content are required.";
          }
          return;
        }
        if (alertEl) alertEl.textContent = "";
        pendingConfirmation = "schedule";
        const titleEl = dialog.querySelector("[data-confirm-title]");
        const msgEl = dialog.querySelector("[data-confirm-message]");
        const schedDateVal = dateInput?.value || schedDateInput?.value;
        const schedTimeDisplay = `${formatShortPlanningDate(schedDateVal)} at ${escapeHtml(timeVal)} Europe/Berlin`;
        if (msgEl) {
          msgEl.innerHTML =
            `Schedule <strong>${escapeHtml(subjectText)}</strong> for automated dispatch on ` +
            `<strong>${schedTimeDisplay}</strong>?<br>` +
            `<small style="color: var(--dk-text-muted);">` +
            `Content is reviewed and locked for publication. Real emails are never sent in this environment.` +
            `</small>`;
        }
        updateSchedulePane();
      } else if (action === "prompt-send") {
        if (alertEl) alertEl.textContent = "";
        pendingConfirmation = "send";
        const titleEl = dialog.querySelector("[data-confirm-title]");
        const msgEl = dialog.querySelector("[data-confirm-message]");
        if (titleEl) titleEl.textContent = "Confirm Mark as Sent";
        if (msgEl) {
          msgEl.innerHTML =
            `Mark <strong>${escapeHtml(subjectText)}</strong> as sent? ` +
            `This marks publication as complete and moves the issue to Sent & Archive.`;
        }
        updateSchedulePane();
      }
    };
  });

  const confirmProceedBtn = dialog.querySelector("[data-confirm-proceed]");
  if (confirmProceedBtn) {
    confirmProceedBtn.onclick = () => {
      const statusSelect = form.elements.status;
      if (pendingConfirmation === "schedule") {
        if (statusSelect) statusSelect.value = "scheduled";
        if (form.elements.publicationTime && schedTimeInput?.value) {
          form.elements.publicationTime.value = schedTimeInput.value;
        }
        if (form.elements.publicationDate && schedDateInput?.value) {
          form.elements.publicationDate.value = schedDateInput.value;
        }
      } else if (pendingConfirmation === "send") {
        if (statusSelect) statusSelect.value = "sent";
      }
      pendingConfirmation = null;
      updateSchedulePane();
    };
  }

  const confirmCancelBtn = dialog.querySelector("[data-confirm-cancel]");
  if (confirmCancelBtn) {
    confirmCancelBtn.onclick = () => {
      pendingConfirmation = null;
      updateSchedulePane();
    };
  }

  dialog.querySelectorAll("[data-set-status]").forEach((btn) => {
    btn.onclick = () => {
      const nextStatus = btn.dataset.setStatus;
      const select = form.elements.status;
      if (select) {
        select.value = nextStatus;
        updateSchedulePane();
      }
    };
  });

  const copyBtn = dialog.querySelector("[data-copy-preview]");
  if (copyBtn) {
    copyBtn.onclick = () => {
      const fullMarkdown = serializeBlocksToMarkdown(currentBlocks || []);
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        navigator.clipboard.writeText(fullMarkdown).catch(() => {});
      }
      copyBtn.textContent = "Copied!";
      setTimeout(() => {
        copyBtn.textContent = "Copy preview text";
      }, 1500);
    };
  }

  const saveBtn = (surface && surface.querySelector("[data-save]")) ||
    dialog.querySelector("[data-save]");
  if (saveBtn) {
    saveBtn.onclick = async (event) => {
      event.preventDefault();
      form.querySelector('[role="alert"]').textContent = "";
      const value = Object.fromEntries(
        [...new FormData(form)].filter(
          ([k, v]) =>
            v !== "" &&
            k !== "issueSubject" &&
            k !== "issuePreheader" &&
            k !== "schedulePublicationDate" &&
            k !== "schedulePublicationTime",
        ),
      );
      const id = value.id;
      delete value.id;
      if (value.version) value.version = Number(value.version);
      if (value.campaignNumber) {
        value.campaignNumber = Number(value.campaignNumber);
      }

      const subjectInput = dialog.querySelector('[name="issueSubject"]');
      const preheaderInput = dialog.querySelector('[name="issuePreheader"]');
      const fullMarkdown = serializeBlocksToMarkdown(currentBlocks || []);
      const draftWithHeaders = `# Subject: ${subjectInput?.value || value.campaignLabel || ""}\n` +
        `> Preheader: ${preheaderInput?.value || ""}\n\n${fullMarkdown}`;

      if (id && typeof localStorage !== "undefined") {
        try {
          localStorage.setItem(`dataops-newsletter-draft-${id}`, draftWithHeaders);
        } catch {}
      }

      if (typeof value.planningNote === "string" && value.planningNote.length > 900) {
        value.planningNote = `${value.planningNote.slice(0, 890)}…`;
      }

      try {
        await api(id ? `/${id}` : "", {
          method: id ? "PUT" : "POST",
          body: JSON.stringify(value),
        });
        dialog.close();
        await load();
      } catch (error) {
        form.querySelector('[role="alert"]').textContent =
          `Could not save slot: ${error.message}`;
      }
    };
  }

  return {
    openIssueDialog,
    renderBlocksEditor,
    updatePreviewPane,
    updateSchedulePane,
    switchDialogTab,
  };
}
