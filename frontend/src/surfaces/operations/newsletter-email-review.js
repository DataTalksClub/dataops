// The full rendered email at /newsletter-issues/<issueId>/preview, for review.
//
// Shows the email exactly as DataOps renders it for sending (subject, inbox
// preview, the whole HTML at desktop or phone width), what still blocks
// approval, and the owner's steps: approve this exact revision, send a test to
// the owner's own mailbox, confirm it arrived and looks right, then schedule
// the frozen payload through Relay with one action (default: the next Monday
// 10:00 Berlin, adjustable in place), or cancel a schedule.
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

export const SEND_ZONE = "Europe/Berlin";
const MIN_LEAD_MS = 15 * 60_000;

/** Berlin wall-clock parts of an instant. */
function berlinParts(ms) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: SEND_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}`, weekday: get("weekday") };
}

/** A Berlin date ("2027-03-08") and time ("10:00") as a UTC ISO instant, correct across DST changes. */
export function berlinToIso(date, time) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  const t = /^(\d{2}):(\d{2})$/.exec(String(time || ""));
  if (!d || !t) return "";
  const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  let guess = wall;
  for (let i = 0; i < 3; i += 1) {
    const seen = berlinParts(guess);
    const [y, m, day] = seen.date.split("-").map(Number);
    const [h, min] = seen.time.split(":").map(Number);
    guess -= Date.UTC(y, m - 1, day, h, min) - wall;
  }
  const check = berlinParts(guess);
  return check.date === date && check.time === time ? new Date(guess).toISOString() : "";
}

/** "Mon 30 Nov, 10:00 Berlin" */
export function berlinLabel(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: SEND_ZONE, weekday: "short", day: "numeric", month: "short" }).format(new Date(ms)).replace(/,/g, "");
  return `${day}, ${berlinParts(ms).time} Berlin`;
}

/**
 * The default send time: 10:00 Berlin on the issue's publication date when
 * that is still at least 15 minutes ahead, otherwise on the next Monday that is.
 */
export function defaultSendTime(nowMs, publicationDate = "") {
  const fromIssue = publicationDate ? berlinToIso(publicationDate, "10:00") : "";
  if (fromIssue && Date.parse(fromIssue) - nowMs >= MIN_LEAD_MS) return fromIssue;
  for (let days = 0; days < 15; days += 1) {
    const parts = berlinParts(nowMs + days * 86_400_000);
    if (parts.weekday !== "Mon") continue;
    const iso = berlinToIso(parts.date, "10:00");
    if (iso && Date.parse(iso) - nowMs >= MIN_LEAD_MS) return iso;
  }
  return "";
}

export function berlinDateTime(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? berlinParts(ms) : { date: "", time: "" };
}

export function createNewsletterEmailReview({
  documentRef,
  request,
  locationRef,
  confirmFn = (message) => globalThis.confirm(message),
  cryptoRef = globalThis.crypto,
  nowFn = () => Date.now(),
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
  /** The send time the owner picked with "Change time"; empty means the default. */
  let chosenAt = "";
  let changingTime = false;

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
      if (["draft_changed", "approval_required", "test_receipt_required", "test_send_required"].includes(error.code)) {
        // Show the current email instead of the one that is no longer current.
        try {
          await load();
          paint();
        } catch {
          // keep the page as it is; the message below still explains the refusal
        }
      }
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

  /** Step 2: a test to the owner's own mailbox, then the owner confirms it arrived and looks right. */
  function testStep() {
    const box = el("div", "newsletter-review__step");
    box.dataset.testStep = "";
    const approval = draft.approval;
    const receipt = draft.testReceipt || { state: "none" };
    const last = draft.lastTest;
    const lastIsCurrent = Boolean(last && last.payloadHash === approval.payloadHash && last.approvedVersion === approval.draftVersion);
    if (receipt.state === "current") {
      const done = el("span", "dk-badge dk-badge--success", `Test received and confirmed, ${formatWhen(receipt.receivedAt)}`);
      done.dataset.testReceiptState = "current";
      box.append(done);
    }
    const send = button(lastIsCurrent ? "Send another test to me" : "Send test to me", receipt.state === "current" ? "secondary" : "primary", "test-send");
    send.dataset.testSend = "";
    send.addEventListener("click", () => act(async () => {
      const result = await request(api("/test-send"), { method: "POST", body: JSON.stringify({ requestId: requestId(cryptoRef) }) });
      const sent = result.testSend.status === "provider_accepted";
      return sent
        ? `Test sent to ${result.testSend.emails.join(", ")}. When it arrives and looks right, confirm it below.`
        : `The test was not accepted by Relay (${result.testSend.status}).`;
    }, "Sending the test through Relay…"));
    box.append(el("p", "dk-hint", `Tests go only to ${draft.testRecipient || "the owner"}.`), send);
    if (lastIsCurrent && receipt.state !== "current") {
      if (last.status === "provider_accepted") {
        box.append(el("p", "", `Test sent ${formatWhen(last.at)}. Did it arrive, and does it look right?`));
        const confirm = button("I received the test — it looks right", "primary", "test-receipt");
        confirm.dataset.testReceipt = "";
        confirm.addEventListener("click", () => act(async () => {
          await request(api("/test-receipt"), {
            method: "POST",
            body: JSON.stringify({ version: approval.draftVersion, payloadHash: approval.payloadHash, testRequestId: last.requestId }),
          });
          return "Test confirmed. You can schedule this exact email now.";
        }, "Recording that the test arrived…"));
        box.append(confirm);
      } else {
        box.append(el("p", "dk-field-error", `The last test was not delivered (${last.status}). Send it again.`));
      }
    }
    return box;
  }

  /** Step 3: exactly one Schedule action, labelled with its time; "Change time" adjusts it in place. */
  function scheduleStep() {
    const box = el("div", "newsletter-review__step newsletter-review__schedule");
    box.dataset.scheduleStep = "";
    const fallback = defaultSendTime(nowFn(), issue?.publicationDate || "");
    const at = chosenAt || fallback;
    const ready = draft.testReceipt?.state === "current";
    const go = button(at ? `Schedule for ${berlinLabel(at)}` : "Schedule", "primary", "schedule");
    go.dataset.schedule = "";
    go.dataset.scheduledAt = at;
    go.disabled = !ready || !at;
    box.append(go);
    if (!ready) {
      const why = el("p", "dk-hint", "Scheduling unlocks once you confirm the test email of this approved version arrived.");
      why.dataset.scheduleReason = "";
      box.append(why);
    }
    const change = button(changingTime ? "Keep this time" : "Change time", "secondary", "change-time");
    change.dataset.changeTime = "";
    change.addEventListener("click", () => {
      changingTime = !changingTime;
      paint();
    });
    box.append(change);
    if (changingTime) {
      const form = el("form", "newsletter-review__when");
      form.dataset.scheduleForm = "";
      const parts = berlinDateTime(at);
      const dateLabel = el("label", "dk-label", "Date (Berlin)");
      const date = el("input", "dk-input");
      date.type = "date";
      date.name = "date";
      date.value = parts.date;
      dateLabel.append(date);
      const timeLabel = el("label", "dk-label", "Time (Berlin)");
      const time = el("input", "dk-input");
      time.type = "time";
      time.name = "time";
      time.value = parts.time;
      timeLabel.append(time);
      const use = button("Use this time", "secondary", "use-time");
      use.type = "submit";
      form.append(dateLabel, timeLabel, use);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const iso = berlinToIso(date.value, time.value);
        if (!iso) return say("Pick a valid date and time (Berlin).", "danger");
        if (Date.parse(iso) - nowFn() < MIN_LEAD_MS) return say("Pick a time at least 15 minutes from now.", "danger");
        chosenAt = iso;
        changingTime = false;
        paint();
        return say(`Send time set to ${berlinLabel(iso)}.`, "info");
      });
      box.append(form);
    }
    go.addEventListener("click", () => {
      const question = `Schedule the approved email for ${berlinLabel(at)} to the Relay audience "${draft.relayAudience}"? `
        + "Relay sends it then. Editing the draft before that cancels the schedule.";
      if (!confirmFn(question)) return undefined;
      return act(async () => {
        const payload = { scheduledAt: at, payloadHash: render.payloadHash, version: draft.version, requestId: requestId(cryptoRef) };
        const result = await request(api("/schedule"), { method: "POST", body: JSON.stringify(payload) });
        chosenAt = "";
        return `Scheduled. Relay confirms it will send on ${berlinLabel(result.delivery.scheduledAt)}.`;
      }, "Scheduling in Relay…");
    });
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
      panel.append(el("p", "dk-hint", "Only the owner approves, tests and schedules the newsletter, signed in personally."));
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

    if (draft.canApprove && state === "current" && !locked) panel.append(testStep(), scheduleStep());

    if (draft.delivery) {
      const delivery = draft.delivery;
      const box = el("div", "newsletter-review__delivery");
      box.dataset.delivery = delivery.state;
      const relayState = `${delivery.state}${delivery.relayStatus ? ` (${delivery.relayStatus})` : ""}`;
      const headline = delivery.state === "scheduled"
        ? `Scheduled in Relay for ${berlinLabel(delivery.scheduledAt)} (Relay status: ${delivery.relayStatus || "scheduled"})`
        : delivery.state === "cancelled"
          ? "Schedule cancelled in Relay; the email is a draft again."
          : `Relay: ${relayState} · ${berlinLabel(delivery.scheduledAt)}`;
      box.append(el("p", "", headline));
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
          if (!confirmFn("Cancel the scheduled send in Relay? The email goes back to draft.")) return undefined;
          return act(async () => {
            await request(api("/cancel"), { method: "POST", body: "{}" });
            return "Schedule cancelled in Relay. The email is a draft again.";
          }, "Cancelling in Relay…");
        });
        box.append(refresh, cancel);
      }
      panel.append(box);
    }
    const tech = el("details", "newsletter-review__tech");
    const techLines = [`Draft v${draft.version} · payload sha256 ${render.payloadHash}`];
    if (draft.delivery?.campaignKey) techLines.push(`Relay campaign ${draft.delivery.campaignKey} · ${formatWhen(draft.delivery.scheduledAt)} UTC`);
    tech.append(el("summary", "", "Technical details"), ...techLines.map((line) => el("p", "dk-mono", line)));
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
