// The completion section of an open Task: the proof fields the Task's
// proofRequirement demands (only those — a comment box never appears unless
// a comment is the proof), the Mark done gate that reads them live, the
// named unlock condition when prerequisites block it, and the
// required-vs-optional line from the Template config.

import { blockedReason, blockingPrerequisites, prerequisiteStatusLabel } from "../../core/task-dependencies.js";
import {
  cardLinkUrlForTask,
  describeMissingProof,
  taskOptionality,
  taskProofState,
} from "../../core/task-proof.js";

function proofNeeds(task) {
  const proof = task?.proofRequirement && typeof task.proofRequirement === "object"
    ? task.proofRequirement
    : null;
  const type = proof && proof.required !== false ? String(proof.type || "") : "";
  const label = proof && typeof proof.label === "string" ? proof.label.trim() : "";
  return {
    // The required-link field above already collects the link, so a `url`
    // proof only needs its own field when no required link is set.
    link: type === "url" && !task.requiredLinkName,
    comment: type === "comment",
    externalStatus: type === "external-status",
    label,
  };
}

export function renderTaskCompletion(context) {
  const {
    actions,
    createTaskActionButton,
    evidence,
    closeTaskPanel,
    hasApprovedArtifactEvidence,
    markTaskWaiting,
    openTaskPanel,
    busy,
    parentCard,
    renderSkipButton,
    siblingTasks,
    stateSection,
    task,
    taskRequiresApprovedArtifact,
    updateTaskStatus,
  } = context;

  const needs = proofNeeds(task);
  const proofInputs = {};
  const readProofPayload = () => {
    const payload = {};
    for (const key of ["link", "comment", "externalStatus"]) {
      if (needs[key] && proofInputs[key]) {
        const value = proofInputs[key].value.trim();
        if (value) payload[key] = value;
      }
    }
    return payload;
  };

  // The gate reads the live field values, so typing the proof enables Mark
  // done without a rerender; Done sends the proof in the same PUT the CLI
  // sends with --link/--comment/--external-status.
  const completionProofState = () => {
    const draft = { ...task, ...readProofPayload() };
    const proof = taskProofState(draft, parentCard);
    const missingLink = task.requiredLinkName && !cardLinkUrlForTask(parentCard, task);
    const missingFile = task.requiresFile && !evidence.hasFiles();
    const missingArtifact =
      taskRequiresApprovedArtifact(task) &&
      !hasApprovedArtifactEvidence(task, evidence.artifacts());
    const missingProof = proof.missing.filter(
      (entry) => entry !== task.requiredLinkName && entry !== "required file" && entry !== "approved artifact",
    );
    const blockedBy = blockedReason(task, siblingTasks);
    return {
      missingLink,
      missingFile,
      missingArtifact,
      missingProof,
      blockedBy,
      canComplete:
        !blockedBy && !missingLink && !missingFile && !missingArtifact && missingProof.length === 0,
    };
  };

  const renderProofField = ({ key, labelText, field, placeholder, hint, suggestions }) => {
    const wrap = document.createElement("div");
    wrap.className = "task-required-link task-proof-field";
    const label = document.createElement("label");
    label.textContent = labelText;
    let input;
    if (field === "comment") {
      input = document.createElement("textarea");
      input.rows = 2;
    } else {
      input = document.createElement("input");
      input.type = field === "link" ? "url" : "text";
    }
    input.dataset.panelField = `proof-${key}`;
    input.value = String(task[field] || "");
    input.placeholder = placeholder;
    input.disabled = busy;
    if (Array.isArray(suggestions) && suggestions.length > 0 && input.tagName !== "TEXTAREA") {
      const listId = `task-proof-${key}-options-${task.id}`;
      input.setAttribute("list", listId);
      const list = document.createElement("datalist");
      list.id = listId;
      for (const suggestion of suggestions) {
        const option = document.createElement("option");
        option.value = suggestion;
        list.append(option);
      }
      wrap.append(list);
    }
    input.addEventListener("input", () => syncCompletion());
    label.append(input);
    wrap.append(label);
    if (hint) {
      const note = document.createElement("small");
      note.className = "task-proof-hint";
      note.textContent = hint;
      wrap.append(note);
    }
    proofInputs[key] = input;
    stateSection.append(wrap);
  };

  if (needs.link || needs.comment || needs.externalStatus) {
    const skipStatuses = Array.isArray(task.validation?.skipClosure?.allowedStatuses)
      ? task.validation.skipClosure.allowedStatuses.filter((entry) => typeof entry === "string" && entry.trim())
      : [];
    if (needs.externalStatus) {
      renderProofField({
        key: "externalStatus",
        labelText: needs.label ? `${needs.label} (external status)` : "External status",
        field: "externalStatus",
        placeholder: "e.g. Sponsored block filled",
        hint: "Saved with Mark done; Skip instead when this does not apply.",
        suggestions: skipStatuses,
      });
    }
    if (needs.comment) {
      renderProofField({
        key: "comment",
        labelText: needs.label ? `${needs.label} (comment)` : "Completion comment",
        field: "comment",
        placeholder: "What was done…",
        hint: "Saved with Mark done; Skip instead when this does not apply.",
      });
    }
    if (needs.link) {
      renderProofField({
        key: "link",
        labelText: needs.label ? `${needs.label} (link)` : "Proof link",
        field: "link",
        placeholder: "https://...",
        hint: "Saved with Mark done.",
      });
    }
  }

  // Done finishes the Task: back to where it was opened from.
  const complete = createTaskActionButton("Mark done", async () => {
    const proofPayload = readProofPayload();
    if (await updateTaskStatus(task.id, "done", task.version, proofPayload)) await closeTaskPanel();
  });
  // A blocked task's Mark done is not the next action, so it is not primary.
  if (blockingPrerequisites(task, siblingTasks).length === 0) complete.classList.add("is-primary");

  const syncCompletion = () => {
    const {
      missingLink,
      missingFile,
      missingArtifact,
      missingProof,
      blockedBy,
      canComplete,
    } = completionProofState();
    complete.disabled = busy || !canComplete;
    if (canComplete) {
      complete.title = "";
      return;
    }
    const reasons = [];
    if (blockedBy) reasons.push(blockedBy);
    if (missingLink) reasons.push(`Fill in ${task.requiredLinkName}`);
    if (missingFile) reasons.push("Upload required file");
    if (missingArtifact) reasons.push("Approve an attached artifact");
    for (const entry of missingProof) reasons.push(describeMissingProof(entry));
    complete.title = reasons.join("; ");
  };
  syncCompletion();

  // Why Mark done is off, named beside it instead of only in a tooltip:
  // each blocking prerequisite opens, so the unlock condition is an
  // action. A blocked step stays inactive until its prerequisites are
  // completed or skipped; the full Waiting-on section above stays the
  // reference, this line is the short path from the button.
  const blockers = blockingPrerequisites(task, siblingTasks);
  if (blockers.length > 0) {
    const why = document.createElement("span");
    why.className = "task-actions-why";
    why.dataset.blocked = "true";
    why.append(document.createTextNode("Blocked: complete or skip "));
    blockers.forEach((entry, index) => {
      if (index > 0) {
        why.append(document.createTextNode(
          index === blockers.length - 1 ? " and " : ", ",
        ));
      }
      if (entry.status === "missing") {
        const missing = document.createElement("span");
        missing.textContent = entry.description;
        missing.title = "This prerequisite is missing from the card — remove the dependency to unblock";
        why.append(missing);
      } else {
        const open = document.createElement("button");
        open.type = "button";
        open.className = "task-dependency-name";
        open.textContent = entry.description;
        open.title = `Open “${entry.description}” (${prerequisiteStatusLabel(entry.status)}) to complete or skip it`;
        open.addEventListener("click", () => openTaskPanel(entry.id));
        why.append(open);
      }
    });
    why.append(document.createTextNode(" first"));
    actions.append(why);
  }
  actions.append(complete);

  // Required-vs-optional reads the Template config: an optional step names
  // its N/A path beside the actions, a conditionally required one names why
  // it is required this week.
  const optionality = taskOptionality(task);
  if (optionality) {
    const note = document.createElement("p");
    note.className = "task-optional-note";
    note.textContent = optionality.text;
    note.title = optionality.title;
    stateSection.append(note);
  }

  const markWaiting = createTaskActionButton("Mark waiting", () =>
    markTaskWaiting(task.id),
  );
  actions.append(markWaiting, renderSkipButton());

  return { complete, readProofPayload, syncCompletion };
}

// The checklist row's quiet optionality line: the same Template config in
// the row's small-type voice.
export function appendChecklistOptionality(body, task) {
  const optionality = taskOptionality(task);
  if (!optionality) return null;
  const note = document.createElement("small");
  if (optionality.kind === "optional") {
    note.className = "card-checklist-optional";
    note.textContent = "Optional";
    note.title = `${optionality.title} Open the task to skip or complete it.`;
  } else {
    note.className = "card-checklist-required";
    note.textContent = `Required — ${optionality.reason}`;
    note.title = `${optionality.title} Open the task to complete it.`;
  }
  body.append(note);
  return note;
}
