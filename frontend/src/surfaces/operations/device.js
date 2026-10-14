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
  function switchAccount() {
    const next = `/device${code ? `?userCode=${encodeURIComponent(formatUserCode(code))}` : ""}`;
    locationRef.assign(`/login?return_to=${encodeURIComponent(next)}`);
  }
  function updateIdentity() {
    identity.replaceChildren(el("span", "", actor?.email || "Not signed in"));
    const link = el("a", "", actor ? "Switch account" : "Sign in");
    link.href = `/login?return_to=${encodeURIComponent(`/device${code ? `?userCode=${formatUserCode(code)}` : ""}`)}`;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      switchAccount();
    });
    identity.append(link);
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
    wrap.append(heading, el("p", "dk-auth-card__lede", lede));
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
        failure.message,
      );
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
          recovery.textContent = seconds
            ? `Try again (${seconds}s)`
            : "Try again";
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
        const icon = el("span", "dk-auth-card__success", "✓");
        icon.setAttribute("aria-hidden", "true");
        heading.prepend(icon);
        const block = el("div", "dk-code-block");
        const command = el("code", "", "dataops logout");
        command.id = "device-logout-command";
        const copy = button("Copy", false, () => {});
        copy.dataset.dkCopy = "#device-logout-command";
        block.append(command, copy);
        card.append(
          block,
          el("p", "dk-hint", "Run this on that machine to sign it out."),
        );
        const foot = el("footer", "dk-auth-card__foot");
        const link = el("a", "", "Manage CLI sessions");
        link.href = "/device/sessions";
        foot.append(link);
        card.append(foot);
      }
    } else if (phase === "review") {
      heading = head(
        "Authorize this device?",
        `It will be able to act as ${actor?.email || "your signed-in account"} in DataOps for 90 days, until you sign it out.`,
      );
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
          `${started.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${minutes} min ago`,
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
        warning.append(
          el(
            "p",
            "",
            "This request came from a different network. Only continue if you started this login yourself on that machine.",
          ),
        );
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
        warning.append(label);
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
    else if (error.status === 401)
      failure = {
        kind: "signin",
        title: "Sign in to continue",
        message:
          "Sign in to DataOps to authorize this device. You'll come back here with your code.",
        action: "Sign in",
        tone: "warning",
      };
    else if (error.status === 429) {
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
    code = formatUserCode(url.searchParams.get("userCode") || "");
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
