export function createFeedbackShell({
  documentRef,
  HTMLElementClass,
  labelizeWorkValue,
  requestAnimationFrameImpl,
  setStatus,
  setTimeoutImpl,
  clearTimeoutImpl,
}) {
  const confirmModal = documentRef.querySelector("#confirm-modal");
  const confirmMessage = documentRef.querySelector("#confirm-message");
  const confirmBackdrop = documentRef.querySelector("#confirm-backdrop");
  const confirmOk = documentRef.querySelector("#confirm-ok");
  const confirmCancel = documentRef.querySelector("#confirm-cancel");
  const undoToast = documentRef.querySelector("#undo-toast");
  const undoToastText = documentRef.querySelector("#undo-toast-text");
  const undoToastButton = documentRef.querySelector("#undo-toast-button");
  const errorToast = documentRef.querySelector("#error-toast");
  const errorToastText = documentRef.querySelector("#error-toast-text");
  const errorToastClose = documentRef.querySelector("#error-toast-close");
  let confirmResolve = null;
  let confirmOpener = null;
  let undoTimer = null;
  let undoAction = null;
  let errorTimer = null;

  function resolveConfirm(value) {
    if (!confirmResolve) return;
    const resolve = confirmResolve;
    const opener = confirmOpener;
    confirmResolve = null;
    confirmOpener = null;
    confirmModal.hidden = true;
    requestAnimationFrameImpl(() => {
      if (opener?.isConnected) opener.focus();
      resolve(value);
    });
  }

  confirmBackdrop.addEventListener("click", () => resolveConfirm(false));
  confirmCancel.addEventListener("click", () => resolveConfirm(false));
  confirmOk.addEventListener("click", () => resolveConfirm(true));
  documentRef.addEventListener("keydown", (event) => {
    if (confirmModal.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      resolveConfirm(false);
    } else if (event.key === "Tab") {
      event.preventDefault();
      const next =
        documentRef.activeElement === confirmCancel && !event.shiftKey
          ? confirmOk
          : confirmCancel;
      next.focus();
    }
  });

  function confirmDialog(
    message,
    { okText = "Confirm", cancelText = "Cancel", danger = false } = {},
  ) {
    return new Promise((resolve) => {
      confirmOpener =
        documentRef.activeElement instanceof HTMLElementClass
          ? documentRef.activeElement
          : null;
      confirmMessage.textContent = message;
      confirmOk.textContent = okText;
      confirmCancel.textContent = cancelText;
      confirmOk.classList.toggle("is-danger", Boolean(danger));
      confirmModal.hidden = false;
      confirmResolve = resolve;
      confirmCancel.focus();
    });
  }

  function renderEntityLoadState(
    container,
    { kind, id, status, error, retry, returnToList },
  ) {
    const state = documentRef.createElement("section");
    state.className = `entity-route-state entity-route-${status}`;
    state.tabIndex = -1;
    state.setAttribute("role", status === "error" ? "alert" : "status");
    const heading = documentRef.createElement("h3");
    heading.textContent =
      status === "not-found"
        ? `${labelizeWorkValue(kind)} not found`
        : status === "mismatch"
          ? "Task and card do not match"
          : `${labelizeWorkValue(kind)} unavailable`;
    const detail = documentRef.createElement("p");
    detail.textContent =
      status === "not-found"
        ? `No ${kind} exists with ID ${id}. It may be stale or no longer available.`
        : `${error || `Could not load ${kind}.`} Requested ID: ${id}.`;
    const actions = documentRef.createElement("div");
    actions.className = "entity-route-actions";
    const retryButton = documentRef.createElement("button");
    retryButton.type = "button";
    retryButton.textContent = "Retry";
    retryButton.addEventListener("click", retry);
    const returnButton = documentRef.createElement("button");
    returnButton.type = "button";
    const destination =
      kind === "intake"
        ? "Inbox"
        : kind === "template"
          ? "templates"
          : kind === "card" || kind === "task/card"
            ? "cards"
            : `${kind}s`;
    returnButton.textContent = `Return to ${destination}`;
    returnButton.addEventListener("click", returnToList);
    actions.append(retryButton, returnButton);
    state.append(heading, detail, actions);
    container.replaceChildren(state);
    requestAnimationFrameImpl(() => state.focus());
    return state;
  }

  function renderEntityLoadingState(container, kind, id) {
    const state = documentRef.createElement("section");
    state.className = "entity-route-state entity-route-loading";
    state.setAttribute("role", "status");
    state.textContent = `Loading ${kind} ${id}…`;
    container.replaceChildren(state);
  }

  function hideUndoToast() {
    undoToast.hidden = true;
    undoAction = null;
    if (undoTimer) {
      clearTimeoutImpl(undoTimer);
      undoTimer = null;
    }
  }

  undoToastButton.addEventListener("click", () => {
    if (!undoAction) return;
    const action = undoAction;
    undoAction = null;
    hideUndoToast();
    action();
  });

  function showUndoToast(message, restoreFn) {
    undoToastText.textContent = message;
    undoAction = restoreFn;
    undoToast.hidden = false;
    if (undoTimer) clearTimeoutImpl(undoTimer);
    undoTimer = setTimeoutImpl(hideUndoToast, 8000);
  }

  errorToastClose.addEventListener("click", () => {
    errorToast.hidden = true;
  });

  function showErrorToast(message) {
    errorToastText.textContent = message;
    errorToast.hidden = false;
    if (errorTimer) clearTimeoutImpl(errorTimer);
    errorTimer = setTimeoutImpl(() => {
      errorToast.hidden = true;
    }, 10000);
  }

  function reportError(message) {
    setStatus(message);
    showErrorToast(message);
  }

  return {
    confirmDialog,
    renderEntityLoadState,
    renderEntityLoadingState,
    reportError,
    showErrorToast,
    showUndoToast,
  };
}
