import {
  bindCodeInput,
  describeUserCodeError,
  formatUserCode,
  normalizeUserCode,
} from "../../dakit/device-code.js";

export const NEWSLETTER_PREVIEW_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const NEWSLETTER_PREVIEW_CODE_LENGTH = 16;

function extractIssueId(pathname) {
  const match = /^\/newsletter-issues\/([^/?#]+)\/preview\/?$/.exec(String(pathname || ""));
  return match ? decodeURIComponent(match[1]) : "";
}

function formatEditedTimestamp(iso) {
  if (!iso) return "";
  return String(iso).slice(0, 16).replace("T", " ") + " UTC";
}

function formatEditorLabel(md) {
  if (!md?.updatedAt) return "No Markdown uploaded yet";
  const who = md.updatedByName || md.updatedBy || "staff";
  return `Updated ${formatEditedTimestamp(md.updatedAt)} by ${who}`;
}

export function createNewsletterPreviewPage({
  documentRef,
  request,
  locationRef,
  historyRef,
  storageRef = globalThis.sessionStorage,
  clipboardRef = globalThis.navigator?.clipboard,
}) {
  const root = documentRef.querySelector("#newsletter-preview-root");
  const identity = documentRef.querySelector("#newsletter-preview-identity");
  const live = documentRef.querySelector("#dk-live");

  let issueId = "";
  let accessCode = "";
  let previewData = null;
  let draftMarkdown = { issue: "", sources: "", brief: "" };
  let activeTab = "issue";
  let editing = false;
  let phase = "loading";
  let gateError = "";
  let feedbackMsg = "";
  let feedbackTone = "info";
  let busy = false;
  let unbindCode = null;

  const el = (tag, className, text) => {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function announce(message) {
    if (live) live.textContent = message;
  }

  function storageKey(id) {
    return `dataops:newsletter-preview-code:${id}`;
  }

  function saveStoredCode(id, codeValue) {
    if (!id || !storageRef) return;
    try {
      if (codeValue) storageRef.setItem(storageKey(id), codeValue);
      else storageRef.removeItem(storageKey(id));
    } catch {
      // Ignore storage errors
    }
  }

  function readStoredCode(id) {
    if (!id || !storageRef) return "";
    try {
      return storageRef.getItem(storageKey(id)) || "";
    } catch {
      return "";
    }
  }

  function updateIdentityBar() {
    if (!identity) return;
    identity.replaceChildren();
    if (phase === "ready" && previewData) {
      if (previewData.viewerRole === "staff") {
        identity.append(el("span", "", "DataOps Staff · Full access"));
      } else {
        identity.append(el("span", "", "Preview access · Code verified"));
        const lockBtn = el("button", "dk-button dk-button--secondary dk-button--sm", "Lock");
        lockBtn.type = "button";
        lockBtn.dataset.previewAction = "lock";
        lockBtn.addEventListener("click", () => {
          accessCode = "";
          saveStoredCode(issueId, "");
          previewData = null;
          phase = "gate";
          gateError = "";
          render();
        });
        identity.append(documentRef.createTextNode(" "), lockBtn);
      }
      return;
    }
    const signInLink = el("a", "", "Staff sign in");
    const nextPath = `/newsletter-issues/${encodeURIComponent(issueId)}/preview`;
    signInLink.href = `/login?return_to=${encodeURIComponent(nextPath)}`;
    identity.append(el("span", "", "Access code protected · "), signInLink);
  }

  async function copyText(text, successNotice) {
    try {
      await clipboardRef?.writeText?.(text);
    } catch {
      // Clipboard API fallback
    }
    feedbackMsg = successNotice;
    feedbackTone = "success";
    announce(successNotice);
    render();
  }

  async function loadPreview() {
    phase = "loading";
    render();
    try {
      const headers = accessCode ? { "x-newsletter-preview-code": accessCode } : {};
      const payload = await request(
        `/api/newsletter-issues/${encodeURIComponent(issueId)}/markdown`,
        { method: "GET", headers },
      );
      previewData = payload;
      draftMarkdown = {
        issue: payload.markdown?.issue || "",
        sources: payload.markdown?.sources || "",
        brief: payload.markdown?.brief || "",
      };
      if (
        payload.viewerRole === "staff"
        && !draftMarkdown.issue
        && !draftMarkdown.sources
        && !draftMarkdown.brief
      ) {
        editing = true;
      }
      if (accessCode) saveStoredCode(issueId, accessCode);
      gateError = "";
      phase = "ready";
      render();
    } catch (err) {
      if (err.status === 404) {
        phase = "notfound";
        render();
        return;
      }
      if (err.status === 429) {
        phase = "gate";
        gateError = `Too many failed access code attempts. Please wait ${err.retryAfter || 60} seconds and try again.`;
        render();
        return;
      }
      if (err.status === 403) {
        saveStoredCode(issueId, "");
        phase = "gate";
        gateError = "Invalid access code. Check the 16-character code from your preview link and try again.";
        render();
        return;
      }
      if (err.status === 401) {
        phase = "gate";
        gateError = "";
        render();
        return;
      }
      phase = "gate";
      gateError = err.message || "Could not load the newsletter preview.";
      render();
    }
  }

  async function saveMarkdown() {
    if (busy || !previewData) return;
    busy = true;
    feedbackMsg = "";
    render();
    try {
      const payload = await request(
        `/api/newsletter-issues/${encodeURIComponent(issueId)}/markdown`,
        {
          method: "PUT",
          body: JSON.stringify({
            issue: draftMarkdown.issue,
            sources: draftMarkdown.sources,
            brief: draftMarkdown.brief,
          }),
        },
      );
      previewData = payload;
      draftMarkdown = {
        issue: payload.markdown?.issue || "",
        sources: payload.markdown?.sources || "",
        brief: payload.markdown?.brief || "",
      };
      busy = false;
      editing = false;
      feedbackMsg = `Saved Markdown package · ${formatEditorLabel(payload.markdown)}`;
      feedbackTone = "success";
      announce(feedbackMsg);
      render();
    } catch (err) {
      busy = false;
      feedbackMsg = err.message || "Failed to save Markdown package.";
      feedbackTone = "danger";
      announce(feedbackMsg);
      render();
    }
  }

  async function rotateCode() {
    if (busy || !previewData) return;
    busy = true;
    render();
    try {
      const payload = await request(
        `/api/newsletter-issues/${encodeURIComponent(issueId)}/markdown/rotate-code`,
        { method: "POST", body: JSON.stringify({}) },
      );
      previewData = payload;
      busy = false;
      feedbackMsg = "Rotated preview access code. Previous external preview links with the old code are now invalid.";
      feedbackTone = "warning";
      announce(feedbackMsg);
      render();
    } catch (err) {
      busy = false;
      feedbackMsg = err.message || "Could not rotate preview access code.";
      feedbackTone = "danger";
      render();
    }
  }

  function renderGate() {
    const card = el("div", "dk-auth-card sponsor-doc-card");
    card.dataset.previewView = "gate";
    const head = el("header", "dk-auth-card__head");
    head.append(
      el("h1", "dk-auth-card__title", "Enter newsletter preview code"),
      el(
        "p",
        "dk-auth-card__lede",
        "Enter the 16-character access code from your DataTalks.Club preview link, or open the full link with ?code= included.",
      ),
    );
    card.append(head);

    if (gateError) {
      const alert = el("div", "dk-callout dk-callout--danger");
      alert.setAttribute("role", "alert");
      alert.dataset.previewGateError = "";
      alert.append(el("div", "dk-callout__body", gateError));
      card.append(alert);
    }

    const form = el("form", "dk-auth-card__form");
    form.noValidate = true;
    const field = el("div", "dk-field");
    const label = el("label", "dk-label", "Access code");
    label.setAttribute("for", "newsletter-preview-code-input");

    const input = el("input", "dk-code-input");
    input.id = "newsletter-preview-code-input";
    input.type = "text";
    input.autocomplete = "off";
    input.autocapitalize = "characters";
    input.spellcheck = false;
    input.placeholder = "XXXX-XXXX-XXXX-XXXX";
    input.value = formatUserCode(accessCode);

    const hint = el("p", "dk-hint", "16 characters (letters and digits, hyphens optional).");
    const errText = el("p", "dk-error");
    errText.hidden = true;

    const submitBtn = el("button", "dk-button dk-button--lg dk-button--primary", "Continue");
    submitBtn.type = "submit";
    submitBtn.dataset.previewAction = "unlock";

    const syncValidation = (result) => {
      accessCode = input.value;
      const msg = describeUserCodeError(result, {
        alphabet: NEWSLETTER_PREVIEW_CODE_ALPHABET,
        length: NEWSLETTER_PREVIEW_CODE_LENGTH,
      });
      const showError = Boolean(msg) && result.error !== "too_short";
      errText.textContent = showError ? msg : "";
      errText.hidden = !showError;
      submitBtn.disabled = !result.ok;
    };

    input.addEventListener("dk-code-change", (event) => syncValidation(event.detail));
    unbindCode = bindCodeInput(input, {
      alphabet: NEWSLETTER_PREVIEW_CODE_ALPHABET,
      length: NEWSLETTER_PREVIEW_CODE_LENGTH,
    });
    syncValidation(
      normalizeUserCode(input.value, {
        alphabet: NEWSLETTER_PREVIEW_CODE_ALPHABET,
        length: NEWSLETTER_PREVIEW_CODE_LENGTH,
      }),
    );

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const check = normalizeUserCode(input.value, {
        alphabet: NEWSLETTER_PREVIEW_CODE_ALPHABET,
        length: NEWSLETTER_PREVIEW_CODE_LENGTH,
      });
      if (!check.ok) {
        errText.textContent = describeUserCodeError(check, {
          alphabet: NEWSLETTER_PREVIEW_CODE_ALPHABET,
          length: NEWSLETTER_PREVIEW_CODE_LENGTH,
        });
        errText.hidden = false;
        return;
      }
      accessCode = check.display;
      loadPreview();
    });

    field.append(label, input, hint, errText);
    const actionsWrap = el("div", "dk-auth-card__actions");
    actionsWrap.append(submitBtn);
    form.append(field, actionsWrap);
    card.append(form);
    root.append(card);
  }

  function renderStaffEditorCard() {
    const editorCard = el("div", "sponsor-doc-card");
    editorCard.dataset.previewEditor = "";

    const titleRow = el("div", "sponsor-doc-title-row");
    titleRow.append(el("h2", "sponsor-doc-section__title", "Edit Newsletter Markdown Package"));
    editorCard.append(titleRow);

    const form = el("form", "sponsor-doc-form");
    form.noValidate = true;

    const specs = [
      { key: "issue", label: "issue.md (Email copy, Subject, Preview & frontmatter)", rows: 14 },
      { key: "brief", label: "brief.md (Editorial brief & checklist)", rows: 6 },
      { key: "sources", label: "sources.md (Sources & links checked)", rows: 6 },
    ];

    for (const spec of specs) {
      const wrap = el("div", "sponsor-doc-field");
      const top = el("div", "sponsor-doc-field__top");
      const label = el("label", "sponsor-doc-field__label", spec.label);
      const id = `newsletter-md-${spec.key}`;
      label.setAttribute("for", id);
      const count = el("span", "sponsor-doc-field__count", `${(draftMarkdown[spec.key] || "").length} chars`);
      top.append(label, count);

      const textarea = el("textarea", "sponsor-doc-textarea");
      textarea.id = id;
      textarea.rows = spec.rows;
      textarea.dataset.markdownField = spec.key;
      textarea.value = draftMarkdown[spec.key] || "";
      textarea.disabled = busy;
      textarea.addEventListener("input", () => {
        draftMarkdown[spec.key] = textarea.value;
        count.textContent = `${textarea.value.length} chars`;
      });

      wrap.append(top, textarea);
      form.append(wrap);
    }

    const actions = el("div", "sponsor-doc-actions");
    const leftBtns = el("div", "sponsor-doc-actions__buttons");
    const saveBtn = el("button", "dk-button dk-button--primary", busy ? "Saving…" : "Save Markdown package");
    saveBtn.type = "submit";
    saveBtn.dataset.previewAction = "save-markdown";
    saveBtn.disabled = busy;
    leftBtns.append(saveBtn);

    const cancelBtn = el("button", "dk-button dk-button--secondary", "Close editor");
    cancelBtn.type = "button";
    cancelBtn.dataset.previewAction = "close-editor";
    cancelBtn.disabled = busy;
    cancelBtn.addEventListener("click", () => {
      editing = false;
      render();
    });
    leftBtns.append(cancelBtn);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      saveMarkdown();
    });

    actions.append(leftBtns);
    form.append(actions);
    editorCard.append(form);
    root.append(editorCard);
  }

  function renderReady() {
    const headerCard = el("div", "sponsor-doc-card");
    headerCard.dataset.previewView = "ready";

    const headWrap = el("div", "sponsor-doc-head");
    const titleRow = el("div", "sponsor-doc-title-row");
    const sponsorList = Object.values(previewData.sponsors || {}).filter(Boolean).join(", ");
    const headingText = `${previewData.label || "Newsletter Issue"} · ${previewData.publicationDate || ""}${
      sponsorList ? ` · ${sponsorList}` : ""
    }`;
    const h1 = el("h1", "sponsor-doc-title", headingText);
    const badge = el("span", "dk-badge", previewData.status || "planned");
    titleRow.append(h1, badge);

    const metaRow = el("div", "sponsor-doc-meta");
    metaRow.append(
      el("span", "dk-badge", previewData.kind === "standalone" ? "Stand-alone" : "Weekly"),
    );
    if (previewData.publicationDate) {
      metaRow.append(el("span", "", `Send date: ${previewData.publicationDate}`));
    }
    if (previewData.publicationTime) {
      metaRow.append(el("span", "", `Time: ${previewData.publicationTime} Europe/Berlin`));
    }
    metaRow.append(el("span", "", formatEditorLabel(previewData.markdown)));
    headWrap.append(titleRow, metaRow);
    headerCard.append(headWrap);

    if (previewData.viewerRole === "staff") {
      const staffBar = el("div", "sponsor-doc-staff-bar");
      staffBar.dataset.previewStaffBar = "";
      const topRow = el("div", "sponsor-doc-staff-bar__row");
      const shareInfo = el("div", "");
      shareInfo.append(
        el("strong", "", "Shareable preview link (includes access code): "),
        el("code", "dk-mono", previewData.shareUrl || previewData.previewUrl || ""),
      );
      topRow.append(shareInfo);

      const btnRow = el("div", "sponsor-doc-actions__buttons");
      if (previewData.shareUrl) {
        const copyLinkBtn = el("button", "dk-button dk-button--secondary dk-button--sm", "Copy share link");
        copyLinkBtn.type = "button";
        copyLinkBtn.dataset.previewAction = "copy-share-url";
        copyLinkBtn.addEventListener("click", () =>
          copyText(previewData.shareUrl, "Copied shareable preview link with access code."),
        );
        btnRow.append(copyLinkBtn);
      }

      const editBtn = el(
        "button",
        "dk-button dk-button--secondary dk-button--sm",
        editing ? "Hide Markdown editor" : "Edit Markdown",
      );
      editBtn.type = "button";
      editBtn.dataset.previewAction = "toggle-edit";
      editBtn.addEventListener("click", () => {
        editing = !editing;
        render();
      });
      btnRow.append(editBtn);

      const rotateBtn = el("button", "dk-button dk-button--secondary dk-button--sm", "Rotate code");
      rotateBtn.type = "button";
      rotateBtn.dataset.previewAction = "rotate-code";
      rotateBtn.disabled = busy;
      rotateBtn.addEventListener("click", () => rotateCode());
      btnRow.append(rotateBtn);

      if (previewData.cardId) {
        const cardLink = el("a", "dk-button dk-button--secondary dk-button--sm", "Open Card");
        cardLink.href = `/cards?cardId=${encodeURIComponent(previewData.cardId)}`;
        btnRow.append(cardLink);
      }
      staffBar.append(topRow, btnRow);
      headerCard.append(staffBar);
    }

    if (feedbackMsg) {
      const fb = el("div", `dk-callout dk-callout--${feedbackTone}`);
      fb.setAttribute("role", "status");
      fb.dataset.previewFeedback = "";
      fb.append(el("div", "dk-callout__body", feedbackMsg));
      headerCard.append(fb);
    }

    root.append(headerCard);

    if (previewData.viewerRole === "staff" && editing) {
      renderStaffEditorCard();
    }

    // Rendered preview card with tabs for issue.md, brief.md, sources.md, and raw Markdown
    const previewCard = el("div", "sponsor-doc-card");
    previewCard.dataset.previewSection = "rendered";

    const tabsBar = el("div", "newsletter-preview-tabs");
    const tabDefs = [
      { id: "issue", label: "Email Preview (issue.md)" },
      { id: "brief", label: "Brief (brief.md)" },
      { id: "sources", label: "Sources (sources.md)" },
      { id: "raw", label: "Raw Markdown" },
    ];
    for (const tabDef of tabDefs) {
      const btn = el(
        "button",
        activeTab === tabDef.id
          ? "dk-button dk-button--primary dk-button--sm"
          : "dk-button dk-button--secondary dk-button--sm",
        tabDef.label,
      );
      btn.type = "button";
      btn.dataset.previewTab = tabDef.id;
      btn.addEventListener("click", () => {
        activeTab = tabDef.id;
        render();
      });
      tabsBar.append(btn);
    }
    previewCard.append(tabsBar);

    const rendered = previewData.rendered || {};
    const md = previewData.markdown || {};

    if (activeTab === "issue") {
      if (rendered.subject || rendered.previewText || Object.keys(rendered.frontmatter || {}).length > 0) {
        const env = el("div", "newsletter-envelope");
        if (rendered.subject) {
          const row = el("div", "newsletter-envelope__row");
          row.append(
            el("span", "newsletter-envelope__label", "Subject"),
            el("span", "newsletter-envelope__value", rendered.subject),
          );
          const copySubj = el("button", "dk-button dk-button--secondary dk-button--sm", "Copy subject");
          copySubj.type = "button";
          copySubj.dataset.previewAction = "copy-subject";
          copySubj.addEventListener("click", () =>
            copyText(rendered.subject, "Copied email subject line."),
          );
          row.append(copySubj);
          env.append(row);
        }
        if (rendered.previewText) {
          const row = el("div", "newsletter-envelope__row");
          row.append(
            el("span", "newsletter-envelope__label", "Preview"),
            el("span", "newsletter-envelope__value", rendered.previewText),
          );
          const copyPrev = el("button", "dk-button dk-button--secondary dk-button--sm", "Copy preview");
          copyPrev.type = "button";
          copyPrev.dataset.previewAction = "copy-preview-text";
          copyPrev.addEventListener("click", () =>
            copyText(rendered.previewText, "Copied email preview text."),
          );
          row.append(copyPrev);
          env.append(row);
        }
        const fm = rendered.frontmatter || {};
        const fmKeys = Object.keys(fm);
        if (fmKeys.length > 0) {
          const meta = el("div", "newsletter-envelope__meta");
          for (const key of fmKeys) {
            if (key === "mailchimp_campaign" && /^https?:\/\//i.test(fm[key])) {
              const link = el("a", "", "Open Mailchimp campaign →");
              link.href = fm[key];
              link.target = "_blank";
              link.rel = "noopener noreferrer";
              meta.append(link);
            } else {
              meta.append(el("span", "", `${key}: ${fm[key]}`));
            }
          }
          env.append(meta);
        }
        previewCard.append(env);
      }

      const canvas = el("article", "newsletter-email-canvas");
      canvas.dataset.previewCanvas = "issue";
      if (rendered.issueHtml) {
        canvas.innerHTML = rendered.issueHtml;
      } else {
        canvas.append(el("p", "dk-hint", "No issue.md content has been uploaded for this newsletter issue yet."));
      }
      previewCard.append(canvas);
    } else if (activeTab === "brief") {
      const canvas = el("article", "newsletter-email-canvas");
      canvas.dataset.previewCanvas = "brief";
      if (rendered.briefHtml) {
        canvas.innerHTML = rendered.briefHtml;
      } else {
        canvas.append(el("p", "dk-hint", "No brief.md content recorded."));
      }
      previewCard.append(canvas);
    } else if (activeTab === "sources") {
      const canvas = el("article", "newsletter-email-canvas");
      canvas.dataset.previewCanvas = "sources";
      if (rendered.sourcesHtml) {
        canvas.innerHTML = rendered.sourcesHtml;
      } else {
        canvas.append(el("p", "dk-hint", "No sources.md content recorded."));
      }
      previewCard.append(canvas);
    } else if (activeTab === "raw") {
      for (const kind of ["issue", "brief", "sources"]) {
        const block = el("div", "sponsor-doc-field");
        const top = el("div", "sponsor-doc-title-row");
        top.append(el("h3", "sponsor-doc-field__label", `${kind}.md`));
        const copyBtn = el("button", "dk-button dk-button--secondary dk-button--sm", `Copy ${kind}.md`);
        copyBtn.type = "button";
        copyBtn.dataset.previewAction = `copy-raw-${kind}`;
        copyBtn.addEventListener("click", () =>
          copyText(md[kind] || "", `Copied ${kind}.md to clipboard.`),
        );
        top.append(copyBtn);
        const pre = el("pre", "sponsor-doc-export-pre", md[kind] || `(empty ${kind}.md)`);
        block.append(top, pre);
        previewCard.append(block);
      }
    }

    root.append(previewCard);
  }

  function render() {
    unbindCode?.();
    unbindCode = null;
    root.replaceChildren();
    updateIdentityBar();

    if (phase === "loading") {
      const card = el("div", "dk-auth-card sponsor-doc-card");
      card.append(el("p", "dk-auth-card__lede", "Loading newsletter preview…"));
      root.append(card);
      return;
    }

    if (phase === "notfound") {
      const card = el("div", "dk-auth-card sponsor-doc-card");
      card.dataset.previewView = "notfound";
      const head = el("header", "dk-auth-card__head");
      head.append(
        el("h1", "dk-auth-card__title", "Newsletter preview not found"),
        el("p", "dk-auth-card__lede", "Check that you opened the full preview link from DataTalks.Club."),
      );
      card.append(head);
      root.append(card);
      return;
    }

    if (phase === "gate") {
      renderGate();
      return;
    }

    if (phase === "ready" && previewData) {
      renderReady();
    }
  }

  async function start() {
    const url = new URL(locationRef.href);
    issueId = extractIssueId(url.pathname);
    const queryCode = url.searchParams.get("code");
    if (queryCode !== null) {
      accessCode = formatUserCode(queryCode);
      saveStoredCode(issueId, accessCode);
      historyRef.replaceState(null, "", `/newsletter-issues/${encodeURIComponent(issueId)}/preview`);
    } else {
      accessCode = readStoredCode(issueId);
    }
    if (!issueId) {
      phase = "notfound";
      render();
      return;
    }
    await loadPreview();
  }

  function destroy() {
    unbindCode?.();
    unbindCode = null;
  }

  return { start, destroy };
}
