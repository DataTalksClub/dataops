import { humanLinkName } from "./card-display.js";

function templateUpdateSummary(preview) {
  const counts = preview?.counts || {};
  const parts = [
    [counts.added, "added"],
    [(preview.taskChanges || []).filter(({ action }) => action === "adopt").length, "adopted"],
    [(preview.taskChanges || []).filter(({ action }) => action === "conflict").length, "conflicts"],
    [counts.updated, "updated"],
    [counts.skipped, "skipped"],
    [counts.removed, "removed"],
    [counts.retainedCompleted, "completed retained"],
    [counts.cardFields, "Card fields"],
  ].filter(([count]) => Number(count) > 0)
    .map(([count, label]) => `${count} ${label}`);
  return parts.length ? parts.join(" · ") : "Definition provenance only";
}

function taskUpdateLabel(change) {
  const label = change.targetLabel || change.currentLabel || change.taskRef;
  if (change.action === "adopt") return `Adopt manual task: ${label} (${change.taskId})`;
  if (change.action === "conflict") return `Conflict: ${label} — ${change.reason}`;
  if (change.action === "add") return `Add ${label}`;
  if (change.action === "restore") return `Restore task: ${label}`;
  if (change.action === "skip-removed") return `Skip removed task: ${label}`;
  if (change.action === "remove") return `Remove ${label} (not done, no linked Card)`;
  if (change.action === "retain-completed") return `Retain completed task: ${label}`;
  if (change.action === "refresh-provenance") return `Refresh provenance: ${label}`;
  const fields = (change.changes || []).map(({ field }) => field).join(", ");
  return `Update ${label}${fields ? `: ${fields}` : ""}`;
}

export function renderCardTemplateUpdate(card, data, context) {
  const {
    detail,
    reloadCardTemplateUpdate,
    applyCardTemplateUpdate,
    renderCardPanel,
  } = context;
  const preview = data.templateUpdate;
  if (preview?.state === "current" && !preview.availableOptionalGroups?.length && !preview.countFields?.length) return null;
  const section = document.createElement("section");
  section.className = "card-template-update workflow-detail-section";
  const heading = document.createElement("div");
  heading.className = "card-template-update-heading";
  const title = document.createElement("strong");
  title.textContent = "Template definition";
  heading.append(title);
  section.append(heading);

  if (!preview) {
    const unavailable = document.createElement("p");
    unavailable.className = "card-template-update-message is-error";
    unavailable.textContent = data.templateUpdateError || "Template update status is unavailable.";
    section.append(unavailable);
    return section;
  }

  const groups = preview.availableOptionalGroups || [];
  const countFields = preview.countFields || [];
  // Counts decide how many repeated Tasks exist (Workshop 1..N). A changed
  // count is reviewed like an option change: the review lists every Task it
  // adds or removes before anything is applied.
  const countsOf = (fieldset) => countFields.length
    ? Object.fromEntries([...fieldset.querySelectorAll("input[data-count-field]")]
      .map((input) => [input.dataset.countField, Number(input.value)]))
    : undefined;
  if (groups.length || countFields.length) {
    const options = document.createElement("fieldset");
    options.className = "card-options";
    const legend = document.createElement("legend");
    legend.textContent = "Card options";
    options.append(legend);
    for (const group of groups) {
      const label = document.createElement("label");
      label.className = "quick-form-label quick-form-checkbox";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = group;
      box.checked = (preview.targetOptionalGroups || []).includes(group);
      box.disabled = detail.activeCardTemplateBusy;
      box.addEventListener("change", () => {
        const oldReview = section.querySelector(".card-template-review");
        oldReview?.remove();
        section.querySelector(".card-template-review-button")?.remove();
        section.querySelector(".card-template-update-summary")?.remove();
        const oldStatus = section.querySelector(".card-template-update-status");
        if (oldStatus) oldStatus.textContent = "Review option changes to see the affected tasks.";
      });
      label.append(box, document.createTextNode(group === "sponsored" ? "Sponsored" : humanLinkName(group)));
      options.append(label);
    }
    for (const field of countFields) {
      const label = document.createElement("label");
      label.className = "quick-form-label card-count-field";
      const input = document.createElement("input");
      input.type = "number";
      input.min = String(field.min);
      input.max = String(field.max);
      input.step = "1";
      input.inputMode = "numeric";
      input.dataset.countField = field.id;
      input.value = String(preview.targetCounts?.[field.id] ?? preview.currentCounts?.[field.id] ?? field.min);
      input.disabled = detail.activeCardTemplateBusy;
      label.append(document.createTextNode(field.label), input);
      options.append(label);
    }
    const reviewOptions = document.createElement("button");
    reviewOptions.type = "button";
    reviewOptions.className = "task-action-btn";
    reviewOptions.textContent = groups.length ? "Review option changes" : "Review count change";
    reviewOptions.disabled = detail.activeCardTemplateBusy;
    reviewOptions.addEventListener("click", () => reloadCardTemplateUpdate(card.id,
      [...options.querySelectorAll('input[type="checkbox"]')].filter((box) => box.checked).map((box) => box.value),
      countsOf(options)));
    options.append(reviewOptions);
    section.append(options);
  }
  if (preview.state === "current") {
    if (detail.activeCardTemplateMessage) {
      const message = document.createElement("p");
      message.setAttribute("role", "status");
      message.textContent = detail.activeCardTemplateMessage;
      section.append(message);
    }
    return section;
  }
  const status = document.createElement("p");
  status.className = `card-template-update-status is-${preview.state}`;
  status.textContent = preview.sourceTemplateVersion === preview.targetTemplateVersion
    ? "Card option changes ready for review."
    : `Update available: Template v${preview.sourceTemplateVersion} → v${preview.targetTemplateVersion}.`;
  const summary = document.createElement("p");
  summary.className = "card-template-update-summary";
  summary.textContent = templateUpdateSummary(preview);
  section.append(status, summary);

  if (!detail.activeCardTemplateReviewOpen) {
    const review = document.createElement("button");
    review.type = "button";
    review.className = "primary-button card-template-review-button";
    review.textContent = "Review template update";
    review.addEventListener("click", () => {
      detail.activeCardTemplateReviewOpen = true;
      detail.activeCardTemplateMessage = "";
      renderCardPanel();
    });
    section.append(review);
    return section;
  }

  const review = document.createElement("div");
  review.className = "card-template-review";
  const guidance = document.createElement("p");
  guidance.textContent = [
    "Applying this reviewed definition keeps task IDs, live status, notes,",
    "waiting state, links, files, artifacts, and history.",
    "Removed incomplete tasks are skipped; completed tasks are retained.",
    ...(countFields.length
      ? ["Lowering a count removes only the extra repeated tasks that are not done and link no Card."]
      : []),
  ].join(" ");
  review.append(guidance);
  if (Number(preview.counts?.operatorOverrides) > 0) {
    const warning = document.createElement("p");
    warning.className = "card-template-update-message is-warning";
    const plural = preview.counts.operatorOverrides === 1 ? "" : "s";
    warning.textContent = [
      `${preview.counts.operatorOverrides} operator override field${plural}`,
      "will take the reviewed Template value.",
    ].join(" ");
    review.append(warning);
  }
  const list = document.createElement("ul");
  list.className = "card-template-change-list";
  if (JSON.stringify(preview.selectedOptionalGroups) !== JSON.stringify(preview.targetOptionalGroups)) {
    const item = document.createElement("li");
    item.textContent = `Card options: ${(preview.selectedOptionalGroups || []).join(", ") || "none"} → ${(preview.targetOptionalGroups || []).join(", ") || "none"}.`;
    list.append(item);
  }
  for (const field of countFields) {
    const from = preview.currentCounts?.[field.id];
    const to = preview.targetCounts?.[field.id];
    if (from === to) continue;
    const item = document.createElement("li");
    item.textContent = `${field.label}: ${from} → ${to}.`;
    list.append(item);
  }
  for (const change of preview.cardChanges || []) {
    const item = document.createElement("li");
    item.textContent = `Update Card field: ${change.field}${change.operatorOverride ? " (operator override)" : ""}`;
    list.append(item);
  }
  for (const change of preview.taskChanges || []) {
    const item = document.createElement("li");
    item.textContent = taskUpdateLabel(change);
    if ((change.operatorOverrideFields || []).length > 0) {
      item.textContent += ` (operator override: ${change.operatorOverrideFields.join(", ")})`;
    }
    list.append(item);
  }
  if (!list.children.length) {
    const item = document.createElement("li");
    item.textContent = "Refresh the reviewed Template provenance.";
    list.append(item);
  }
  review.append(list);
  if (detail.activeCardTemplateMessage) {
    const message = document.createElement("p");
    message.className = "card-template-update-message";
    message.setAttribute("role", "status");
    message.textContent = detail.activeCardTemplateMessage;
    review.append(message);
  }
  const actions = document.createElement("div");
  actions.className = "card-template-update-actions";
  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "primary-button";
  apply.textContent = detail.activeCardTemplateBusy ? "Applying…" : "Apply reviewed update";
  apply.disabled = (preview.taskChanges || []).some(({ action }) => action === "conflict") || detail.activeCardTemplateBusy ||
    detail.activeCardMutationBusy || detail.activeTaskMutationBusy;
  apply.addEventListener("click", () => applyCardTemplateUpdate(card.id, preview.previewToken, preview.targetOptionalGroups,
    countFields.length ? preview.targetCounts : undefined));
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "task-action-btn";
  cancel.textContent = "Cancel";
  cancel.disabled = detail.activeCardTemplateBusy ||
    detail.activeCardMutationBusy || detail.activeTaskMutationBusy;
  cancel.addEventListener("click", () => {
    detail.activeCardTemplateReviewOpen = false;
    detail.activeCardTemplateMessage = "";
    renderCardPanel();
  });
  actions.append(apply, cancel);
  if (detail.activeCardTemplateMessage.includes("changed after preview")) {
    const reload = document.createElement("button");
    reload.type = "button";
    reload.className = "task-action-btn";
    reload.textContent = "Reload latest preview";
    reload.addEventListener("click", () => reloadCardTemplateUpdate(card.id, preview.targetOptionalGroups,
      countFields.length ? preview.targetCounts : undefined));
    actions.append(reload);
  }
  review.append(actions);
  section.append(review);
  return section;
}
