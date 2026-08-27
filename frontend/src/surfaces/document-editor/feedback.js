const ASSERTIVE_STATES = new Set([
  "validation",
  "conflict",
  "error",
]);

/**
 * Render feedback in the document editor's own live region.
 *
 * Mutation modules use this small contract instead of reaching into the
 * application shell. The live region is supplied by the editor surface and
 * remains visible while the operator is working in the editor.
 */
export function writeEditorFeedback(node, message, { kind = "success" } = {}) {
  if (!node) return;
  const text = String(message || "").trim();
  const state = text ? kind : "idle";
  const assertive = ASSERTIVE_STATES.has(state);

  node.textContent = text;
  node.hidden = !text;
  node.dataset.feedbackState = state;
  node.setAttribute("role", assertive ? "alert" : "status");
  node.setAttribute("aria-live", assertive ? "assertive" : "polite");
  node.setAttribute("aria-atomic", "true");
  node.classList.toggle("is-error", assertive);
  node.classList.toggle("is-warning", state === "warning");
  node.classList.toggle("is-conflict", state === "conflict");
}

export function editorFeedbackFor(context) {
  if (typeof context.showEditorFeedback === "function") {
    return context.showEditorFeedback;
  }
  return (message, options) =>
    writeEditorFeedback(context.editorInlineStatus, message, options);
}

export function editorMutationGuard(context) {
  const token =
    typeof context.getActiveWorkspaceRouteToken === "function"
      ? context.getActiveWorkspaceRouteToken()
      : null;
  return () => {
    if (
      token === null ||
      typeof context.isWorkspaceRouteFresh !== "function"
    ) {
      return true;
    }
    return context.isWorkspaceRouteFresh(token);
  };
}

export function feedbackKindForError(error) {
  if (Number(error?.status) === 409 || /\bconflict\b/i.test(error?.message || "")) {
    return "conflict";
  }
  if (
    [400, 422].includes(Number(error?.status)) ||
    /\bvalidation\b|\brequired\b|\binvalid\b/i.test(error?.message || "")
  ) {
    return "validation";
  }
  return "error";
}
