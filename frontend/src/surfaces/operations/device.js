import {
  renderSurfaceSummary,
  setControlPending,
} from "../operations-overview.js";

export function createDeviceAuthSurface(context) {
  const {
    clearSelectionButton,
    documentList,
    getActiveWorkspaceRoute,
    libraryTitle,
    renderSurfaceHeader,
    request,
    setRouteTitle,
    workApiUrl,
  } = context;

  // Confirming a device code is the one place a browser session is exchanged
  // for a long-lived credential, so the page states plainly what is being
  // authorized and never acts on the URL alone.
  let state = { userCode: "", grant: null, error: "", result: "", pending: "" };
  let primedCode = null;
  let requestedFocus = "";
  // Every lookup and decision carries the token it started with. A response
  // that belongs to an earlier code, or to a code the operator has since
  // replaced, is dropped instead of overwriting what is on screen now.
  let requestSequence = 0;

  function applyRequestedFocus(wrap) {
    if (!requestedFocus) return;
    const target = wrap.querySelector(requestedFocus);
    requestedFocus = "";
    if (!target) return;
    target.tabIndex = -1;
    target.focus();
  }

  function renderDeviceSurfaceView() {
    primeFromRoute();
    documentList.classList.add("is-operations-home");
    documentList.classList.remove("is-unified-search");
    libraryTitle.textContent = "Authorize device";
    setRouteTitle("Authorize device");
    clearSelectionButton.hidden = true;

    const wrap = document.createElement("div");
    wrap.className = "operations-home ops-surface ops-surface-device";
    wrap.append(
      renderSurfaceHeader(
        "Authorize device",
        "Confirm the code shown by a DataOps CLI so it can act as you.",
      ),
      renderDeviceSummary(),
      renderDevicePanel(),
    );
    documentList.replaceChildren(wrap);
    applyRequestedFocus(wrap);
  }

  // The device page says what it is doing while it is doing it: a code being
  // checked, a decision being sent, and a finished decision are three different
  // states, and none of them is inferred from an empty panel.
  function renderDeviceSummary() {
    const view = { id: "device", label: "Authorize device" };
    if (state.pending === "lookup") {
      return renderSurfaceSummary({
        ...view,
        state: "loading",
        message: "Checking that code with the work API…",
      });
    }
    if (state.pending === "decision") {
      return renderSurfaceSummary({
        ...view,
        state: "loading",
        message: "Sending your decision to the work API…",
      });
    }
    if (state.result) {
      return renderSurfaceSummary({
        ...view,
        state: "ready",
        message:
          state.result === "approved"
            ? "This machine is authorized."
            : "Nothing was authorized.",
      });
    }
    if (state.grant) {
      return renderSurfaceSummary({
        ...view,
        state: "ready",
        message: "Confirm that this machine should act as you.",
      });
    }
    return renderSurfaceSummary({
      ...view,
      state: "ready",
      message: "Enter the code shown by the DataOps CLI, then select Continue.",
    });
  }

  function renderDevicePanel() {
    const panel = document.createElement("section");
    panel.className = "ops-section device-panel";
    panel.setAttribute("aria-label", "Device authorization");

    if (state.result) {
      panel.append(renderOutcome());
      return panel;
    }

    const form = document.createElement("form");
    form.className = "device-form";
    form.addEventListener("submit", (event) => event.preventDefault());
    const label = document.createElement("label");
    label.className = "quick-form-label";
    label.textContent = "Code from the CLI";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "device-code-input";
    input.value = state.userCode;
    input.placeholder = "XXXX-XXXX";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", "Device code");
    input.addEventListener("input", () => {
      state.userCode = input.value;
    });
    label.append(input);
    form.append(label);

    const lookup = document.createElement("button");
    lookup.type = "submit";
    lookup.className = "primary-button";
    lookup.textContent = "Continue";
    form.addEventListener("submit", () => loadGrant(input.value));
    if (state.pending === "lookup") {
      input.disabled = true;
      setControlPending(lookup, {
        pending: true,
        pendingLabel: "Checking code…",
      });
    }
    form.append(lookup);
    panel.append(form);

    if (state.error) {
      const error = document.createElement("p");
      error.className = "device-error";
      error.setAttribute("role", "alert");
      error.textContent = state.error;
      panel.append(error);
    }

    if (state.grant) panel.append(renderConfirmation());
    return panel;
  }

  function renderConfirmation() {
    const confirm = document.createElement("div");
    confirm.className = "device-confirm";

    const heading = document.createElement("h3");
    heading.textContent = "Authorize this machine?";
    confirm.append(heading);

    const facts = document.createElement("dl");
    facts.className = "device-facts";
    for (const [term, value] of [
      ["Machine", state.grant.label],
      ["Requested from", state.grant.requestIp],
      ["Started", new Date(state.grant.createdAt).toLocaleString()],
    ]) {
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = value;
      facts.append(dt, dd);
    }
    confirm.append(facts);

    const warning = document.createElement("p");
    warning.className = "device-warning";
    warning.textContent =
      "Only continue if you started this login yourself. Approving gives this machine a token that acts as you for 90 days.";
    confirm.append(warning);

    const actions = document.createElement("div");
    actions.className = "device-actions";
    const deny = document.createElement("button");
    deny.type = "button";
    deny.className = "quiet-button";
    deny.textContent = "Deny";
    deny.disabled = state.pending === "decision";
    deny.addEventListener("click", () => decide(false));
    const approve = document.createElement("button");
    approve.type = "button";
    approve.className = "primary-button";
    approve.textContent = "Authorize";
    approve.disabled = state.pending === "decision";
    approve.addEventListener("click", () => decide(true));
    actions.append(deny, approve);
    confirm.append(actions);
    return confirm;
  }

  function renderOutcome() {
    const outcome = document.createElement("div");
    outcome.className = "device-outcome";
    outcome.setAttribute("role", "status");
    const heading = document.createElement("h3");
    heading.textContent =
      state.result === "approved" ? "Device authorized" : "Device denied";
    const detail = document.createElement("p");
    detail.textContent =
      state.result === "approved"
        ? "Return to the terminal; the CLI finishes signing in on its next poll. Run `dataops logout` on that machine to revoke the token."
        : "Nothing was authorized. The code is now dead.";
    outcome.append(heading, detail);
    return outcome;
  }

  async function loadGrant(rawCode) {
    // Native forms deliver every submit listener even after the first one has
    // begun an async request, so the operation itself rejects duplicates.
    if (state.pending === "lookup") return;
    state.userCode = rawCode;
    state.error = "";
    state.grant = null;
    const code = String(rawCode || "").trim();
    if (!code) {
      state.error = "Enter the code shown by the CLI.";
      requestedFocus = ".device-code-input";
      renderDeviceSurfaceView();
      return;
    }
    const token = ++requestSequence;
    state.pending = "lookup";
    requestedFocus = ".surface-summary-line";
    // Paint the pending state before waiting. primeFromRoute has already
    // recorded the code it is priming, so this render cannot loop back into
    // another lookup.
    renderDeviceSurfaceView();
    let grant = null;
    let failure = "";
    try {
      grant = await request(
        workApiUrl("/api/auth/device/pending", { userCode: code }),
      );
    } catch (error) {
      if (error.status === 404 || error.status === 401) {
        // This page is already inside a signed-in portal session. A 401 here
        // is an unknown, expired, or unconfirmed code, not a prompt to sign in.
        failure =
          "That code is not waiting for confirmation. Refresh this page or retry device registration from the CLI.";
      } else {
        failure = `Could not look up that code: ${error.message || "request failed"}`;
      }
    }
    if (token !== requestSequence) return;
    state.pending = "";
    state.grant = grant;
    state.error = failure;
    requestedFocus = failure || !grant
      ? ".device-code-input"
      : ".surface-summary-line";
    renderDeviceSurfaceView();
  }

  async function decide(approve) {
    const label = approve ? "Authorize" : "Deny";
    const token = ++requestSequence;
    state.pending = "decision";
    requestedFocus = ".surface-summary-line";
    // Replace both controls with one pending owner before yielding, so a
    // second click cannot start another decision.
    renderDeviceSurfaceView();
    try {
      const result = await request(workApiUrl("/api/auth/device/approve"), {
        method: "POST",
        body: JSON.stringify({ userCode: state.userCode, approve }),
      });
      if (token !== requestSequence) return;
      state.result = result.status;
      state.grant = null;
      state.error = "";
    } catch (error) {
      if (token !== requestSequence) return;
      state.error = `Could not complete that: ${error.message || "request failed"} Select ${label} to retry.`;
    }
    state.pending = "";
    requestedFocus = state.result ? ".device-outcome" : ".device-error";
    renderDeviceSurfaceView();
  }

  /**
   * A link from the CLI carries the code so it only has to be checked, never
   * retyped. It pre-fills the field; the human still confirms.
   */
  function primeFromRoute() {
    const route = getActiveWorkspaceRoute();
    const userCode =
      route?.path === "/device" ? route.params.get("userCode") || "" : "";
    if (primedCode === userCode) return;
    primedCode = userCode;
    requestedFocus = "";
    // A new route wins: anything still in flight for the previous code is
    // discarded rather than allowed to land on this render.
    requestSequence += 1;
    state = { userCode, grant: null, error: "", result: "", pending: "" };
    if (userCode) loadGrant(userCode);
  }

  return { renderDeviceSurfaceView };
}
