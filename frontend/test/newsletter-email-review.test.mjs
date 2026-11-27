import assert from "node:assert/strict";
import { test } from "node:test";
import {
  berlinLabel,
  berlinToIso,
  createNewsletterEmailReview,
  defaultSendTime,
} from "../src/surfaces/operations/newsletter-email-review.js";
import { FakeDocument, FakeElement, findByText } from "./support/fake-dom.mjs";

const ISSUE = "/api/newsletter-issues/iss";
const BASE = `${ISSUE}/draft`;
const render = (overrides = {}) => ({ subject: "Zoomcamp is back", previewText: "Free course", html: "<html>final</html>", text: "t", payloadHash: "p".repeat(64), problems: [], ...overrides });
const draft = (overrides = {}) => ({
  version: 5, locked: false, approval: { state: "none" }, testReceipt: { state: "none" }, lastTest: null, testRecipient: "alexey@datatalks.club",
  delivery: null, canApprove: true, relayAudience: "dtc", ...overrides,
});
// Friday 27 Nov 2026, 21:40 Berlin.
const NOW = Date.parse("2026-11-27T20:40:00Z");
const APPROVAL = { state: "current", approvedByName: "Alexey", draftVersion: 6, payloadHash: "p".repeat(64) };

function setup(routes, options = {}) {
  const root = new FakeElement("section");
  root.id = "newsletter-preview-root";
  const identity = new FakeElement("span");
  identity.id = "newsletter-preview-identity";
  const documentRef = new FakeDocument(root, identity);
  const calls = [];
  const request = async (url, init = {}) => {
    const method = init.method || "GET";
    calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined });
    const handler = routes[`${method} ${url}`];
    if (!handler) throw Object.assign(new Error(`no route ${method} ${url}`), { status: 404 });
    return handler(calls.at(-1));
  };
  const page = createNewsletterEmailReview({
    documentRef,
    request,
    locationRef: { pathname: "/newsletter-issues/iss/preview" },
    cryptoRef: { randomUUID: () => "req-0000-1111" },
    nowFn: () => NOW,
    ...options,
  });
  return { page, root, calls };
}

const base = (state) => ({
  [`GET ${ISSUE}`]: () => ({ id: "iss", label: "#900 · March 3, 2027" }),
  [`GET ${BASE}`]: () => ({ draft: state.draft }),
  [`GET ${BASE}/render`]: () => ({ render: state.render }),
});

test("shows the exact rendered email with its envelope at desktop and phone width", async () => {
  const state = { draft: draft(), render: render() };
  const { page, root } = setup(base(state));
  await page.start();
  assert.equal(root.querySelector("[data-email-frame]").srcdoc, "<html>final</html>");
  assert.equal(root.querySelector("[data-email-frame]").getAttribute("sandbox"), "");
  assert.ok(findByText(root, "Zoomcamp is back"));
  assert.equal(root.querySelector("[data-editor-link]").href, "/newsletter/iss");
  await root.querySelector('[data-width="mobile"]').dispatch("click");
  assert.ok(root.querySelector("[data-email-frame]").className.includes("--mobile"));
});

test("the owner approves the exact payload hash and version on screen", async () => {
  const state = { draft: draft(), render: render() };
  const { page, root, calls } = setup({
    ...base(state),
    [`POST ${BASE}/approve`]: () => { state.draft = draft({ version: 6, approval: { state: "current", approvedByName: "Alexey", approvedAt: "2027-03-01T10:00:00Z" } }); return {}; },
  });
  await page.start();
  const form = root.querySelector("[data-approve-form]");
  form.querySelector('[name="note"]').value = "looks good";
  await form.dispatch("submit");
  assert.deepEqual(calls.find((c) => c.url.endsWith("/approve")).body, { version: 5, payloadHash: "p".repeat(64), note: "looks good" });
  assert.equal(root.querySelector("[data-approval-state]").dataset.approvalState, "current");
  assert.ok(root.querySelector("[data-test-send]"), "test send appears once approved");
  assert.ok(root.querySelector("[data-schedule]"));
});

test("approval waits for a complete draft, and only the owner gets the controls", async () => {
  const incomplete = setup(base({ draft: draft(), render: render({ problems: [{ blockId: null, field: "subject", message: "The subject is empty." }] }) }));
  await incomplete.page.start();
  assert.equal(incomplete.root.querySelector("[data-approve]").disabled, true);
  assert.ok(findByText(incomplete.root, "The subject is empty."));

  const operator = setup(base({ draft: draft({ canApprove: false }), render: render() }));
  await operator.page.start();
  assert.ok(!operator.root.querySelector("[data-approve-form]"));
  assert.ok(!operator.root.querySelector("[data-schedule]"));
  assert.ok(findByText(operator.root, "Only the owner approves, tests and schedules the newsletter, signed in personally."));
});

test("the default send time is the next Monday 10:00 Berlin, at least 15 minutes ahead, across DST", () => {
  assert.equal(defaultSendTime(NOW), "2026-11-30T09:00:00.000Z");
  assert.equal(berlinLabel("2026-11-30T09:00:00.000Z"), "Mon 30 Nov, 10:00 Berlin");
  // Monday 09:50 Berlin: too close, so the following Monday; 09:30 is fine.
  assert.equal(defaultSendTime(Date.parse("2026-11-30T08:50:00Z")), "2026-12-07T09:00:00.000Z");
  assert.equal(defaultSendTime(Date.parse("2026-11-30T08:30:00Z")), "2026-11-30T09:00:00.000Z");
  // Summer time: 10:00 Berlin is 08:00 UTC; the missing hour of the switch is not a time.
  assert.equal(berlinToIso("2027-03-29", "10:00"), "2027-03-29T08:00:00.000Z");
  assert.equal(berlinToIso("2027-03-22", "10:00"), "2027-03-22T09:00:00.000Z");
  assert.equal(berlinToIso("2027-03-28", "02:30"), "");
  // The issue's own publication date wins while it is still ahead.
  assert.equal(defaultSendTime(NOW, "2026-12-01"), "2026-12-01T09:00:00.000Z");
  assert.equal(defaultSendTime(NOW, "2026-11-20"), "2026-11-30T09:00:00.000Z");
});

test("the owner sends a test to their own mailbox only, then confirms it arrived for the exact approval", async () => {
  const state = { draft: draft({ version: 6, approval: APPROVAL }), render: render() };
  const { page, root, calls } = setup({
    ...base(state),
    [`POST ${BASE}/test-send`]: () => {
      state.draft = draft({ version: 8, approval: APPROVAL, lastTest: { requestId: "req-0000-1111", payloadHash: "p".repeat(64), approvedVersion: 6, status: "provider_accepted", at: "2026-11-27T20:41:00Z" } });
      return { testSend: { status: "provider_accepted", emails: ["alexey@datatalks.club"] } };
    },
    [`POST ${BASE}/test-receipt`]: () => {
      state.draft = draft({ version: 9, approval: APPROVAL, lastTest: state.draft.lastTest, testReceipt: { state: "current", receivedAt: "2026-11-27T20:45:00Z" } });
      return {};
    },
  });
  await page.start();
  assert.ok(!root.querySelector('[name="emails"]'), "there is no recipient input");
  assert.equal(root.querySelector("[data-schedule]").disabled, true, "no schedule before a confirmed test");
  assert.ok(root.querySelector("[data-schedule-reason]"));
  assert.ok(!root.querySelector("[data-test-receipt]"), "nothing to confirm before a test");

  await root.querySelector("[data-test-send]").dispatch("click");
  assert.deepEqual(calls.find((c) => c.url.endsWith("/test-send")).body, { requestId: "req-0000-1111" });
  assert.match(root.querySelector("[data-review-status]").textContent, /Test sent to alexey@datatalks.club/);
  assert.equal(root.querySelector("[data-schedule]").disabled, true, "an accepted send is not a receipt");

  await root.querySelector("[data-test-receipt]").dispatch("click");
  assert.deepEqual(calls.find((c) => c.url.endsWith("/test-receipt")).body, { version: 6, payloadHash: "p".repeat(64), testRequestId: "req-0000-1111" });
  assert.equal(root.querySelector("[data-test-receipt-state]").dataset.testReceiptState, "current");
  assert.equal(root.querySelector("[data-schedule]").disabled, false);
  assert.ok(!root.querySelector("[data-schedule-reason]"));
});

test("one Schedule action, labelled with its time; Change time adjusts it in place; Relay's time is shown after", async () => {
  const ready = () => draft({ version: 9, approval: APPROVAL, testReceipt: { state: "current", receivedAt: "2026-11-27T20:45:00Z" } });
  const state = { draft: ready(), render: render() };
  let asked = "";
  const { page, root, calls } = setup({
    ...base(state),
    [`POST ${BASE}/schedule`]: (call) => {
      state.draft = draft({ version: 10, locked: true, approval: APPROVAL, delivery: { state: "scheduled", relayStatus: "scheduled", campaignKey: "dataops-newsletter-900-iss", scheduledAt: call.body.scheduledAt } });
      return { delivery: state.draft.delivery };
    },
  }, { confirmFn: (message) => { asked = message; return true; } });
  await page.start();
  const buttons = root.querySelectorAll("[data-schedule]");
  assert.equal(buttons.length, 1, "exactly one schedule action");
  assert.equal(buttons[0].textContent, "Schedule for Mon 30 Nov, 10:00 Berlin");

  await root.querySelector("[data-change-time]").dispatch("click");
  const form = root.querySelector("[data-schedule-form]");
  assert.equal(form.querySelector('[name="date"]').value, "2026-11-30");
  assert.equal(form.querySelector('[name="time"]').value, "10:00");
  form.querySelector('[name="time"]').value = "21:45";
  form.querySelector('[name="date"]').value = "2026-11-27";
  await form.dispatch("submit");
  assert.match(root.querySelector("[data-review-status]").textContent, /at least 15 minutes/);
  form.querySelector('[name="date"]').value = "2026-12-01";
  form.querySelector('[name="time"]').value = "08:30";
  await form.dispatch("submit");
  assert.ok(!root.querySelector("[data-schedule-form]"), "the dialog closes once a time is picked");
  assert.equal(root.querySelector("[data-schedule]").textContent, "Schedule for Tue 1 Dec, 08:30 Berlin");

  await root.querySelector("[data-schedule]").dispatch("click");
  assert.match(asked, /Tue 1 Dec, 08:30 Berlin to the Relay audience "dtc"/);
  assert.deepEqual(calls.find((c) => c.url.endsWith("/schedule")).body, { scheduledAt: "2026-12-01T07:30:00.000Z", payloadHash: "p".repeat(64), version: 9, requestId: "req-0000-1111" });
  assert.match(root.querySelector("[data-review-status]").textContent, /Relay confirms it will send on Tue 1 Dec, 08:30 Berlin/);
  assert.equal(root.querySelector("[data-delivery]").dataset.delivery, "scheduled");
  assert.ok(findByText(root, "Scheduled in Relay for Tue 1 Dec, 08:30 Berlin (Relay status: scheduled)"));
  assert.ok(root.querySelector("[data-cancel-schedule]"));
  assert.ok(!root.querySelector("[data-schedule]"), "a scheduled email cannot be scheduled twice from the page");
});

test("declining the confirmation sends nothing", async () => {
  const state = { draft: draft({ approval: APPROVAL, testReceipt: { state: "current" } }), render: render() };
  const { page, root, calls } = setup(base(state), { confirmFn: () => false });
  await page.start();
  await root.querySelector("[data-schedule]").dispatch("click");
  assert.ok(!calls.some((c) => c.url.endsWith("/schedule")));
});

test("an issue without a draft says so", async () => {
  const { page, root } = setup({
    [`GET ${ISSUE}`]: () => ({ id: "iss" }),
    [`GET ${BASE}`]: () => { throw Object.assign(new Error("no draft"), { code: "draft_missing" }); },
    [`GET ${BASE}/render`]: () => { throw Object.assign(new Error("no draft"), { code: "draft_missing" }); },
  });
  await page.start();
  assert.ok(findByText(root, "This issue has no email draft yet. Start it on the issue page."));
});

test("a refused approval because the draft changed reloads the current email", async () => {
  const state = { draft: draft(), render: render() };
  const { page, root } = setup({
    ...base(state),
    [`POST ${BASE}/approve`]: () => {
      state.render = render({ html: "<html>newer</html>", payloadHash: "q".repeat(64) });
      throw Object.assign(new Error("The draft changed since you reviewed it"), { code: "draft_changed" });
    },
  });
  await page.start();
  await root.querySelector("[data-approve-form]").dispatch("submit");
  assert.equal(root.querySelector("[data-email-frame]").srcdoc, "<html>newer</html>");
  assert.match(root.querySelector("[data-review-status]").textContent, /draft changed/);
});
