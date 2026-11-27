// The full rendered email at /newsletter-issues/<issueId>/preview, for review.
//
// Shows the email exactly as DataOps renders it for sending (subject, inbox
// preview, the whole HTML at desktop or phone width), what still blocks
// approval, and the owner's actions: approve this exact revision, then send a
// test or schedule the frozen payload through Relay, or cancel a schedule.
// Staff-only (the page needs a DataOps session); nothing here edits content.

import { createDom, failureText, formatWhen } from "./newsletter-editor-dom.js";

const enc = encodeURIComponent;

function extractIssueId(pathname) {
  const match = /^\/newsletter-issues\/([^/?#]+)\/preview\/?$/.exec(String(pathname || ""));
  return match ? decodeURIComponent(match[1]) : "";
}

function requestId(cryptoRef) {
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** A datetime-local value ("2027-01-10T09:00") read in the browser's zone, as an ISO instant with offset. */
export function localToIso(value) {
  const at = new Date(String(value || ""));
  return Number.isNaN(at.getTime()) ? "" : at.toISOString();
}

export function createNewsletterEmailReview({
  documentRef,
  request,
  locationRef,
  confirmFn = (message) => globalThis.confirm(message),
  cryptoRef = globalThis.crypto,
}) {
  const root = documentRef.querySelector("#newsletter-preview-root");
  const identity = documentRef.querySelector("#newsletter-preview-identity");
  const dom = createDom(documentRef);
  const { el, button } = dom;
  let issueId = "";
  let issue = null;
  let draft = null;
  let render = null;
  let width = "desktop";
  let note = { text: "", tone: "info" };

  const api = (suffix = "") => `/api/newsletter-issues/${enc(issueId)}/draft${suffix}`;

  function say(text, tone = "info") {
    note = { text, tone };
    const status = root.querySelector("[data-review-status]");
    if (status) {
      status.textContent = text;
      status.dataset.tone = tone;
    }
  }

  async function load() {
    const [issueData, draftData, renderData] = await Promise.all([
      request(`/api/newsletter-issues/${enc(issueId)}`),
      request(api()),
      request(api("/render")),
    ]);
    issue = issueData;
    draft = draftData.draft;
    render = renderData.render;
  }

  async function act(run, busyText) {
    say(busyText);
    try {
      const message = await run();
      await load();
      paint();
      say(message, "success");
    } catch (error) {
      say(failureText(error), "danger");
    }
  }

  function envelope() {
    const box = el("dl", "dk-card newsletter-review__envelope");
    box.dataset.envelope = "";
    box.append(
      el("dt", "", "Subject"), el("dd", "", render.subject || "(no subject yet)"),
      el("dt", "", "Inbox preview"), el("dd", "", render.previewText || "(none)"),
    );
    return box;
  }

  function frameBox() {
    const box = el("div", "newsletter-review__canvas");
    const toggles = el("div", "newsletter-review__widths");
    toggles.setAttribute("role", "group");
    toggles.setAttribute("aria-label", "Preview width");
    for (const [value, label] of [["desktop", "Desktop"], ["mobile", "Phone"]]) {
      const choice = button(label, value === width ? "primary" : "secondary", `width-${value}`);
      choice.dataset.width = value;
      choice.setAttribute("aria-pressed", String(value === width));
      choice.addEventListener("click", () => {
        width = value;
        paint();
      });
      toggles.append(choice);
    }
    const frame = el("iframe", `newsletter-review__frame newsletter-review__frame--${width}`);
    frame.title = "Rendered email";
    frame.setAttribute("sandbox", "");
    frame.srcdoc = render.html;
    frame.dataset.emailFrame = "";
    box.append(toggles, frame);
    return box;
  }

  function approvalPanel() {
    const panel = el("section", "dk-card newsletter-review__panel");
    panel.dataset.reviewPanel = "";
    panel.append(el("h2", "newsletter-review__panel-title", "Review"));
    const state = draft.approval?.state || "none";
    const approvedBy = `Approved by ${draft.approval?.approvedByName || draft.approval?.approvedBy}, ${formatWhen(draft.approval?.approvedAt)}`;
    const badgeText = state === "current" ? approvedBy : state === "stale" ? "Approval out of date" : "Not approved";
    const tone = state === "current" ? "dk-badge--success" : state === "stale" ? "dk-badge--warning" : "";
    const badge = el("span", `dk-badge ${tone}`.trim(), badgeText);
    badge.dataset.approvalState = state;
    panel.append(badge);

    if (render.problems?.length) {
      const list = el("ul", "newsletter-review__problems");
      list.dataset.problems = "";
      for (const problem of render.problems) list.append(el("li", "", problem.message));
      panel.append(el("p", "dk-hint", "Finish these in the editor before approval:"), list);
    }

    const locked = draft.locked;
    if (!draft.canApprove) {
      panel.append(el("p", "dk-hint", "Only the owner approves, test-sends and schedules the newsletter, signed in personally."));
    } else if (state !== "current" && !locked) {
      const form = el("form", "newsletter-review__approve");
      form.dataset.approveForm = "";
      const label = el("label", "dk-label", "Approval note (optional)");
      const text = el("textarea", "dk-textarea");
      text.name = "note";
      text.rows = 2;
      label.append(text);
      const approve = button("Approve this version", "primary", "approve");
      approve.type = "submit";
      approve.dataset.approve = "";
      approve.disabled = Boolean(render.problems?.length);
      form.append(label, approve);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        return act(async () => {
          await request(api("/approve"), { method: "POST", body: JSON.stringify({ version: draft.version, payloadHash: render.payloadHash, note: text.value }) });
          return "Approved. This exact email is what Relay will receive; any later edit withdraws the approval.";
        }, "Approving…");
      });
      panel.append(form);
    }

    if (draft.canApprove && state === "current" && !locked) {
      const test = el("form", "newsletter-review__test");
      test.dataset.testSendForm = "";
      const label = el("label", "dk-label", "Send a test to (one or two allow-listed addresses, comma-separated)");
      const input = el("input", "dk-input");
      input.name = "emails";
      input.value = "alexey@datatalks.club";
      label.append(input);
      const send = button("Send test", "secondary", "test-send");
      send.type = "submit";
      send.dataset.testSend = "";
      test.append(label, send);
      test.addEventListener("submit", (event) => {
        event.preventDefault();
        const emails = input.value.split(",").map((value) => value.trim()).filter(Boolean);
        return act(async () => {
          const result = await request(api("/test-send"), { method: "POST", body: JSON.stringify({ emails, requestId: requestId(cryptoRef) }) });
          return `Test ${result.testSend.status === "provider_accepted" ? "sent" : result.testSend.status} to ${result.testSend.emails.join(", ")} via Relay.`;
        }, "Sending the test through Relay…");
      });

      const schedule = el("form", "newsletter-review__schedule");
      schedule.dataset.scheduleForm = "";
      const when = el("label", "dk-label", "Send at (your local time)");
      const at = el("input", "dk-input");
      at.type = "datetime-local";
      at.name = "scheduledAt";
      at.required = true;
      when.append(at);
      const go = button("Schedule in Relay", "primary", "schedule");
      go.type = "submit";
      go.dataset.schedule = "";
      schedule.append(when, go);
      schedule.addEventListener("submit", (event) => {
        event.preventDefault();
        const iso = localToIso(at.value);
        if (!iso) return say("Pick the date and time to send.", "danger");
        const question = `Schedule the approved email for ${new Date(iso).toString()} to the Relay audience "${draft.relayAudience}"? `
          + "Relay sends it then; you can cancel until sending starts.";
        if (!confirmFn(question)) return undefined;
        return act(async () => {
          const payload = { scheduledAt: iso, payloadHash: render.payloadHash, version: draft.version, requestId: requestId(cryptoRef) };
          const result = await request(api("/schedule"), { method: "POST", body: JSON.stringify(payload) });
          return `Scheduled in Relay (campaign ${result.delivery.campaignKey}) for ${formatWhen(result.delivery.scheduledAt)} UTC.`;
        }, "Scheduling in Relay…");
      });
      panel.append(test, schedule);
    }

    if (draft.delivery) {
      const delivery = draft.delivery;
      const box = el("div", "newsletter-review__delivery");
      box.dataset.delivery = delivery.state;
      const relayState = `${delivery.state}${delivery.relayStatus ? ` (${delivery.relayStatus})` : ""}`;
      box.append(el("p", "", `Relay: ${relayState} · ${formatWhen(delivery.scheduledAt)} UTC · campaign ${delivery.campaignKey}`));
      if (delivery.error) box.append(el("p", "dk-field-error", delivery.error));
      if (draft.canApprove && (delivery.state === "scheduled" || delivery.state === "failed")) {
        const refresh = button("Refresh status", "secondary", "refresh");
        refresh.addEventListener("click", () => act(async () => {
          await request(api("/delivery?refresh=1"));
          return "Status refreshed from Relay.";
        }, "Reading Relay…"));
        const cancel = button("Cancel schedule", "danger", "cancel");
        cancel.dataset.cancelSchedule = "";
        cancel.addEventListener("click", () => {
          if (!confirmFn("Cancel the scheduled send in Relay? The draft becomes editable again.")) return undefined;
          return act(async () => {
            await request(api("/cancel"), { method: "POST", body: "{}" });
            return "Schedule cancelled in Relay. The draft is editable again.";
          }, "Cancelling in Relay…");
        });
        box.append(refresh, cancel);
      }
      panel.append(box);
    }
    const tech = el("details", "newsletter-review__tech");
    tech.append(el("summary", "", "Technical details"), el("p", "dk-mono", `Draft v${draft.version} · payload sha256 ${render.payloadHash}`));
    panel.append(tech);
    return panel;
  }

  function paint() {
    root.replaceChildren();
    const head = el("div", "newsletter-review__head");
    head.append(el("h1", "newsletter-review__title", issue.label || "Newsletter email"));
    const back = el("a", "dk-link", "Back to the editor");
    back.href = `/newsletter/${enc(issueId)}`;
    back.dataset.editorLink = "";
    head.append(back);
    const status = el("p", "newsletter-review__status");
    status.setAttribute("role", "status");
    status.dataset.reviewStatus = "";
    status.textContent = note.text;
    status.dataset.tone = note.tone;
    const layout = el("div", "newsletter-review__layout");
    const main = el("div", "newsletter-review__main");
    main.append(envelope(), frameBox());
    layout.append(main, approvalPanel());
    root.append(head, status, layout);
  }

  async function start() {
    issueId = extractIssueId(locationRef.pathname);
    if (!issueId) {
      root.replaceChildren(el("p", "dk-field-error", "This is not a newsletter issue link."));
      return;
    }
    if (identity) identity.textContent = "";
    root.replaceChildren(el("p", "dk-hint", "Loading the email…"));
    try {
      await load();
      paint();
    } catch (error) {
      const message = error.code === "draft_missing"
        ? "This issue has no email draft yet. Start it on the issue page."
        : `The email is unavailable: ${error.message}`;
      root.replaceChildren(el("p", error.code === "draft_missing" ? "dk-hint" : "dk-field-error", message));
    }
  }

  return { start };
}
