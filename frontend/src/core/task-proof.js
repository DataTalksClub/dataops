// Task proof as the UI reads it: what a Task still needs before Done, what
// each gap is called, and whether the step is optional. The server enforces
// the same gates; these helpers only name them before the click, so Done is
// never a dead click that fails server-side.

export function taskRequiresApprovedArtifact(task) {
  const proof = task?.proofRequirement;
  return Boolean(
    proof && proof.required !== false && proof.type === "artifact",
  );
}

export function hasApprovedArtifactEvidence(task, artifacts) {
  const direct = (artifacts || []).some(
    (artifact) => artifact && artifact.status === "approved",
  );
  if (direct) return true;
  const refs = Array.isArray(task?.artifactRefs) ? task.artifactRefs : [];
  return refs.some((reference) => reference && reference.status === "approved");
}

export function hasTaskFileEvidence(task) {
  if (!task || typeof task !== "object") return false;
  if (task._hasFiles) return true;
  if (Number(task.fileCount || 0) > 0) return true;
  if (Array.isArray(task.files) && task.files.length > 0) return true;
  return Array.isArray(task.fileRefs) && task.fileRefs.length > 0;
}

export function cardLinkUrlForTask(card, task) {
  const required = String(task?.requiredLinkName || "").trim();
  if (!required) return String(task?.link || "").trim();
  const direct = String(task?.link || "").trim();
  if (direct || !Array.isArray(card?.cardLinks)) return direct;
  const needle = required.toLowerCase();
  const match = card.cardLinks.find(
    (entry) => entry && typeof entry === "object" && String(entry.name || entry.label || "").trim().toLowerCase() === needle,
  );
  return String(match?.url || "").trim();
}

export function proofRequirementLabel(task) {
  const proof = task?.proofRequirement;
  if (proof && typeof proof === "object") {
    const label = String(proof.label || "").trim();
    if (label) return label;
  }
  return "";
}

export function describeMissingProof(entry) {
  const text = String(entry || "");
  if (text === "calendar invite") return "Set the event time on the card";
  if (text === "required file" || text.endsWith("(file)")) return "Upload required file";
  if (text === "approved artifact") return "Approve an attached artifact";
  if (text === "external status" || text.endsWith("(external status)")) return `Set external status: ${text}`;
  if (text === "comment" || text.endsWith("(comment)")) return `Add comment: ${text}`;
  if (text === "proof link" || text.endsWith("(link)")) return `Add proof link: ${text}`;
  return `Fill in ${text}`;
}

// The N/A reasons a step's Template names (its `validation.skipClosure`),
// so the UI can offer them as one-click Skip reasons.
export function skipClosureStatuses(task) {
  const statuses = task?.validation?.skipClosure?.allowedStatuses;
  if (!Array.isArray(statuses)) return [];
  return statuses.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim());
}

// An explicitly optional checklist step: the Template marks it
// `validation.optional` (block fills that are often N/A). Required steps
// carry no flag; a conditionally required step carries `requiredReason`.
export function isOptionalWorkTask(task) {
  return task?.validation?.optional === true;
}

export function requiredReasonOf(task) {
  const reason = task?.validation?.requiredReason;
  return typeof reason === "string" && reason.trim() ? reason.trim() : "";
}

export function taskProofState(task, card = null) {
  const missing = [];
  if (task?.requiredLinkName && !cardLinkUrlForTask(card, task)) missing.push(task.requiredLinkName);
  if (task?.requiresFile && !hasTaskFileEvidence(task)) missing.push("required file");
  if (taskRequiresCalendarInvite(task) && !hasLinkedCalendarInvite(card)) missing.push("calendar invite");
  if (taskRequiresApprovedArtifact(task) && !hasApprovedArtifactEvidence(task, [])) missing.push("approved artifact");
  const proof = task?.proofRequirement;
  if (proof && typeof proof === "object" && proof.required !== false) {
    const type = String(proof.type || "");
    const label = proofRequirementLabel(task);
    if (type === "url" && !String(task?.link || "").trim()) {
      missing.push(label ? `${label} (link)` : "proof link");
    } else if (type === "comment" && !String(task?.comment || "").trim()) {
      missing.push(label ? `${label} (comment)` : "comment");
    } else if (type === "external-status" && !String(task?.externalStatus || "").trim()) {
      missing.push(label ? `${label} (external status)` : "external status");
    } else if (type === "file" && !hasTaskFileEvidence(task) && !missing.includes("required file")) {
      missing.push(label ? `${label} (file)` : "required file");
    }
  }
  if (missing.length > 0) return { ok: false, label: `Missing proof: ${missing.join(", ")}`, missing };
  if (task?.requiredLinkName || task?.requiresFile || taskRequiresApprovedArtifact(task)) {
    return { ok: true, label: "Proof ready", missing: [] };
  }
  if (proof && typeof proof === "object" && proof.required !== false) {
    return { ok: true, label: "Proof ready", missing: [] };
  }
  return { ok: true, label: "No proof required", missing: [] };
}

// The guest-invite Task in the webinar and podcast templates. It implies
// the calendar-invite requirement for Cards created before their Template
// declared it explicitly — the same fallback the server enforces.
export const CALENDAR_INVITE_TASK_REF = "create-calendar-invite";

export function taskRequiresCalendarInvite(task) {
  if (!task || typeof task !== "object") return false;
  if (task.requiresCalendarInvite === true) return true;
  const validation = task.validation;
  if (validation && typeof validation === "object" && !Array.isArray(validation)) {
    if (validation.requiresCalendarInvite === true) return true;
  }
  return task.templateTaskRef === CALENDAR_INVITE_TASK_REF;
}

export function hasLinkedCalendarInvite(card) {
  return Array.isArray(card?.calendarInvites) && card.calendarInvites.some((invite) => !invite.staleAt);
}

// Required-vs-optional in the Template's words, for the rows and dialogs
// that say it: an optional step names its N/A path, a conditionally
// required step names why it is required this week, anything else is an
// ordinary required step with nothing to say.
export function taskOptionality(task) {
  if (isOptionalWorkTask(task)) {
    const statuses = skipClosureStatuses(task);
    const note = typeof task?.validation?.optionalNote === "string"
      ? task.validation.optionalNote.trim()
      : "";
    const text = statuses.length > 0
      ? `Optional step — Skip when N/A (${statuses.join("; ")}), or Mark done when filled.`
      : "Optional step — Skip when N/A, or Mark done when filled.";
    return {
      kind: "optional",
      reason: "",
      statuses,
      text: note ? `${text} ${note}` : text,
      title: statuses.length > 0
        ? `Optional step — skip when N/A (${statuses.join("; ")}).`
        : "Optional step.",
    };
  }
  const reason = requiredReasonOf(task);
  if (reason) {
    return {
      kind: "required",
      reason,
      statuses: [],
      text: `Required step — ${reason}.`,
      title: `Required this week: ${reason}.`,
    };
  }
  return null;
}
