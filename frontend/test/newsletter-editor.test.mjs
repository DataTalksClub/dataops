import assert from "node:assert/strict";
import { test } from "node:test";
import { createNewsletterEditor } from "../src/surfaces/operations/newsletter-editor.js";
import { FakeDocument, FakeElement, findByText } from "./support/fake-dom.mjs";

const field = (name, kind = "text", required = false) => ({ name, label: name, kind, required, default: "" });
const block = (overrides) => ({
  version: 1,
  problems: [],
  sponsor: null,
  readOnly: false,
  pinned: false,
  canMove: true,
  canDelete: true,
  sponsorDocUrl: null,
  ...overrides,
});
const draftOf = (overrides = {}) => ({
  issueId: "iss",
  subject: "Zoomcamp is back",
  previewText: "Free course",
  version: 4,
  locked: false,
  blocks: [
    block({ id: "nb-intro", type: "intro", label: "Intro", data: { issue_label: "#900", summary: "Hello" }, fields: [field("issue_label"), field("summary", "markdown", true)], canMove: false, canDelete: true }),
    block({ id: "nb-rec", type: "recording", label: "Recording", data: { title: "dbt talk" }, fields: [field("title", "text", true), field("cta_url", "url")] }),
  ],
  sponsorSync: {},
  problems: [],
  payloadHash: "h".repeat(64),
  approval: { state: "none" },
  delivery: null,
  webViewUrl: "https://ops.example/api/newsletter-view/tok",
  canApprove: false,
  ...overrides,
});

const BASE = "/api/newsletter-issues/iss/draft";

function setup(routes, options = {}) {
  const documentRef = new FakeDocument();
  const calls = [];
  const timers = [];
  const request = async (url, init = {}) => {
    const method = init.method || "GET";
    calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined });
    const handler = routes[`${method} ${url}`];
    if (!handler) throw Object.assign(new Error(`no route ${method} ${url}`), { status: 404 });
    return handler(calls.at(-1));
  };
  const editor = createNewsletterEditor({
    documentRef,
    request,
    workApiUrl: (path) => path,
    setTimeoutFn: (fn) => { timers.push(fn); return timers.length; },
    clearTimeoutFn: () => {},
    ...options,
  });
  const flush = async () => { while (timers.length) await timers.shift()(); };
  return { editor, calls, flush, container: new FakeElement("div") };
}

const preview = (html = "<html>email</html>") => () => ({ preview: { subject: "Zoomcamp is back", previewText: "Free course", html } });

test("without a draft it offers to start one, and starting calls only DataOps", async () => {
  let started = false;
  const { editor, calls, flush, container } = setup({
    [`GET ${BASE}`]: () => { throw Object.assign(new Error("no draft"), { status: 404, code: "draft_missing" }); },
    [`POST ${BASE}`]: () => { started = true; return { draft: draftOf({ blocks: [draftOf().blocks[0]] }), sponsorStaging: [] }; },
    [`POST ${BASE}/preview`]: preview(),
  });
  await editor.mount(container, "iss");
  const start = container.querySelector("[data-start-draft]");
  assert.ok(start, "a start button");
  assert.ok(!findByText(container, "Import blocks from Relay"), "no Relay import anywhere");
  await start.dispatch("click");
  await flush();
  assert.equal(started, true);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [`GET ${BASE}`, `POST ${BASE}`, `POST ${BASE}/preview`]);
  assert.ok(calls.every((c) => c.url.startsWith("/api/newsletter-issues/")), "the editor never talks to Relay");
});

test("shows the envelope, the ordered blocks, the live preview and the full-email link", async () => {
  const { editor, flush, container, calls } = setup({
    [`GET ${BASE}`]: () => ({ draft: draftOf() }),
    [`POST ${BASE}/preview`]: preview("<html>live</html>"),
  });
  await editor.mount(container, "iss");
  await flush();
  assert.deepEqual(container.querySelectorAll("[data-block-id]").map((item) => item.dataset.blockId), ["nb-intro", "nb-rec"]);
  assert.equal(container.querySelector("[data-envelope-form]").querySelector('[name="subject"]').value, "Zoomcamp is back");
  const frame = container.querySelector("[data-live-preview]");
  assert.equal(frame.srcdoc, "<html>live</html>");
  assert.equal(frame.getAttribute("sandbox"), "", "the preview runs sandboxed");
  assert.equal(container.querySelector("[data-full-email-link]").href, "/newsletter-issues/iss/preview");
  assert.equal(container.querySelector("[data-approval-state]").textContent, "Not approved");
  const sent = calls.find((c) => c.url === `${BASE}/preview`).body;
  assert.deepEqual(sent.blocks.map((b) => b.type), ["intro", "recording"]);
  // Ids, history and delete are collapsed away from the primary surface.
  assert.ok(!container.querySelector('[data-action="delete"]'), "delete hides until a block is opened and More is expanded");
  assert.ok(container.querySelector("[data-editor-details]"));
});

test("opening a block shows its form; typing re-renders the preview from unsaved values; saving sends the version", async () => {
  const { editor, flush, container, calls } = setup({
    [`GET ${BASE}`]: () => ({ draft: draftOf() }),
    [`POST ${BASE}/preview`]: preview(),
    [`PUT ${BASE}/blocks/nb-rec`]: () => ({ changed: true, draft: draftOf() }),
  });
  await editor.mount(container, "iss");
  await flush();
  await container.querySelector('[data-block-toggle="nb-rec"]').dispatch("click");
  const form = container.querySelector('[data-block-form="nb-rec"]');
  const title = form.querySelectorAll("[data-block-field]").find((input) => input.name === "title");
  title.value = "Unsaved title";
  await title.dispatch("input");
  await flush();
  const last = calls.filter((c) => c.url === `${BASE}/preview`).at(-1).body;
  assert.equal(last.blocks[1].data.title, "Unsaved title");
  await form.dispatch("submit");
  assert.deepEqual(calls.find((c) => c.method === "PUT").body, { version: 1, data: { title: "Unsaved title", cta_url: "" } });
  assert.match(container.querySelector("[data-editor-status]").textContent, /Saved Recording/);
});

test("Add block opens a type picker; picking adds that type and opens it", async () => {
  const added = block({ id: "nb-new", type: "feature", label: "Feature", data: {}, fields: [field("title", "text", true)], problems: ["Feature: title is required."] });
  const { editor, flush, container, calls } = setup({
    [`GET ${BASE}`]: () => ({ draft: draftOf() }),
    [`POST ${BASE}/preview`]: preview(),
    [`GET ${BASE}/types`]: () => ({ types: [
      { type: "feature", label: "Feature", addable: true, fields: [] },
      { type: "sponsor", label: "Sponsor (main)", addable: true, fields: [] },
      { type: "sponsor_secondary", label: "Sponsor (secondary)", addable: false, fields: [] },
    ] }),
    [`POST ${BASE}/blocks`]: () => ({ block: added, draft: draftOf({ blocks: [...draftOf().blocks, added] }) }),
  });
  await editor.mount(container, "iss");
  await flush();
  await container.querySelector("[data-add-block]").dispatch("click");
  await flush();
  const picker = container.querySelector("[data-block-picker]");
  assert.deepEqual(picker.querySelectorAll("[data-block-type]").map((b) => b.dataset.blockType), ["feature", "sponsor"], "a slot with a sponsor doc offers no hand-made block");
  await picker.querySelector('[data-block-type="feature"]').dispatch("click");
  await flush();
  assert.deepEqual(calls.find((c) => c.method === "POST" && c.url === `${BASE}/blocks`).body, { type: "feature" });
  assert.ok(container.querySelector('[data-block-form="nb-new"]'), "the new block opens for editing");
  assert.ok(container.querySelector('[data-block-id="nb-new"]').dataset.incomplete !== undefined);
});

test("deleting sits under More and asks first; moving uses the arrows", async () => {
  let confirmed = "";
  const { editor, flush, container, calls } = setup({
    [`GET ${BASE}`]: () => ({ draft: draftOf() }),
    [`POST ${BASE}/preview`]: preview(),
    [`DELETE ${BASE}/blocks/nb-rec`]: () => ({ draft: draftOf({ blocks: [draftOf().blocks[0]] }) }),
    [`POST ${BASE}/blocks/nb-rec/move`]: () => ({ draft: draftOf() }),
  }, { confirmFn: (message) => { confirmed = message; return true; } });
  await editor.mount(container, "iss");
  await flush();
  const row = container.querySelector('[data-block-id="nb-rec"]');
  await row.querySelector('[data-action="up"]').dispatch("click");
  assert.deepEqual(calls.find((c) => c.url.endsWith("/move")).body, { direction: "up" });
  await container.querySelector('[data-block-toggle="nb-rec"]').dispatch("click");
  await container.querySelector('[data-block-id="nb-rec"]').querySelector('[data-action="delete"]').dispatch("click");
  assert.match(confirmed, /Delete "Recording"/);
  assert.deepEqual(container.querySelectorAll("[data-block-id]").map((item) => item.dataset.blockId), ["nb-intro"]);
});

test("a doc-owned sponsor block is read-only with a link to its sponsor doc", async () => {
  const sponsor = block({ id: "nb-sp", type: "sponsor", label: "Sponsor (main)", data: { title: "DataTalks.Club Zoomcamp", cta_url: "https://x.example" }, fields: [field("title"), field("cta_url", "url")], sponsor: "primary", readOnly: true, canDelete: false, canMove: false, sponsorDocUrl: "https://ops.example/sponsor-docs/d1" });
  const { editor, flush, container } = setup({
    [`GET ${BASE}`]: () => ({ draft: draftOf({ blocks: [draftOf().blocks[0], sponsor] }) }),
    [`POST ${BASE}/preview`]: preview(),
  });
  await editor.mount(container, "iss");
  await flush();
  await container.querySelector('[data-block-toggle="nb-sp"]').dispatch("click");
  const form = container.querySelector('[data-block-form="nb-sp"]');
  assert.ok(form.querySelector("[data-block-readonly]"));
  assert.equal(form.querySelectorAll("[data-block-field]").length, 0);
  assert.equal(form.querySelector("[data-sponsor-doc-link]").href, "https://ops.example/sponsor-docs/d1");
  assert.ok(!form.querySelector('[data-action="delete"]'));
});

test("saving after approval says the approval was withdrawn; a scheduled draft stays editable and says an edit unschedules it", async () => {
  const approved = draftOf({ approval: { state: "current", approvedByName: "Alexey" } });
  const { editor, flush, container } = setup({
    [`GET ${BASE}`]: () => ({ draft: approved }),
    [`POST ${BASE}/preview`]: preview(),
    [`PUT ${BASE}`]: () => ({ changed: true, draft: draftOf({ subject: "New" }) }),
  });
  await editor.mount(container, "iss");
  await flush();
  assert.equal(container.querySelector("[data-approval-state]").dataset.approvalState, "current");
  await container.querySelector("[data-envelope-form]").dispatch("submit");
  assert.match(container.querySelector("[data-editor-status]").textContent, /approval was withdrawn/);

  const locked = setup({
    [`GET ${BASE}`]: () => ({ draft: draftOf({ locked: true, delivery: { state: "scheduled", scheduledAt: "2027-03-04T08:00:00.000Z", campaignKey: "k" } }) }),
    [`POST ${BASE}/preview`]: preview(),
  });
  await locked.editor.mount(locked.container, "iss");
  await locked.flush();
  assert.match(locked.container.querySelector("[data-draft-locked]").textContent, /Saving any change first cancels that schedule/);
  assert.ok(locked.container.querySelector("[data-add-block]"), "blocks can still be added; the save unschedules first");
  assert.equal(locked.container.querySelector('[data-envelope-form] [data-action="save-envelope"]')?.disabled ?? false, false);
});

test("opening a block keeps the live preview on screen", async () => {
  const { editor, flush, container } = setup({
    [`GET ${BASE}`]: () => ({ draft: draftOf() }),
    [`POST ${BASE}/preview`]: preview("<html>kept</html>"),
  });
  await editor.mount(container, "iss");
  await flush();
  await container.querySelector('[data-block-toggle="nb-rec"]').dispatch("click");
  const frame = container.querySelector("[data-live-preview]");
  assert.equal(frame.srcdoc, "<html>kept</html>");
  assert.equal(frame.dataset.previewState, "ready");
});
