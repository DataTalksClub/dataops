import {
  bindCodeInput,
  describeUserCodeError,
  formatUserCode,
  normalizeUserCode,
} from "../../dakit/device-code.js";

export const SPONSOR_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";
export const SPONSOR_CODE_LENGTH = 16;

function extractDocId(pathname) {
  const match = /^\/sponsor-docs\/([^/?#]+)/.exec(String(pathname || ""));
  return match ? decodeURIComponent(match[1]) : "";
}

function formatEditedTimestamp(iso) {
  if (!iso) return "";
  return String(iso).slice(0, 16).replace("T", " ") + " UTC";
}

function formatEditorLabel(doc) {
  if (!doc?.lastEditedAt) return "Not edited yet";
  const who = doc.lastEditedBy === "staff"
    ? (doc.lastEditedByName ? `staff (${doc.lastEditedByName})` : "staff")
    : "sponsor";
  return `Last edited ${formatEditedTimestamp(doc.lastEditedAt)} by ${who}`;
}

export function createSponsorDocPage({
  documentRef,
  request,
  locationRef,
  historyRef,
  storageRef = globalThis.sessionStorage,
  clipboardRef = globalThis.navigator?.clipboard,
}) {
  const root = documentRef.querySelector("#sponsor-doc-root");
  const identity = documentRef.querySelector("#sponsor-doc-identity");
  const live = documentRef.querySelector("#dk-live");

  let docId = "";
  let accessCode = "";
  let doc = null;
  let draftContent = {};
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
    return `dataops:sponsor-doc-code:${id}`;
  }

  function saveStoredCode(id, codeValue) {
    if (!id || !storageRef) return;
    try {
      if (codeValue) storageRef.setItem(storageKey(id), codeValue);
      else storageRef.removeItem(storageKey(id));
    } catch {
      // Ignore storage quota / privacy mode errors
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
    if (phase === "editor" && doc) {
      if (doc.viewerRole === "staff") {
        identity.append(el("span", "", "DataOps Staff · Full access"));
      } else {
        identity.append(el("span", "", "Sponsor access · Code verified"));
        const lockBtn = el("button", "dk-button dk-button--secondary dk-button--sm", "Lock");
        lockBtn.type = "button";
        lockBtn.dataset.sponsorAction = "lock";
        lockBtn.addEventListener("click", () => {
          accessCode = "";
          saveStoredCode(docId, "");
          doc = null;
          phase = "gate";
          gateError = "";
          render();
        });
        identity.append(documentRef.createTextNode(" "), lockBtn);
      }
      return;
    }
    const signInLink = el("a", "", "Staff sign in");
    const nextPath = `/sponsor-docs/${encodeURIComponent(docId)}`;
    signInLink.href = `/login?return_to=${encodeURIComponent(nextPath)}`;
    identity.append(el("span", "", "Access code protected · "), signInLink);
  }

  async function copyText(text, successNotice) {
    try {
      await clipboardRef?.writeText?.(text);
    } catch {
      // Fallback no-op when clipboard API is unavailable
    }
    feedbackMsg = successNotice;
    feedbackTone = "success";
    announce(successNotice);
    render();
  }

  async function loadDoc() {
    phase = "loading";
    render();
    try {
      const headers = accessCode ? { "x-sponsor-doc-code": accessCode } : {};
      const payload = await request(`/api/sponsor-docs/${encodeURIComponent(docId)}`, {
        method: "GET",
        headers,
      });
      doc = payload.doc;
      draftContent = { ...(doc.content || {}) };
      if (accessCode) saveStoredCode(docId, accessCode);
      gateError = "";
      phase = "editor";
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
        saveStoredCode(docId, "");
        phase = "gate";
        gateError = "Invalid access code. Check the 16-character code from your email and try again.";
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
      gateError = err.message || "Could not load the sponsor document.";
      render();
    }
  }

  async function saveChanges(nextStatus) {
    if (busy || !doc) return;
    busy = true;
    feedbackMsg = "";
    render();
    try {
      const headers = accessCode ? { "x-sponsor-doc-code": accessCode } : {};
      const body = { content: { ...draftContent } };
      if (nextStatus) body.status = nextStatus;
      const payload = await request(`/api/sponsor-docs/${encodeURIComponent(docId)}`, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      });
      doc = payload.doc;
      draftContent = { ...(doc.content || {}) };
      busy = false;
      if (nextStatus === "submitted") {
        feedbackMsg = "Submitted and marked ready for DataTalks.Club review.";
        feedbackTone = "success";
      } else if (nextStatus === "draft") {
        feedbackMsg = "Reopened as draft.";
        feedbackTone = "info";
      } else {
        feedbackMsg = `Saved draft · ${formatEditorLabel(doc)}`;
        feedbackTone = "success";
      }
      announce(feedbackMsg);
      render();
    } catch (err) {
      busy = false;
      feedbackMsg = err.message || "Failed to save changes.";
      feedbackTone = "danger";
      announce(feedbackMsg);
      render();
    }
  }

  async function rotateStaffCode() {
    if (busy || !doc) return;
    busy = true;
    render();
    try {
      const payload = await request(`/api/sponsor-docs/${encodeURIComponent(docId)}/rotate-code`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      doc = payload.doc;
      busy = false;
      feedbackMsg = "Rotated access code. Previous sponsor links with the old code are now invalid.";
      feedbackTone = "warning";
      announce(feedbackMsg);
      render();
    } catch (err) {
      busy = false;
      feedbackMsg = err.message || "Could not rotate access code.";
      feedbackTone = "danger";
      render();
    }
  }

  function renderGate() {
    const card = el("div", "dk-auth-card sponsor-doc-card");
    card.dataset.sponsorView = "gate";
    const head = el("header", "dk-auth-card__head");
    const title = el("h1", "dk-auth-card__title", "Enter sponsor access code");
    const lede = el(
      "p",
      "dk-auth-card__lede",
      "Enter the 16-character access code from your DataTalks.Club sponsorship email, or open the full link with ?code= included.",
    );
    head.append(title, lede);
    card.append(head);

    if (gateError) {
      const alert = el("div", "dk-callout dk-callout--danger");
      alert.setAttribute("role", "alert");
      alert.dataset.sponsorGateError = "";
      const alertBody = el("div", "dk-callout__body", gateError);
      alert.append(alertBody);
      card.append(alert);
    }

    const form = el("form", "dk-auth-card__form");
    form.noValidate = true;
    const field = el("div", "dk-field");
    const label = el("label", "dk-label", "Access code");
    label.setAttribute("for", "sponsor-doc-code-input");

    const input = el("input", "dk-code-input");
    input.id = "sponsor-doc-code-input";
    input.type = "text";
    input.autocomplete = "off";
    input.autocapitalize = "characters";
    input.spellcheck = false;
    input.placeholder = "XXXX-XXXX-XXXX-XXXX";
    input.value = formatUserCode(accessCode);

    const hint = el("p", "dk-hint", "16 characters (letters and digits, hyphens optional).");
    hint.id = "sponsor-doc-code-hint";
    const errText = el("p", "dk-error");
    errText.id = "sponsor-doc-code-error";
    errText.hidden = true;

    const submitBtn = el("button", "dk-button dk-button--lg dk-button--primary", "Continue");
    submitBtn.type = "submit";
    submitBtn.dataset.sponsorAction = "unlock";

    const syncValidation = (result) => {
      accessCode = input.value;
      const msg = describeUserCodeError(result, {
        alphabet: SPONSOR_CODE_ALPHABET,
        length: SPONSOR_CODE_LENGTH,
      });
      const showError = Boolean(msg) && result.error !== "too_short";
      errText.textContent = showError ? msg : "";
      errText.hidden = !showError;
      submitBtn.disabled = !result.ok;
    };

    input.addEventListener("dk-code-change", (event) => syncValidation(event.detail));
    unbindCode = bindCodeInput(input, {
      alphabet: SPONSOR_CODE_ALPHABET,
      length: SPONSOR_CODE_LENGTH,
    });
    syncValidation(
      normalizeUserCode(input.value, {
        alphabet: SPONSOR_CODE_ALPHABET,
        length: SPONSOR_CODE_LENGTH,
      }),
    );

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const check = normalizeUserCode(input.value, {
        alphabet: SPONSOR_CODE_ALPHABET,
        length: SPONSOR_CODE_LENGTH,
      });
      if (!check.ok) {
        errText.textContent = describeUserCodeError(check, {
          alphabet: SPONSOR_CODE_ALPHABET,
          length: SPONSOR_CODE_LENGTH,
        });
        errText.hidden = false;
        return;
      }
      accessCode = check.display;
      loadDoc();
    });

    field.append(label, input, hint, errText);
    const actionsWrap = el("div", "dk-auth-card__actions");
    actionsWrap.append(submitBtn);
    form.append(field, actionsWrap);
    card.append(form);
    root.append(card);
  }

  function renderEditor() {
    const tDef = doc.templateDefinition || { label: doc.template, fields: [], guidelines: [] };
    const isSubmitted = doc.status === "submitted";

    // 1. Header & guidelines card
    const headerCard = el("div", "sponsor-doc-card");
    headerCard.dataset.sponsorView = "editor";

    const headWrap = el("div", "sponsor-doc-head");
    const titleRow = el("div", "sponsor-doc-title-row");
    const h1 = el("h1", "sponsor-doc-title", doc.title || "Sponsorship Document");
    const badge = el(
      "span",
      isSubmitted ? "dk-badge dk-badge--success" : "dk-badge",
      isSubmitted ? "Submitted / Ready" : "Draft",
    );
    badge.dataset.sponsorDocStatus = doc.status;
    titleRow.append(h1, badge);

    const metaRow = el("div", "sponsor-doc-meta");
    metaRow.append(el("span", "dk-badge", tDef.label || doc.template));
    if (doc.publicationDate) {
      metaRow.append(el("span", "", `Publication date: ${doc.publicationDate}`));
    }
    if (doc.sponsorName) {
      metaRow.append(el("span", "", `Sponsor: ${doc.sponsorName}`));
    }
    const editedSpan = el("span", "", formatEditorLabel(doc));
    editedSpan.dataset.sponsorDocLastEdited = "";
    metaRow.append(editedSpan);

    headWrap.append(titleRow, metaRow);
    headerCard.append(headWrap);

    if (doc.viewerRole === "staff") {
      const staffBar = el("div", "sponsor-doc-staff-bar");
      staffBar.dataset.sponsorStaffBar = "";
      const topRow = el("div", "sponsor-doc-staff-bar__row");
      const shareInfo = el("div", "");
      shareInfo.append(
        el("strong", "", "Shareable sponsor link (includes access code): "),
        el("code", "dk-mono", doc.shareUrl || doc.docUrl || ""),
      );
      topRow.append(shareInfo);

      const btnRow = el("div", "sponsor-doc-actions__buttons");
      if (doc.shareUrl) {
        const copyLinkBtn = el("button", "dk-button dk-button--secondary dk-button--sm", "Copy share link");
        copyLinkBtn.type = "button";
        copyLinkBtn.dataset.sponsorAction = "copy-share-url";
        copyLinkBtn.addEventListener("click", () =>
          copyText(doc.shareUrl, "Copied shareable sponsor link with access code."),
        );
        btnRow.append(copyLinkBtn);
      }
      if (doc.emailDraft?.body) {
        const copyEmailBtn = el("button", "dk-button dk-button--secondary dk-button--sm", "Copy sponsor email");
        copyEmailBtn.type = "button";
        copyEmailBtn.dataset.sponsorAction = "copy-email";
        copyEmailBtn.addEventListener("click", () =>
          copyText(
            `Subject: ${doc.emailDraft.subject}\n\n${doc.emailDraft.body}`,
            "Copied ready-to-send sponsor email draft.",
          ),
        );
        btnRow.append(copyEmailBtn);
      }
      const rotateBtn = el("button", "dk-button dk-button--secondary dk-button--sm", "Rotate code");
      rotateBtn.type = "button";
      rotateBtn.dataset.sponsorAction = "rotate-code";
      rotateBtn.disabled = busy;
      rotateBtn.addEventListener("click", () => rotateStaffCode());
      btnRow.append(rotateBtn);

      if (doc.cardId) {
        const cardLink = el("a", "dk-button dk-button--secondary dk-button--sm", "Open Card");
        cardLink.href = `/cards?cardId=${encodeURIComponent(doc.cardId)}`;
        btnRow.append(cardLink);
      }
      staffBar.append(topRow, btnRow);
      headerCard.append(staffBar);
    }

    if (tDef.intro || (Array.isArray(tDef.guidelines) && tDef.guidelines.length > 0)) {
      const callout = el("div", "dk-callout");
      const body = el("div", "dk-callout__body");
      if (tDef.intro) {
        body.append(el("p", "", tDef.intro));
      }
      if (Array.isArray(tDef.guidelines) && tDef.guidelines.length > 0) {
        const ul = el("ul", "sponsor-doc-guidelines");
        for (const item of tDef.guidelines) {
          ul.append(el("li", "", item));
        }
        body.append(ul);
      }
      callout.append(body);
      headerCard.append(callout);
    }

    root.append(headerCard);

    // 2. Editor form card
    const formCard = el("div", "sponsor-doc-card");
    const form = el("form", "sponsor-doc-form");
    form.noValidate = true;

    for (const fieldDef of tDef.fields || []) {
      const fieldWrap = el("div", "sponsor-doc-field");
      const top = el("div", "sponsor-doc-field__top");
      const label = el(
        "label",
        "sponsor-doc-field__label",
        `${fieldDef.label}${fieldDef.required ? " *" : ""}`,
      );
      const inputId = `sponsor-field-${fieldDef.key}`;
      label.setAttribute("for", inputId);

      const countEl = el("span", "sponsor-doc-field__count");
      const updateCount = (val) => {
        const len = String(val || "").length;
        if (fieldDef.maxChars) {
          countEl.textContent = `${len} / ${fieldDef.maxChars} chars`;
          countEl.classList.toggle("is-over", len > fieldDef.maxChars);
        } else {
          countEl.textContent = `${len} chars`;
        }
      };

      const currentVal = String(draftContent[fieldDef.key] ?? "");
      updateCount(currentVal);
      top.append(label, countEl);

      let control;
      if (fieldDef.multiline) {
        control = el("textarea", "sponsor-doc-textarea");
        control.rows = 6;
      } else {
        control = el("input", "dk-input");
        control.type = "text";
      }
      control.id = inputId;
      control.dataset.sponsorField = fieldDef.key;
      control.placeholder = fieldDef.placeholder || "";
      control.value = currentVal;
      control.disabled = busy;
      control.addEventListener("input", () => {
        draftContent[fieldDef.key] = control.value;
        updateCount(control.value);
      });

      fieldWrap.append(top, control);
      if (fieldDef.helpText) {
        fieldWrap.append(el("p", "dk-hint", fieldDef.helpText));
      }
      form.append(fieldWrap);
    }

    if (feedbackMsg) {
      const fb = el("div", `dk-callout dk-callout--${feedbackTone}`);
      fb.setAttribute("role", "status");
      fb.dataset.sponsorFeedback = "";
      fb.append(el("div", "dk-callout__body", feedbackMsg));
      form.append(fb);
    }

    const actionsBar = el("div", "sponsor-doc-actions");
    const leftBtns = el("div", "sponsor-doc-actions__buttons");
    const rightBtns = el("div", "sponsor-doc-actions__buttons");

    const draftBtn = el(
      "button",
      "dk-button dk-button--secondary",
      busy ? "Saving…" : isSubmitted ? "Save changes" : "Save draft",
    );
    draftBtn.type = "button";
    draftBtn.dataset.sponsorAction = "save-draft";
    draftBtn.disabled = busy;
    draftBtn.addEventListener("click", () => saveChanges(undefined));
    leftBtns.append(draftBtn);

    if (isSubmitted) {
      const reopenBtn = el("button", "dk-button dk-button--secondary", "Reopen as Draft");
      reopenBtn.type = "button";
      reopenBtn.dataset.sponsorAction = "reopen-draft";
      reopenBtn.disabled = busy;
      reopenBtn.addEventListener("click", () => saveChanges("draft"));
      rightBtns.append(reopenBtn);
    } else {
      const submitReadyBtn = el(
        "button",
        "dk-button dk-button--primary",
        busy ? "Submitting…" : "Mark as Submitted / Ready",
      );
      submitReadyBtn.type = "button";
      submitReadyBtn.dataset.sponsorAction = "submit-ready";
      submitReadyBtn.disabled = busy;
      submitReadyBtn.addEventListener("click", () => saveChanges("submitted"));
      rightBtns.append(submitReadyBtn);
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      saveChanges(undefined);
    });

    actionsBar.append(leftBtns, rightBtns);
    form.append(actionsBar);
    formCard.append(form);
    root.append(formCard);

    // 3. Read-only Newsletter Markdown Export card
    if (doc.markdownExport) {
      const exportCard = el("div", "sponsor-doc-card");
      exportCard.dataset.sponsorExport = "";
      const expTop = el("div", "sponsor-doc-title-row");
      expTop.append(el("h2", "sponsor-doc-field__label", "Read-only Markdown export"));
      const copyExportBtn = el("button", "dk-button dk-button--secondary dk-button--sm", "Copy Markdown");
      copyExportBtn.type = "button";
      copyExportBtn.dataset.sponsorAction = "copy-export";
      copyExportBtn.addEventListener("click", () =>
        copyText(doc.markdownExport, "Copied Markdown export to clipboard."),
      );
      expTop.append(copyExportBtn);
      const pre = el("pre", "sponsor-doc-export-pre", doc.markdownExport);
      exportCard.append(expTop, pre);
      root.append(exportCard);
    }
  }

  function render() {
    unbindCode?.();
    unbindCode = null;
    root.replaceChildren();
    updateIdentityBar();

    if (phase === "loading") {
      const card = el("div", "dk-auth-card sponsor-doc-card");
      card.append(el("p", "dk-auth-card__lede", "Loading sponsor document…"));
      root.append(card);
      return;
    }

    if (phase === "notfound") {
      const card = el("div", "dk-auth-card sponsor-doc-card");
      card.dataset.sponsorView = "notfound";
      const head = el("header", "dk-auth-card__head");
      head.append(
        el("h1", "dk-auth-card__title", "Sponsor document not found"),
        el("p", "dk-auth-card__lede", "Check that you opened the full link from your DataTalks.Club email."),
      );
      card.append(head);
      root.append(card);
      return;
    }

    if (phase === "gate") {
      renderGate();
      return;
    }

    if (phase === "editor" && doc) {
      renderEditor();
    }
  }

  async function start() {
    const url = new URL(locationRef.href);
    docId = extractDocId(url.pathname);
    const queryCode = url.searchParams.get("code");
    if (queryCode !== null) {
      accessCode = formatUserCode(queryCode);
      saveStoredCode(docId, accessCode);
      historyRef.replaceState(null, "", `/sponsor-docs/${encodeURIComponent(docId)}`);
    } else {
      accessCode = readStoredCode(docId);
    }
    if (!docId) {
      phase = "notfound";
      render();
      return;
    }
    await loadDoc();
  }

  function destroy() {
    unbindCode?.();
    unbindCode = null;
  }

  return { start, destroy };
}
