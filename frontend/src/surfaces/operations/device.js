export function createDeviceAuthSurface(context) {
  const {
    clearSelectionButton,
    documentList,
    getActiveWorkspaceRoute,
    libraryTitle,
    renderSurfaceHeader,
    request,
    setPageTitle,
    setStatus,
    workApiUrl,
  } = context;

  // Confirming a device code is the one place a browser session is exchanged
  // for a long-lived credential, so the page states plainly what is being
  // authorized and never acts on the URL alone.
  let state = { userCode: "", grant: null, error: "", result: "" };
  let primedCode = null;

  function renderDeviceSurfaceView() {
    primeFromRoute();
    documentList.classList.add("is-operations-home");
    documentList.classList.remove("is-unified-search");
    libraryTitle.textContent = "Authorize device";
    setPageTitle("Authorize device", "Authorize device");
    clearSelectionButton.hidden = true;
    setStatus("Confirm a code shown by the DataOps CLI.");

    const wrap = document.createElement("div");
    wrap.className = "operations-home ops-surface ops-surface-device";
    wrap.append(
      renderSurfaceHeader(
        "Authorize device",
        "Confirm the code shown by a DataOps CLI so it can act as you.",
      ),
      renderDevicePanel(),
    );
    documentList.replaceChildren(wrap);
  }

  function renderDevicePanel() {
    const panel = document.createElement("section");
    panel.className = "ops-section device-panel";
    panel.setAttribute("aria-label", "Device authorization");

    if (state.result) {
      panel.append(renderOutcome());
      return panel;
    }

    const form = document.createElement("div");
    form.className = "device-form";
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
    lookup.type = "button";
    lookup.className = "primary-button";
    lookup.textContent = "Continue";
    lookup.addEventListener("click", () => loadGrant(input.value));
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
    deny.addEventListener("click", () => decide(false, deny));
    const approve = document.createElement("button");
    approve.type = "button";
    approve.className = "primary-button";
    approve.textContent = "Authorize";
    approve.addEventListener("click", () => decide(true, approve));
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
    state.userCode = rawCode;
    state.error = "";
    state.grant = null;
    const code = String(rawCode || "").trim();
    if (!code) {
      state.error = "Enter the code shown by the CLI.";
      renderDeviceSurfaceView();
      return;
    }
    try {
      state.grant = await request(
        workApiUrl("/api/auth/device/pending", { userCode: code }),
      );
    } catch (error) {
      if (error.status === 404) {
        state.error =
          "That code is not waiting for confirmation. It may have expired - start the login again.";
      } else if (error.status === 401) {
        state.error = "Sign in to the portal first, then open this link again.";
      } else {
        state.error = `Could not look up that code: ${error.message || "request failed"}`;
      }
    }
    renderDeviceSurfaceView();
  }

  async function decide(approve, button) {
    button.disabled = true;
    button.textContent = approve ? "Authorizing..." : "Denying...";
    try {
      const result = await request(workApiUrl("/api/auth/device/approve"), {
        method: "POST",
        body: JSON.stringify({ userCode: state.userCode, approve }),
      });
      state.result = result.status;
      state.grant = null;
    } catch (error) {
      state.error = `Could not complete that: ${error.message || "request failed"}`;
      button.disabled = false;
      button.textContent = approve ? "Authorize" : "Deny";
    }
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
    state = { userCode, grant: null, error: "", result: "" };
    if (userCode) loadGrant(userCode);
  }

  return { renderDeviceSurfaceView };
}
