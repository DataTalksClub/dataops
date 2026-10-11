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

export function renderMarkdownToHtml(md, escapeHtml) {
  if (!md) return "";
  let html = escapeHtml(md);
  html = html.replace(/^### (.*$)/gim, "<h3>$1</h3>");
  html = html.replace(/^## (.*$)/gim, "<h2>$1</h2>");
  html = html.replace(/^# (.*$)/gim, "<h1>$1</h1>");
  html = html.replace(
    /^>\s?\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*$)/gim,
    '<div style="padding: 10px 14px; margin: 12px 0;' +
      ' border-left: 4px solid var(--dk-primary, #3b82f6);' +
      ' background: #f8fafc; border-radius: 4px;"><strong>$1</strong>: $2</div>',
  );
  html = html.replace(
    /^>\s?(.*$)/gim,
    '<blockquote style="margin: 12px 0; padding-left: 12px;' +
      ' border-left: 3px solid #cbd5e1; color: #64748b;">$1</blockquote>',
  );
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer"' +
      ' style="color: #2563eb; text-decoration: underline;">$1</a>',
  );
  html = html.replace(/^\s*[-*]\s+(.*$)/gim, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>(\n|$)(\s*))+/g, "<ul>$&</ul>");
  html = html.replace(/^---$/gim, "<hr>");
  const paragraphs = html.split(/\n{2,}/);
  return paragraphs
    .map((p) => {
      const trimmed = p.trim();
      if (!trimmed) return "";
      if (/^<(h[1-6]|ul|ol|div|blockquote|hr)/.test(trimmed)) return trimmed;
      return `<p>${trimmed.replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");
}

export function renderNewsletterDialogMarkup(newsletterStatusOptions) {
  return `
    <dialog class="dk-dialog" style="--dk-dialog-width: 760px; max-width: 95vw;">
      <form method="dialog">
        <div class="dk-dialog__head">
          <div>
            <h2 data-dialog-title>Newsletter slot</h2>
            <p data-dialog-subtitle>
              Keep the publication plan, content drafting, and email preview together.
            </p>
          </div>
          <nav class="newsletter-dialog-tabs" aria-label="Issue tabs">
            <button type="button" data-dialog-tab="details" class="dialog-tab-btn" aria-pressed="true">
              Details
            </button>
            <button type="button" data-dialog-tab="compose" class="dialog-tab-btn" aria-pressed="false">
              Compose
            </button>
            <button type="button" data-dialog-tab="preview" class="dialog-tab-btn" aria-pressed="false">
              Email Preview
            </button>
            <button type="button" data-dialog-tab="schedule" class="dialog-tab-btn" aria-pressed="false">
              Schedule & Checklist
            </button>
          </nav>
        </div>
        <div class="dk-dialog__body">
          <input name="id" type="hidden">
          <input name="version" type="hidden">

          <div class="issue-pane" data-pane="details">
            <div class="planner-form-grid">
              <label>Publication date <input name="publicationDate" type="date" required></label>
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
              <label class="planner-field-wide">Card reference <input name="cardId" autocomplete="off"></label>
              <label class="planner-field-wide">Public campaign URL <input name="publicUrl" type="url"></label>
              <label class="planner-field-wide">Planning note <textarea name="planningNote" rows="4"></textarea></label>
            </div>
          </div>

          <div class="issue-pane" data-pane="compose" hidden>
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
                <button type="button" class="newsletter-template-btn" data-insert-template="weekly">
                  + Weekly Template
                </button>
                <button type="button" class="newsletter-template-btn" data-insert-template="sponsor">
                  + Sponsor Spotlight
                </button>
                <button type="button" class="newsletter-template-btn" data-insert-template="events">
                  + Events Section
                </button>
                <button type="button" class="newsletter-template-btn" data-insert-template="jobs">
                  + Jobs Section
                </button>
              </div>
            </div>
            <div class="newsletter-blocks-wrapper" data-blocks-editor></div>
          </div>

          <div class="issue-pane" data-pane="preview" hidden>
            <div class="newsletter-preview-toolbar">
              <div class="preview-device-toggle">
                <button type="button" class="preview-device-btn is-active" data-device="desktop">
                  Desktop (600px)
                </button>
                <button type="button" class="preview-device-btn" data-device="mobile">
                  Mobile (360px)
                </button>
              </div>
              <button type="button" class="newsletter-template-btn" data-copy-preview>
                Copy preview text
              </button>
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
                  <h2 class="email-sim-brand">DataTalks.Club Weekly</h2>
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

          <div class="issue-pane" data-pane="schedule" hidden>
            <div class="newsletter-stepper">
              <div class="stepper-step is-done" data-step="1">
                <span class="stepper-num">1</span>
                <span>Slot Planned</span>
              </div>
              <div class="stepper-step" data-step="2">
                <span class="stepper-num">2</span>
                <span>Drafting</span>
              </div>
              <div class="stepper-step" data-step="3">
                <span class="stepper-num">3</span>
                <span>In Review</span>
              </div>
              <div class="stepper-step" data-step="4">
                <span class="stepper-num">4</span>
                <span>Scheduled</span>
              </div>
              <div class="stepper-step" data-step="5">
                <span class="stepper-num">5</span>
                <span>Sent</span>
              </div>
            </div>
            <div class="newsletter-checklist-box">
              <h3>Publication Readiness Checklist</h3>
              <div class="checklist-item" data-check-date>
                <span class="check-icon">✓</span>
                <span>Publication date chosen</span>
              </div>
              <div class="checklist-item" data-check-subject>
                <span class="check-icon">○</span>
                <span>Subject line & preview text provided</span>
              </div>
              <div class="checklist-item" data-check-content>
                <span class="check-icon">○</span>
                <span>Newsletter content drafted</span>
              </div>
              <div class="checklist-item" data-check-sponsor>
                <span class="check-icon">○</span>
                <span>Sponsor deliverable context</span>
              </div>
              <div class="checklist-item" data-check-card>
                <span class="check-icon">○</span>
                <span>Workflow card connected</span>
              </div>
            </div>
            <div class="newsletter-action-bar">
              <button type="button" class="newsletter-template-btn" data-set-status="drafting">
                Set Status: Drafting
              </button>
              <button type="button" class="newsletter-template-btn" data-set-status="scheduled">
                Set Status: Scheduled
              </button>
              <button type="button" class="newsletter-template-btn" data-set-status="sent">
                Mark as Sent
              </button>
            </div>
            <div class="newsletter-safety-badge">
              <span>🔒</span>
              <span>Guarded environment: emails are never dispatched to real recipients in this system.</span>
            </div>
          </div>

          <p class="planner-form-error" role="alert"></p>
        </div>
        <div class="dk-dialog__foot">
          <button class="primary-button" data-save>Save slot</button>
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
  });

  let currentEditingItem = null;
  let currentBlocks = [];
  let currentDevice = "desktop";

  function renderBlocksEditor() {
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
      onChange: (idx, newRaw) => {
        if (currentBlocks[idx]) currentBlocks[idx].raw = newRaw;
      },
      onMoveBlock: (fromIdx, toIdx) => {
        const [moved] = currentBlocks.splice(fromIdx, 1);
        currentBlocks.splice(toIdx, 0, moved);
        renderBlocksEditor();
      },
      onInsertBlock: (atIdx, template) => {
        currentBlocks.splice(atIdx, 0, {
          id: `blk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: "paragraph",
          raw: template || "",
        });
        renderBlocksEditor();
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
    const numInput = form?.elements?.campaignNumber || dialog.querySelector('[name="campaignNumber"]');
    const bookerInput = form?.elements?.bookedByDisplayName ||
      dialog.querySelector('[name="bookedByDisplayName"]');

    const subject = (subjectInput?.value || labelInput?.value || "DataTalks.Club Weekly").trim();
    const preheader = (preheaderInput?.value || "").trim();
    const dateVal = dateInput?.value || context.todayIsoDate();
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
    if (dateEl) dateEl.textContent = `${formatShortPlanningDate(dateVal)} (Europe/Berlin)`;
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

  function updateSchedulePane() {
    const dateInput = form?.elements?.publicationDate || dialog.querySelector('[name="publicationDate"]');
    const labelInput = form?.elements?.campaignLabel || dialog.querySelector('[name="campaignLabel"]');
    const subjectInput = form?.elements?.issueSubject || dialog.querySelector('[name="issueSubject"]');
    const statusSelect = form?.elements?.status || dialog.querySelector('[name="status"]');
    const cardInput = form?.elements?.cardId || dialog.querySelector('[name="cardId"]');
    const bookerInput = form?.elements?.bookedByDisplayName ||
      dialog.querySelector('[name="bookedByDisplayName"]');

    const hasDate = Boolean(dateInput?.value);
    const hasSubject = Boolean((subjectInput?.value || labelInput?.value || "").trim());
    const hasContent = (currentBlocks || []).length > 0;
    const statusVal = statusSelect?.value || "open";
    const hasCard = Boolean(cardInput?.value);
    const isReserved = statusVal === "reserved";
    const hasBooker = Boolean(bookerInput?.value);

    const checkDate = dialog.querySelector("[data-check-date]");
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

    setCheck(
      checkDate,
      hasDate,
      `Publication date chosen: ${dateInput?.value || ""}`,
      "Choose publication date",
    );
    setCheck(
      checkSubject,
      hasSubject,
      `Subject line ready: "${(subjectInput?.value || labelInput?.value || "").slice(0, 30)}…"`,
      "Provide subject line & title",
    );
    setCheck(
      checkContent,
      hasContent,
      `Content drafted (${currentBlocks.length} blocks)`,
      "Draft newsletter content",
    );
    setCheck(
      checkSponsor,
      !isReserved || hasBooker,
      isReserved ? `Sponsor confirmed: ${bookerInput?.value || ""}` : "Open editorial / sponsor slot",
      "Confirm sponsor booking context",
    );
    setCheck(
      checkCard,
      hasCard,
      `Workflow card linked: ${cardInput?.value || ""}`,
      "Connect workflow card (optional)",
    );

    const stepIdx = {
      open: 1,
      reserved: 1,
      drafting: 2,
      review: 3,
      scheduled: 4,
      sent: 5,
      cancelled: 0,
    }[statusVal] || 1;

    dialog.querySelectorAll(".stepper-step").forEach((stepEl) => {
      const num = Number(stepEl.dataset.step);
      stepEl.classList.remove("is-active", "is-done");
      if (num < stepIdx) stepEl.classList.add("is-done");
      else if (num === stepIdx) stepEl.classList.add("is-active");
    });
  }

  function switchDialogTab(tabName) {
    dialog.querySelectorAll("[data-dialog-tab]").forEach((btn) => {
      btn.setAttribute("aria-pressed", btn.dataset.dialogTab === tabName ? "true" : "false");
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
    form.reset();
    form.querySelector('[role="alert"]').textContent = "";

    if (item) {
      for (const key of Object.keys(item)) {
        if (form.elements[key]) form.elements[key].value = item[key] || "";
      }
    }

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
      const tplText = NEWSLETTER_TEMPLATES[tplKey];
      if (!tplText) return;
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
        b.classList.toggle("is-active", b === btn);
      });
      const card = dialog.querySelector("[data-sim-card]");
      if (card) {
        card.classList.toggle("is-mobile", device === "mobile");
      }
    };
  });

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
          ([k, v]) => v !== "" && k !== "issueSubject" && k !== "issuePreheader",
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
