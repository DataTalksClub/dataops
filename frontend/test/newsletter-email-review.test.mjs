import assert from "node:assert/strict";
import { test } from "node:test";
import { createNewsletterEmailReview, localToIso } from "../src/surfaces/operations/newsletter-email-review.js";
import { FakeDocument, FakeElement, findByText } from "./support/fake-dom.mjs";

const ISSUE = "/api/newsletter-issues/iss";
const BASE = `${ISSUE}/draft`;
const render = (overrides = {}) => ({ subject: "Zoomcamp is back", previewText: "Free course", html: "<html>final</html>", text: "t", payloadHash: "p".repeat(64), problems: [], ...overrides });
const draft = (overrides = {}) => ({ version: 5, locked: false, approval: { state: "none" }, delivery: null, canApprove: true, relayAudience: "dtc", ...overrides });

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
  assert.ok(root.querySelector("[data-test-send-form]"), "test send appears once approved");
  assert.ok(root.querySelector("[data-schedule-form]"));
});

test("approval waits for a complete draft, and only the owner gets the controls", async () => {
  const incomplete = setup(base({ draft: draft(), render: render({ problems: [{ blockId: null, field: "subject", message: "The subject is empty." }] }) }));
  await incomplete.page.start();
  assert.equal(incomplete.root.querySelector("[data-approve]").disabled, true);
  assert.ok(findByText(incomplete.root, "The subject is empty."));

  const operator = setup(base({ draft: draft({ canApprove: false }), render: render() }));
  await operator.page.start();
  assert.ok(!operator.root.querySelector("[data-approve-form]"));
  assert.ok(!operator.root.querySelector("[data-schedule-form]"));
  assert.ok(findByText(operator.root, "Only the owner approves, test-sends and schedules the newsletter, signed in personally."));
});

test("test send and schedule carry a request id; scheduling confirms first and sends the approved hash", async () => {
  const state = { draft: draft({ version: 6, approval: { state: "current", approvedByName: "Alexey" } }), render: render() };
  let asked = "";
  const { page, root, calls } = setup({
    ...base(state),
    [`POST ${BASE}/test-send`]: () => ({ testSend: { status: "provider_accepted", emails: ["alexey@datatalks.club"] } }),
    [`POST ${BASE}/schedule`]: () => {
      state.draft = draft({ version: 7, locked: true, approval: { state: "current" }, delivery: { state: "scheduled", campaignKey: "dataops-newsletter-900-iss", scheduledAt: "2027-03-04T08:00:00.000Z" } });
      return { delivery: state.draft.delivery };
    },
  }, { confirmFn: (message) => { asked = message; return true; } });
  await page.start();
  await root.querySelector("[data-test-send-form]").dispatch("submit");
  assert.deepEqual(calls.find((c) => c.url.endsWith("/test-send")).body, { emails: ["alexey@datatalks.club"], requestId: "req-0000-1111" });
  assert.match(root.querySelector("[data-review-status]").textContent, /Test sent to alexey@datatalks.club via Relay/);

  const schedule = root.querySelector("[data-schedule-form]");
  schedule.querySelector('[name="scheduledAt"]').value = "2027-03-04T09:00";
  await schedule.dispatch("submit");
  assert.match(asked, /Relay audience "dtc"/);
  const sent = calls.find((c) => c.url.endsWith("/schedule")).body;
  assert.deepEqual(sent, { scheduledAt: localToIso("2027-03-04T09:00"), payloadHash: "p".repeat(64), version: 6, requestId: "req-0000-1111" });
  assert.equal(root.querySelector("[data-delivery]").dataset.delivery, "scheduled");
  assert.ok(root.querySelector("[data-cancel-schedule]"));
  assert.ok(!root.querySelector("[data-schedule-form]"), "a scheduled email cannot be scheduled twice from the page");
});

test("declining the confirmation sends nothing", async () => {
  const state = { draft: draft({ approval: { state: "current" } }), render: render() };
  const { page, root, calls } = setup(base(state), { confirmFn: () => false });
  await page.start();
  const schedule = root.querySelector("[data-schedule-form]");
  schedule.querySelector('[name="scheduledAt"]').value = "2027-03-04T09:00";
  await schedule.dispatch("submit");
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
