import {
  bindCodeInput,
  normalizeUserCode,
  formatUserCode,
  describeUserCodeError,
} from "../../dakit/device-code.js";

// Matches the currently issued server alphabet, including L and V.
const alphabet = "BCDFGHJKLMNPQRSTVWXZ23456789";
export function createDevicePage({
  documentRef,
  request,
  locationRef,
  historyRef,
  now = Date.now,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
}) {
  const card = documentRef.querySelector("#device-card");
  const identity = documentRef.querySelector("#device-identity");
  let code = "",
    actor = null,
    grant = null,
    phase = "enter",
    pending = "",
    failure = null;
  let sequence = 0,
    timer = null,
    unbind = null,
    acknowledged = false,
    serverOffset = 0,
    announcedMinute = false;
  let lastRequest = () => lookup();
  let retryAt = 0;
  let prefilled = false;
  const el = (tag, className, text) => {
    const node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function appendMessage(node, message) {
    const [before, ...after] = message.split("dataops login");
    node.append(documentRef.createTextNode(before));
    if (after.length) node.append(el("code", "dk-mono", "dataops login"), documentRef.createTextNode(after.join("dataops login")));
  }
  // Kit icons are 24-grid outline glyphs; shapes are [tag, attributes] pairs.
  function strokeIcon(className, shapes) {
    const svgNs = "http://www.w3.org/2000/svg";
    const icon = documentRef.createElementNS(svgNs, "svg");
    const attributes = {
      class: className,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.8",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
    };
    for (const [name, value] of Object.entries(attributes)) icon.setAttribute(name, value);
    for (const [tag, shapeAttributes] of shapes) {
      const shape = documentRef.createElementNS(svgNs, tag);
      for (const [name, value] of Object.entries(shapeAttributes)) shape.setAttribute(name, value);
      icon.append(shape);
    }
    return icon;
  }
  function switchAccount() {
    const next = `/device${code ? `?code=${encodeURIComponent(formatUserCode(code))}` : ""}`;
    locationRef.assign(`/login?return_to=${encodeURIComponent(next)}`);
  }
  function updateIdentity() {
    identity.replaceChildren(el("span", "", actor?.email || "Not signed in"));
    const link = el("a", "", actor ? "Switch account" : "Sign in");
    link.href = `/login?return_to=${encodeURIComponent(`/device${code ? `?code=${formatUserCode(code)}` : ""}`)}`;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      switchAccount();
    });
    identity.append(documentRef.createTextNode(" · "), link);
  }
  function stopTimer() {
    if (timer !== null) clearIntervalImpl(timer);
    timer = null;
  }
  function head(title, lede, result = false) {
    const wrap = el("header", "dk-auth-card__head");
    if (result) wrap.setAttribute("role", "status");
    const heading = el("h1", "dk-auth-card__title", title);
    heading.tabIndex = -1;
    const description = el("p", "dk-auth-card__lede");
    if (Array.isArray(lede)) description.append(...lede);
    else appendMessage(description, lede);
    wrap.append(heading, description);
    card.append(wrap);
    return heading;
  }
  function button(text, primary, action) {
    const node = el(
      "button",
      `dk-button dk-button--lg dk-button--${primary ? "primary" : "secondary"}`,
      text,
    );
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  }
  function actions(...nodes) {
    const wrap = el("div", "dk-auth-card__actions");
    wrap.append(...nodes);
    card.append(wrap);
  }
  function render(focus = true) {
    unbind?.();
    unbind = null;
    stopTimer();
    card.replaceChildren();
    let heading;
    if (failure) {
      heading = head(failure.title, "");
      const alert = el(
        "div",
        `dk-callout${failure.tone ? ` dk-callout--${failure.tone}` : ""}`,
      );
      const sentence = el("span");
      appendMessage(sentence, failure.message);
      const body = el("div", "dk-callout__body");
      body.append(sentence);
      alert.append(body);
      alert.setAttribute("role", "alert");
      card.append(alert);
      const recovery = button(failure.action, true, () => {
        if (failure.kind === "signin") return switchAccount();
        if (failure.kind === "notfound" || failure.kind === "expired") {
          sequence++;
          code = "";
          grant = null;
          phase = "enter";
          prefilled = false;
          failure = null;
          render();
          return;
        }
        failure = null;
        lastRequest();
      });
      actions(recovery);
      if (retryAt > now()) {
        const tick = () => {
          const seconds = Math.max(0, Math.ceil((retryAt - now()) / 1000));
          recovery.disabled = seconds > 0;
          recovery.replaceChildren(documentRef.createTextNode("Try again"));
          if (seconds) recovery.append(documentRef.createTextNode(" "), el("span", "dk-mono", `(${seconds}s)`));
          if (!seconds) stopTimer();
        };
        tick();
        timer = setIntervalImpl(tick, 1000);
      }
    } else if (phase === "approved" || phase === "denied") {
      heading = head(
        phase === "approved" ? "Device authorized" : "Request denied",
        phase === "approved"
          ? "Return to your terminal. The CLI finishes signing in within a few seconds."
          : "Nothing was authorized and the code no longer works. If you meant to sign in, run dataops login again.",
        true,
      );
      if (phase === "approved") {
        const icon = strokeIcon("dk-auth-card__icon--success", [
          ["circle", { cx: "12", cy: "12", r: "10" }],
          ["path", { d: "m8 12 3 3 5-6" }],
        ]);
        heading.prepend(icon);
        const block = el("div", "dk-code-block");
        const command = el("code", "", "dataops logout");
        command.id = "device-logout-command";
        const copy = el("button", "dk-button dk-button--secondary dk-button--sm", "Copy");
        copy.type = "button";
        copy.dataset.dkCopy = "#device-logout-command";
        const pre = el("pre");
        pre.append(command);
        block.append(pre, copy);
        // The caption belongs to the command: one group at the field-hint gap.
        const commandGroup = el("div", "device-command");
        commandGroup.append(block, el("p", "dk-hint", "Run this on that machine to sign it out."));
        card.append(commandGroup);
        const foot = el("footer", "dk-auth-card__foot");
        const link = el("a", "", "Manage CLI sessions");
        link.href = "/device/sessions";
        foot.append(link);
        card.append(foot);
      }
    } else if (phase === "review") {
      // The address moves to its own line as a unit before it ever breaks
      // inside (at a hyphen), and only breaks when it can't fit at all.
      heading = head("Authorize this device?", [
        documentRef.createTextNode("It will be able to act as "),
        el("span", "device-address", actor?.email || "your signed-in account"),
        documentRef.createTextNode(" in DataOps for 90 days, until you sign it out."),
      ]);
      const facts = el("dl", "dk-dl");
      const started = new Date(grant.createdAt);
      const minutes = Math.max(
        0,
        Math.floor((now() + serverOffset - started.getTime()) / 60000),
      );
      for (const [label, value] of [
        ["Code", formatUserCode(code)],
        ["Machine", grant.label],
        ["Requested from", grant.requestIp],
        [
          "Started",
          `${started.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · ${minutes} min ago`,
        ],
        ["Expires in", ""],
      ]) {
        const dd = el("dd", "dk-mono");
        dd.append(el("span", "", value));
        if (label === "Machine")
          dd.append(
            el("small", "dk-auth-card__reported", "reported by the machine"),
          );
        if (label === "Expires in") {
          dd.id = "device-countdown";
          dd.setAttribute("aria-live", "off");
        }
        facts.append(el("dt", "", label), dd);
      }
      card.append(facts);
      const differentNetwork = grant.same_network === false;
      const deny = button(pending === "deny" ? "Denying…" : "Deny", false, () =>
        decide(false),
      );
      const approve = button(
        pending === "approve" ? "Authorizing…" : "Authorize",
        true,
        () => decide(true),
      );
      deny.disabled = Boolean(pending);
      approve.disabled =
        Boolean(pending) || (differentNetwork && !acknowledged);
      if (pending) {
        deny.setAttribute("aria-busy", "true");
        approve.setAttribute("aria-busy", "true");
      }
      if (differentNetwork) {
        const warning = el("div", "dk-callout dk-callout--warning");
        warning.id = "network-warning";
        const alert = strokeIcon("dk-callout__icon", [
          ["path", { d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 20h16a2 2 0 0 0 1.73-2" }],
          ["path", { d: "M12 9v4M12 17h.01" }],
        ]);
        const body = el("div", "dk-callout__body");
        body.append(
          el("span", "dk-callout__title", "This request came from a different network."),
          el("span", "", "Only continue if you started this login yourself on that machine."),
        );
        warning.append(alert, body);
        const label = el("label", "dk-check");
        const check = el("input");
        check.type = "checkbox";
        check.checked = acknowledged;
        check.addEventListener("change", () => {
          acknowledged = check.checked;
          approve.disabled = Boolean(pending) || !acknowledged;
        });
        label.append(
          check,
          el("span", "", "I started this login on that machine"),
        );
        body.append(label);
        card.append(warning);
        approve.setAttribute("aria-describedby", "network-warning");
      }
      actions(deny, approve);
      const foot = el("footer", "dk-auth-card__foot");
      foot.append(
        el("p", "", "Didn't start this? Deny it. Nothing is shared."),
      );
      const switchLink = el("a", "", "Switch account");
      switchLink.href = "/login";
      switchLink.addEventListener("click", (event) => {
        event.preventDefault();
        switchAccount();
      });
      const accountHint = el("p", "", "Wrong account? ");
      accountHint.append(switchLink);
      foot.append(accountHint);
      card.append(foot);
      const tick = () => {
        const seconds = Math.max(
          0,
          Math.ceil(
            (Date.parse(grant.expiresAt) - now() - serverOffset) / 1000,
          ),
        );
        const countdown = facts.querySelector("#device-countdown");
        countdown.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
        countdown.classList.toggle("dk-badge--warning", seconds < 60);
        countdown.classList.toggle("dk-badge", seconds < 60);
        if (seconds <= 60 && !announcedMinute) {
          announcedMinute = true;
          documentRef.querySelector("#dk-live").textContent =
            "One minute left to decide";
        }
        if (!seconds && !pending) {
          failure = {
            kind: "expired",
            title: "Code expired",
            message:
              "Codes last 10 minutes. Run dataops login again for a new one.",
            tone: "danger",
            action: "Enter another code",
          };
          render();
        }
      };
      timer = setIntervalImpl(tick, 1000);
      tick();
    } else {
      heading = head(
        "Authorize a device",
        "DataOps CLI asked to sign in as you. Enter the code shown in your terminal.",
      );
      const form = el("form", "dk-auth-card__body");
      const field = el("div", "dk-field");
      const label = el("label", "dk-label", "Device code");
      label.htmlFor = "device-code";
      const input = el("input", "dk-input dk-code-input");
      input.id = "device-code";
      input.value = formatUserCode(code);
      input.type = "text";
      input.placeholder = "XXXX-XXXX";
      for (const [key, value] of Object.entries({
        autocomplete: "off",
        autocapitalize: "characters",
        spellcheck: "false",
        inputmode: "text",
        enterkeyhint: "go",
        "aria-describedby": "device-code-hint device-code-error",
      }))
        input.setAttribute(key, value);
      const hint = el(
        "p",
        "dk-hint",
        prefilled ? "Check that this matches your terminal exactly." : "",
      );
      hint.id = "device-code-hint";
      const error = el("p", "dk-field-error");
      error.id = "device-code-error";
      error.setAttribute("role", "alert");
      const submit = el(
        "button",
        "dk-button dk-button--primary dk-button--lg",
        pending ? "Checking…" : "Continue",
      );
      submit.type = "submit";
      const update = (submitted = false) => {
        const result = normalizeUserCode(input.value, { alphabet });
        code = input.value;
        submit.disabled = !result.ok || Boolean(pending) || !actor;
        submit.setAttribute("aria-busy", String(Boolean(pending)));
        error.textContent =
          !result.ok && (submitted || result.error !== "too_short")
            ? describeUserCodeError(result)
            : "";
        input.setAttribute("aria-invalid", String(Boolean(error.textContent)));
      };
      unbind = bindCodeInput(input, { alphabet });
      input.addEventListener("dk-code-change", () => {
        sequence++;
        pending = "";
        submit.textContent = "Continue";
        update();
      });
      field.append(label, input, hint, error);
      form.append(field);
      const action = el("div", "dk-auth-card__actions");
      action.append(submit);
      form.append(action);
      card.append(form);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        update(true);
        if (!submit.disabled) lookup();
      });
      update();
    }
    if (focus && heading?.isConnected) heading.focus();
  }
  function fail(error) {
    if (error.status === 404 || error.status === 409)
      failure = {
        kind: "notfound",
        title: "Code not found",
        message:
          "This code is wrong, expired, or already used. Run dataops login again for a new one.",
        action: "Enter another code",
        tone: "danger",
      };
    else if (error.status === 401) {
      actor = null;
      updateIdentity();
      failure = {
        kind: "signin",
        title: "Sign in to continue",
        message:
          "Sign in to DataOps to authorize this device. You'll come back here with your code.",
        action: "Sign in",
        tone: "warning",
      };
    } else if (error.status === 429) {
      retryAt = now() + (error.retryAfter || 60) * 1000;
      failure = {
        kind: "ratelimit",
        title: "Slow down",
        message:
          "Too many codes tried from this account. Wait a few minutes and try again.",
        action: "Try again",
        tone: "warning",
      };
    } else
      failure = {
        kind: "network",
        title: "Couldn't reach DataOps",
        message:
          "Check your connection and try again. Your code is still valid until it expires.",
        action: "Try again",
      };
    render();
  }
  async function lookup() {
    if (pending || !actor) return;
    const normalized = normalizeUserCode(code, { alphabet });
    if (!normalized.ok) return;
    const token = ++sequence;
    pending = "lookup";
    lastRequest = lookup;
    const submit = card.querySelector('button[type="submit"]');
    if (submit) {
      submit.disabled = true;
      submit.textContent = "Checking…";
      submit.setAttribute("aria-busy", "true");
    }
    try {
      const result = await request(
        `/api/auth/device/pending?userCode=${encodeURIComponent(normalized.display)}`,
      );
      if (token !== sequence) return;
      grant = result;
      code = normalized.display;
      serverOffset = (result.serverNow || now()) - now();
      phase = "review";
      pending = "";
      acknowledged = false;
      announcedMinute = false;
      render();
    } catch (error) {
      if (token !== sequence) return;
      pending = "";
      fail(error);
    }
  }
  async function decide(approve) {
    if (
      pending ||
      phase !== "review" ||
      (approve && grant.same_network === false && !acknowledged)
    )
      return;
    const token = ++sequence;
    pending = approve ? "approve" : "deny";
    lastRequest = () => decide(approve);
    render(false);
    try {
      const result = await request("/api/auth/device/approve", {
        method: "POST",
        body: JSON.stringify({ userCode: code, approve }),
      });
      if (token !== sequence) return;
      pending = "";
      phase = result.status;
      grant = null;
      render();
    } catch (error) {
      if (token !== sequence) return;
      pending = "";
      fail(error);
    }
  }
  async function start() {
    const url = new URL(locationRef.href);
    code = formatUserCode(url.searchParams.get("code") || "");
    prefilled = Boolean(code);
    if (
      locationRef.hostname.includes(".lambda-url.") ||
      locationRef.hostname.endsWith(".on.aws")
    ) {
      url.host = "ops.dtcdev.click";
      url.protocol = "https:";
      locationRef.replace(url.toString());
      return;
    }
    url.search = "";
    historyRef.replaceState(null, "", url.pathname);
    render();
    await refreshIdentity();
  }
  async function refreshIdentity() {
    lastRequest = refreshIdentity;
    try {
      const data = await request("/api/me");
      actor = data.user || data;
      if (!actor?.email) throw new Error("Identity unavailable");
      updateIdentity();
      failure = null;
      const submit = card.querySelector('button[type="submit"]');
      if (phase === "enter" && submit) {
        submit.disabled = !normalizeUserCode(code, { alphabet }).ok;
      } else render();
    } catch (error) {
      actor = null;
      updateIdentity();
      fail(error);
    }
  }

  return {
    start,
    destroy: () => {
      sequence++;
      unbind?.();
      stopTimer();
    },
  };
}
