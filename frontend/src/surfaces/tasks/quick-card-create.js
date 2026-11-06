import { createFormFeedback, reportFieldValidation, setControlPending } from "../operations-overview.js";

export function createQuickCardForm(context) {
  const {
    createQuickInput,
    createQuickCheckbox,
    createQuickFormOverlay,
    addConflictReviewAction,
    getActiveWorkspaceRouteToken,
    isWorkspaceRouteFresh,
    openCardPanel,
    refreshOperationsWorkSnapshot,
    request,
    todayIsoDate,
    workApiUrl,
  } = context;
  async function openQuickWorkflowForm(options = {}) {
    const draftStorageKey = "dataops.guest-card-draft";
    let savedDraft = {};
    try { savedDraft = JSON.parse(globalThis.sessionStorage?.getItem(draftStorageKey) || "{}"); } catch {}
    options = { ...savedDraft, ...options };
    const requestedTemplate = options.template || null;
    const creationKey = options.creationKey || globalThis.crypto?.randomUUID?.()
      || `card-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    options.creationKey = creationKey;
    const overlay = createQuickFormOverlay("Create card");
    const form = document.createElement("form");
    form.className = "quick-form";
    form.addEventListener("submit", (event) => event.preventDefault());

    const selectLabel = document.createElement("label");
    selectLabel.className = "quick-form-label";
    selectLabel.textContent = "Template";
    const templateSelect = document.createElement("select");
    templateSelect.className = "quick-form-select";
    const loadingOpt = document.createElement("option");
    loadingOpt.value = "";
    loadingOpt.textContent = "Loading templates...";
    templateSelect.append(loadingOpt);
    templateSelect.disabled = true;
    selectLabel.append(templateSelect);

    const anchorInput = createQuickInput(
      "Date",
      "date",
      options.anchorDate ?? todayIsoDate(),
    );
    let anchorEdited = Object.hasOwn(options, "anchorDate");
    anchorInput.input.addEventListener("input", () => { anchorEdited = true; });
    anchorInput.input.addEventListener("change", () => { anchorEdited = true; });
    const titleInput = createQuickInput("Card title", "text", options.title || "");
    const guestWrap = document.createElement("div");
    guestWrap.hidden = true;
    guestWrap.className = "quick-form";
    guestWrap.dataset.guestEventFields = "";
    const guestEmail = createQuickInput("Guest email", "email", options.guestEmail || "");
    guestEmail.input.dataset.guestEmail = "";
    const guestName = createQuickInput("Guest name (optional)", "text", options.guestName || "");
    guestName.input.dataset.guestName = "";
    const topic = createQuickInput("Topic (optional)", "text", options.topic || "");
    topic.input.dataset.guestTopic = "";
    const guestSearch = createQuickInput("Find a saved guest", "search", "");
    guestSearch.input.dataset.guestSearch = "";
    const findGuest = document.createElement("button");
    findGuest.type = "button";
    findGuest.className = "quiet-button";
    findGuest.textContent = "Find guest";
    const guestOption = (label, value) => {
      const option = document.createElement("option");
      option.textContent = label;
      option.value = value;
      return option;
    };
    const savedGuest = document.createElement("select");
    savedGuest.dataset.savedGuest = "";
    savedGuest.className = "quick-form-select";
    savedGuest.setAttribute("aria-label", "Saved guest");
    savedGuest.append(guestOption("Select a saved guest (optional)", ""));
    let savedPeople = [];
    let savedPersonId = options.guestPersonId || options.guestContactId || "";
    if (savedPersonId) savedGuest.append(guestOption(options.guestName || "Saved guest", savedPersonId));
    savedGuest.value = savedPersonId;
    findGuest.addEventListener("click", async () => {
      findGuest.disabled = true;
      try {
        const query = new URLSearchParams({ active: "true", dnc: "false", limit: "50", search: guestSearch.input.value.trim() });
        const payload = await request(workApiUrl(`/api/sponsor-crm/directory/people?${query}`));
        savedPeople = payload.items || [];
        savedGuest.replaceChildren(guestOption("Select a saved guest (optional)", ""));
        for (const person of savedPeople) savedGuest.append(guestOption(`${person.name || "Saved guest"}${person.emails?.[0] ? ` (${person.emails[0]})` : " (email needed)"}`, person.id));
        guestHint.textContent = savedPeople.length ? "Select a saved guest to reuse their contact details." : "No saved guests found.";
      } catch (error) { guestHint.textContent = `Could not find guests: ${error.message || "request failed"}`; }
      finally { findGuest.disabled = false; }
    });
    const time = createQuickInput("Time (optional)", "time", options.time || "");
    time.input.dataset.guestTime = "";
    const timeZone = createQuickInput("Schedule time zone", "text", options.timeZone || "Europe/Berlin");
    timeZone.input.dataset.scheduleTimeZone = "";
    const guestTimezone = createQuickInput("Guest time zone (optional)", "text", options.guestTimezone || "");
    guestTimezone.input.dataset.guestTimeZone = "";
    const preferredWindow = createQuickInput("Preferred time window (optional)", "text", options.window || "");
    preferredWindow.input.placeholder = "For example, evening";
    preferredWindow.input.dataset.preferredWindow = "";
    const scheduling = document.createElement("details");
    const schedulingLabel = document.createElement("summary");
    schedulingLabel.textContent = "Scheduling preferences (optional)";
    scheduling.append(schedulingLabel, time.label, timeZone.label, guestTimezone.label, preferredWindow.label);
    const skipEmail = createQuickCheckbox("Do not send email", options.skipEmail);
    skipEmail.input.dataset.skipEmail = "";
    const guestHint = document.createElement("p");
    guestHint.className = "quick-form-state";
    guestHint.textContent = "With a guest email, DataOps proposes a time and sends the invitation automatically.";
    const savedGuestLookup = document.createElement("details");
    const lookupLabel = document.createElement("summary");
    lookupLabel.textContent = "Use a saved guest (optional)";
    savedGuestLookup.append(lookupLabel, guestSearch.label, findGuest, savedGuest);
    guestWrap.append(savedGuestLookup, guestEmail.label, guestName.label, topic.label, scheduling, skipEmail.label, guestHint);
    guestHint.setAttribute("aria-live", "polite");
    const templateControl = { label: selectLabel, input: templateSelect };
    const templateState = document.createElement("p");
    templateState.className = "quick-form-state";
    templateState.setAttribute("role", "status");
    templateState.setAttribute("aria-live", "polite");
    templateState.textContent = "Loading templates…";
    const groupsWrap = document.createElement("div");
    groupsWrap.className = "quick-form-groups";
    groupsWrap.hidden = true;
    const feedback = createFormFeedback();

    const createBtn = document.createElement("button");
    createBtn.type = "submit";
    createBtn.className = "task-action-btn is-primary";
    createBtn.textContent = "Create card";
    createBtn.disabled = true;
    let cardSubmitInFlight = false;

    form.append(
      selectLabel,
      templateState,
      groupsWrap,
      titleInput.label,
      anchorInput.label,
      guestWrap,
      feedback.node,
      createBtn,
    );
    overlay.querySelector(".quick-form-body").append(form);
    titleInput.input.focus();
    titleInput.input.focus();

    // Fetch live templates from the backend API (UUIDs, not doc slugs)
    let liveTemplates = [];
    try {
      const payload = await request(workApiUrl("/api/templates"));
      liveTemplates = Array.isArray(payload)
        ? payload
        : payload.templates || [];
    } catch (error) {
      templateSelect.replaceChildren();
      const unavailable = document.createElement("option");
      unavailable.value = "";
      unavailable.textContent = "Templates unavailable";
      templateSelect.append(unavailable);
      templateSelect.disabled = true;
      createBtn.disabled = true;
      // The form stays open and offers its own recovery: a card cannot be
      // created without templates, but the operator does not lose the dialog.
      feedback
        .failure(
          `Templates could not be loaded: ${error.message || "request failed"}`,
        )
        .focus();
      templateState.textContent = "No templates are available to select.";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "quiet-button quick-form-retry";
      retry.textContent = "Retry loading templates";
      retry.addEventListener("click", () => {
        overlay.close();
        openQuickWorkflowForm(options);
      });
      feedback.node.append(retry);
      return;
    }

    templateSelect.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select template...";
    templateSelect.append(placeholder);
    for (const template of liveTemplates) {
      const opt = document.createElement("option");
      opt.value = template.id;
      opt.textContent = template.name || template.title || template.id;
      templateSelect.append(opt);
    }
    const matchedTemplate = findLiveWorkflowTemplate(
      liveTemplates,
      requestedTemplate,
    );
    if (matchedTemplate?.id) {
      templateSelect.value = matchedTemplate.id;
      if (!titleInput.input.value && requestedTemplate?.title)
        titleInput.input.value = requestedTemplate.title;
    }
    templateSelect.disabled = false;
    templateState.textContent =
      liveTemplates.length > 0
        ? ""
        : "No templates are deployed, so no card can be created yet.";
    // Optional task groups (e.g. a secondary sponsor block) instantiate
    // only when checked. Unchecked groups stay out of the new Card.
    const syncOptionalGroups = () => {
      const selected = liveTemplates.find(
        (template) => template.id === templateSelect.value,
      );
      const groups = [
        ...new Set(
          (selected?.taskDefinitions || [])
            .map((definition) => definition?.optionalGroup)
            .filter((group) => typeof group === "string" && group.length > 0),
        ),
      ];
      groupsWrap.replaceChildren();
      groupsWrap.hidden = groups.length === 0;
      for (const group of groups) {
        const label = document.createElement("label");
        label.className = "quick-form-label quick-form-checkbox";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.value = group;
        box.dataset.optionalGroup = group;
        label.append(box, document.createTextNode(group === "sponsored" ? "Sponsored" : `Include ${group} tasks`));
        groupsWrap.append(label);
      }
    };
    // A Template with a card_title pattern names its Cards, so the title is
    // optional there; any other Template needs one.
    const selectedTitlePattern = () =>
      liveTemplates.find((template) => template.id === templateSelect.value)?.cardTitle || "";
    const selectedGuestEvent = () => {
      const selected = liveTemplates.find((template) => template.id === templateSelect.value);
      return selected?.guestIntake?.enabled === true && ["podcast", "webinar", "workshop"].includes(selected.type);
    };
    const hasGuestEmail = () => selectedGuestEvent() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail.input.value.trim());
    const hasGuest = () => selectedGuestEvent() && Boolean(guestEmail.input.value.trim() || savedPersonId || guestName.input.value.trim());
    const buttonLabel = () => !hasGuestEmail() ? "Create card" : skipEmail.input.checked ? "Create without email" : "Create and send invitation";
    const persistDraft = () => {
      const selected = liveTemplates.find(template => template.id === templateSelect.value);
      try {
        globalThis.sessionStorage?.setItem(draftStorageKey, JSON.stringify({
          creationKey,
          template: selected,
          title: titleInput.input.value,
          ...(anchorEdited ? { anchorDate: anchorInput.input.value } : {}),
          guestEmail: guestEmail.input.value,
          guestName: guestName.input.value,
          guestPersonId: savedPersonId,
          topic: topic.input.value,
          time: time.input.value,
          timeZone: timeZone.input.value,
          guestTimezone: guestTimezone.input.value,
          window: preferredWindow.input.value,
          skipEmail: skipEmail.input.checked,
        }));
      } catch {}
    };
    const clearDraft = () => { try { globalThis.sessionStorage?.removeItem(draftStorageKey); } catch {} };
    overlay.onDiscard = clearDraft;
    savedGuest.addEventListener("change", () => {
      savedPersonId = savedGuest.value;
      const person = savedPeople.find(person => person.id === savedPersonId);
      if (person) { guestName.input.value = person.name || ""; guestEmail.input.value = person.emails?.[0] || ""; }
      syncTitleField();
      persistDraft();
    });
    const syncTitleField = () => {
      const event = selectedGuestEvent();
      guestWrap.hidden = !event;
      for (const control of [guestEmail, guestName, topic, time, timeZone, guestTimezone, preferredWindow, skipEmail]) control.input.disabled = !event;
      if (!anchorEdited) anchorInput.input.value = event ? "" : todayIsoDate();
      const generated = Boolean(selectedTitlePattern()) || hasGuest();
      titleInput.label.textContent = generated ? "Card title (optional)" : "Card title";
      titleInput.label.append(titleInput.input);
      titleInput.input.setAttribute("aria-required", String(!generated));
      titleInput.input.placeholder = generated ? "Generated from the template if left empty" : "";
      anchorInput.label.textContent = hasGuest() ? "Date (optional)" : "Date";
      anchorInput.label.append(anchorInput.input);
      anchorInput.input.setAttribute("aria-required", String(!hasGuest()));
      guestHint.textContent = skipEmail.input.checked
        ? "The event and guest form will be prepared without sending an email or a calendar invite."
        : hasGuestEmail() ? `After creating this card, ${guestEmail.input.value.trim()} will automatically receive an invitation email and a [Proposed] calendar invite.`
        : "Add an email or choose a saved guest. Without an email, the card waits for contact details.";
      if (!cardSubmitInFlight) createBtn.textContent = buttonLabel();
    };
    guestEmail.input.addEventListener("input", syncTitleField);
    guestName.input.addEventListener("input", syncTitleField);
    form.addEventListener("input", persistDraft);
    form.addEventListener("change", persistDraft);
    skipEmail.input.addEventListener("change", syncTitleField);
    templateSelect.addEventListener("change", () => {
      syncOptionalGroups();
      syncTitleField();
    });
    syncOptionalGroups();
    syncTitleField();
    if (liveTemplates.length > 0) createBtn.disabled = false;
    else {
      const emptyOpt = document.createElement("option");
      emptyOpt.textContent = "No templates available";
      templateSelect.append(emptyOpt);
      templateSelect.disabled = true;
    }

    const submitCard = async () => {
      if (cardSubmitInFlight) return;
      const templateId = templateSelect.value;
      const anchorDate = anchorInput.input.value;
      const email = selectedGuestEvent() ? guestEmail.input.value.trim() : "";
      const guestIntake = hasGuest();
      persistDraft();
      const titleMissing = !titleInput.input.value.trim() && !selectedTitlePattern() && !guestIntake;
      const validZone = value => { try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; } catch { return false; } };
      const invalid = reportFieldValidation([
        [time, !guestIntake || !time.input.value || anchorDate ? "" : "Choose a date with an explicit time."],
        [timeZone, !guestIntake || validZone(timeZone.input.value.trim()) ? "" : "Enter an IANA time zone, for example Europe/Berlin."],
        [guestTimezone, !guestIntake || !guestTimezone.input.value.trim() || validZone(guestTimezone.input.value.trim()) ? "" : "Enter an IANA time zone."],
        [templateControl, templateId ? "" : "Select a template."],
        [titleInput, templateId && titleMissing ? "Card title is required." : ""],
        [anchorInput, anchorDate || guestIntake ? "" : "Date is required."],
        [guestEmail, !email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? "" : "Enter a valid guest email."],
      ]);
      if (invalid) {
        feedback.clear();
        return;
      }
      cardSubmitInFlight = true;
      setControlPending(createBtn, {
        pending: true,
        pendingLabel: "Creating card…",
      });
      feedback.pending("Creating card…");
      const routeToken = getActiveWorkspaceRouteToken();
      try {
        const body = { templateId };
        if (anchorDate) body.anchorDate = anchorDate;
        if (guestIntake) {
          if (email) body.guestEmail = email.toLowerCase();
          if (savedPersonId) body.guestPersonId = savedPersonId;
          body.creationKey = creationKey;
          if (guestName.input.value.trim()) body.guestName = guestName.input.value.trim();
          if (topic.input.value.trim()) body.topic = topic.input.value.trim();
          if (skipEmail.input.checked) body.skipEmail = true;
          if (time.input.value) body.time = time.input.value;
          if (timeZone.input.value.trim() !== "Europe/Berlin") body.timeZone = timeZone.input.value.trim();
          if (guestTimezone.input.value.trim()) body.guestTimezone = guestTimezone.input.value.trim();
          if (preferredWindow.input.value.trim()) body.window = preferredWindow.input.value.trim();
        }
        const title = titleInput.input.value.trim();
        if (title) body.title = title;
        if (!groupsWrap.hidden) {
          body.optionalGroups = [...groupsWrap.querySelectorAll("input[type=\"checkbox\"]")]
            .filter((box) => box.checked)
            .map((box) => box.value);
        }
        const result = await request(workApiUrl("/api/cards"), {
          method: "POST",
          body: JSON.stringify(body),
        });
        const card = result?.card || result;
        clearDraft();
        overlay.close();
        if (!isWorkspaceRouteFresh(routeToken)) {
          await refreshOperationsWorkSnapshot({ rerender: false });
          return;
        }
        if (card?.id) openCardPanel(card.id);
        await refreshOperationsWorkSnapshot({ rerender: true });
      } catch (err) {
        if (!isWorkspaceRouteFresh(routeToken)) {
          overlay.close();
          return;
        }
        if (err.status === 409 || err.code === "template_version_conflict") {
          feedback
            .conflict(
              `The Template changed since this form was opened: ${err.message || "version conflict"}` +
                ` The entries in this draft are retained. Select Create card to retry,` +
                ` Close to discard this draft, or Review latest Templates to load the current list.`,
            )
            .focus();
          addConflictReviewAction(
            feedback,
            "Review latest Templates",
            () => {
              const selectedTemplate =
                liveTemplates.find((template) => template.id === templateId) ||
                requestedTemplate;
              options.template = selectedTemplate;
              options.title = titleInput.input.value;
              options.anchorDate = anchorDate;
              options.guestEmail = guestEmail.input.value;
              options.guestName = guestName.input.value;
              options.guestPersonId = savedPersonId;
              options.topic = topic.input.value;
              options.skipEmail = skipEmail.input.checked;
              options.time = time.input.value;
              options.timeZone = timeZone.input.value;
              options.guestTimezone = guestTimezone.input.value;
              options.window = preferredWindow.input.value;
              overlay.close();
              openQuickWorkflowForm(options);
            },
          );
        } else {
          feedback
            .failure(
              `Could not create card: ${err.message || "request failed"} Select Create card to retry.`,
            )
            .focus();
        }
        setControlPending(createBtn, { pending: false, label: buttonLabel() });
      } finally {
        cardSubmitInFlight = false;
      }
    };
    form.addEventListener("submit", submitCard);
  }

  function findLiveWorkflowTemplate(liveTemplates, requestedTemplate) {
    if (!requestedTemplate || !Array.isArray(liveTemplates)) return null;
    const wantedId = normalizeTemplateMatchValue(
      requestedTemplate.id ||
        requestedTemplate.templateId ||
        requestedTemplate.sourceTemplateId ||
        requestedTemplate.canonicalTemplateId,
    );
    if (wantedId) {
      const idMatches = liveTemplates.filter(
        (template) => normalizeTemplateMatchValue(template.id) === wantedId,
      );
      return idMatches.length === 1 ? idMatches[0] : null;
    }

    const wantedSlug = normalizeTemplateMatchValue(
      requestedTemplate.slug || requestedTemplate.type,
    );
    if (!wantedSlug) return null;
    const slugMatches = liveTemplates.filter((template) => {
      const templateSlug = normalizeTemplateMatchValue(
        template.slug || template.type,
      );
      return templateSlug === wantedSlug;
    });
    return slugMatches.length === 1 ? slugMatches[0] : null;
  }

  function normalizeTemplateMatchValue(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\s+task template$/i, "")
      .replace(/&/g, "and")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  return openQuickWorkflowForm;
}
