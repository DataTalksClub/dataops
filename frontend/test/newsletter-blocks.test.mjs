import assert from "node:assert/strict";
import { test } from "node:test";
import { createNewsletterBlocksSection } from "../src/surfaces/operations/newsletter-blocks.js";
import { FakeDocument, FakeElement, findByText } from "./support/fake-dom.mjs";

const field = (name, kind = "text", required = false) => ({ name, label: name, kind, required, default: "" });
const blockSet = (overrides = {}) => ({
  issueId: "iss",
  relay: { target: "production", issueKey: "weekly-304" },
  relayIssue: { subject: "Weekly 304" },
  lastSync: null,
  blocks: [
    { id: "rb-113", relayBlockId: 113, type: "intro", label: "Intro", version: 1, data: { summary: "Hello" }, fields: [field("issue_label"), field("summary", "markdown", true)], changedSinceSync: false },
    { id: "rb-114", relayBlockId: 114, type: "sponsor", label: "Sponsor (main)", version: 3, data: { title: "Acme" }, fields: [field("title"), field("cta_url", "url")], changedSinceSync: true },
  ],
  ...overrides,
});

function setup(routes, options = {}) {
  const documentRef = new FakeDocument();
  const calls = [];
  const request = async (url, options = {}) => {
    const method = options.method || "GET";
    calls.push({ method, url, body: options.body ? JSON.parse(options.body) : undefined });
    const handler = routes[`${method} ${url}`];
    if (!handler) throw Object.assign(new Error(`no route ${method} ${url}`), { status: 404 });
    return handler(calls.at(-1));
  };
  const section = createNewsletterBlocksSection({ documentRef, request, workApiUrl: (path) => path, ...options });
  return { section, calls, container: new FakeElement("div") };
}

const BASE = "/api/newsletter-issues/iss/blocks";

test("renders every block as an editable form with its sync state", async () => {
  const { section, container } = setup({ [`GET ${BASE}`]: () => ({ blocks: blockSet() }) });
  await section.mount(container, "iss");
  const forms = container.querySelectorAll("[data-block-id]");
  assert.deepEqual(forms.map((form) => form.dataset.blockId), ["rb-113", "rb-114"]);
  const summary = forms[0].querySelectorAll("[data-block-field]").find((input) => input.name === "summary");
  assert.equal(summary.tagName, "TEXTAREA");
  assert.equal(summary.value, "Hello");
  assert.equal(forms[1].querySelector("[data-block-state]").textContent, "Edited, not synced");
  assert.ok(findByText(container, "Relay production · weekly-304 · 2 blocks · 1 edited, not synced"));
});

test("saving sends the block version and the edited fields", async () => {
  const { section, calls, container } = setup({
    [`GET ${BASE}`]: () => ({ blocks: blockSet() }),
    [`PUT ${BASE}/rb-113`]: () => ({ changed: true, blocks: blockSet() }),
  });
  await section.mount(container, "iss");
  const form = container.querySelectorAll("[data-block-id]")[0];
  form.querySelectorAll("[data-block-field]").find((input) => input.name === "summary").value = "Edited";
  await form.dispatch("submit");
  assert.deepEqual(calls.at(-1).body, { version: 1, data: { issue_label: "", summary: "Edited" } });
  assert.match(container.querySelector("[data-blocks-status]").textContent, /Saved Intro/);
});

test("a refused sync shows the conflict loudly and keeps the edits", async () => {
  const conflict = Object.assign(new Error("Sync refused: 1 block(s) changed both in DataOps and in Relay since the last sync."), {
    status: 409,
    payload: { conflicts: [{ relayBlockId: 114, type: "sponsor", action: "conflict", reason: "edited in DataOps and in Relay" }] },
  });
  const { section, container } = setup({
    [`GET ${BASE}`]: () => ({ blocks: blockSet() }),
    [`POST ${BASE}/sync`]: () => { throw conflict; },
  });
  await section.mount(container, "iss");
  await container.querySelector('[data-blocks-action="sync"]').click();
  const status = container.querySelector("[data-blocks-status]");
  assert.equal(status.dataset.tone, "danger");
  assert.match(status.textContent, /Sync refused/);
  assert.ok(findByText(container, "#114 sponsor: conflict (edited in DataOps and in Relay)"));
});

test("offers an import from Relay when the issue has no blocks yet", async () => {
  const notImported = Object.assign(new Error("no blocks"), { status: 404, code: "blocks_not_imported" });
  const { section, calls, container } = setup({
    [`GET ${BASE}`]: () => { throw notImported; },
    [`POST ${BASE}/import`]: () => ({ blocks: blockSet() }),
  });
  await section.mount(container, "iss");
  const form = container.querySelector("[data-blocks-import]");
  form.querySelector('[name="issueKey"]').value = "weekly-304";
  form.querySelector('[name="target"]').value = "dev";
  await form.dispatch("submit");
  assert.deepEqual(calls.at(-1).body, { issueKey: "weekly-304", target: "dev" });
  assert.equal(container.querySelectorAll("[data-block-id]").length, 2);
});

const rich = () => blockSet({
  orderChanged: true,
  deletedPending: [{ id: "rb-9", type: "recording", label: "Recording" }],
  blocks: [
    { id: "rb-113", relayBlockId: 113, position: 0, type: "intro", label: "Intro", version: 1, data: { summary: "Hello" }, fields: [field("summary", "markdown", true)], pushState: "in-sync", canMove: true, canDelete: true },
    { id: "rb-114", relayBlockId: 114, position: 1, type: "sponsor", label: "Sponsor (main)", version: 3, data: { title: "Acme" }, fields: [field("title")], sponsor: "primary", readOnly: true, pinned: true, canMove: false, canDelete: false, sponsorDocUrl: "/sponsor-docs/doc-1", pushState: "in-sync" },
    { id: "rb-115", relayBlockId: 115, position: 2, type: "sponsor_secondary", label: "Sponsor (secondary)", version: 1, data: { title: "Beta" }, fields: [field("title")], sponsor: "secondary", readOnly: true, canMove: true, canDelete: false, sponsorDocUrl: "/sponsor-docs/doc-2", pushState: "in-sync" },
    { id: "nb-1", relayBlockId: null, position: 3, type: "recording", label: "Recording", version: 1, data: { title: "Talk" }, fields: [field("title", "text", true)], pushState: "new", canMove: true, canDelete: true },
  ],
});
const card = (container, id) => container.querySelectorAll("[data-block-id]").find((form) => form.dataset.blockId === id);
const action = (form, name) => form.querySelector(`[data-blocks-action="${name}"]`);

test("sponsor blocks are read-only with an Edit in sponsor doc link and disabled controls", async () => {
  const { section, container } = setup({ [`GET ${BASE}`]: () => ({ blocks: rich() }) });
  await section.mount(container, "iss");
  const main = card(container, "rb-114");
  assert.equal(main.querySelectorAll("[data-block-field]").length, 0);
  assert.equal(action(main, "save"), null);
  assert.equal(main.querySelector("[data-sponsor-doc-link]").href, "/sponsor-docs/doc-1");
  assert.equal(main.querySelector("[data-sponsor-doc-link]").textContent, "Edit in sponsor doc");
  assert.ok(findByText(main, "Pinned: first content block"));
  assert.equal(action(main, "up").disabled, true);
  assert.equal(action(main, "down").disabled, true);
  assert.equal(action(main, "delete").disabled, true);
  const secondary = card(container, "rb-115");
  assert.equal(action(secondary, "delete").disabled, true);
  assert.match(action(secondary, "delete").title, /removing the slot/);
  assert.equal(action(secondary, "up").disabled, false);
  assert.ok(findByText(container, "Order changed, not synced"));
  assert.equal(card(container, "nb-1").querySelector("[data-block-state]").textContent, "New, not in Relay");
  assert.ok(container.querySelector("[data-deleted-pending]"));
});

test("up and down post a move", async () => {
  const { section, calls, container } = setup({
    [`GET ${BASE}`]: () => ({ blocks: rich() }),
    [`POST ${BASE}/nb-1/move`]: () => ({ blocks: rich() }),
    [`POST ${BASE}/rb-115/move`]: () => ({ blocks: rich() }),
  });
  await section.mount(container, "iss");
  await action(card(container, "nb-1"), "up").click();
  assert.deepEqual(calls.at(-1), { method: "POST", url: `${BASE}/nb-1/move`, body: { direction: "up" } });
  await action(card(container, "rb-115"), "down").click();
  assert.deepEqual(calls.at(-1).body, { direction: "down" });
  assert.match(container.querySelector("[data-blocks-status]").textContent, /Block moved/);
});

test("dragging a block onto another posts the target index", async () => {
  const { section, calls, container } = setup({
    [`GET ${BASE}`]: () => ({ blocks: rich() }),
    [`POST ${BASE}/nb-1/move`]: () => ({ blocks: rich() }),
  });
  await section.mount(container, "iss");
  const dragged = card(container, "nb-1");
  assert.equal(dragged.draggable, true);
  assert.notEqual(card(container, "rb-114").draggable, true);
  await dragged.dispatch("dragstart");
  await card(container, "rb-115").dispatch("drop");
  assert.deepEqual(calls.at(-1), { method: "POST", url: `${BASE}/nb-1/move`, body: { to: 2 } });
});

test("a refused move shows the server message in the block and the status", async () => {
  const refusal = Object.assign(new Error("The main sponsor block is pinned."), { status: 409, code: "above_pinned_sponsor" });
  const { section, container } = setup({
    [`GET ${BASE}`]: () => ({ blocks: rich() }),
    [`POST ${BASE}/rb-113/move`]: () => { throw refusal; },
  });
  await section.mount(container, "iss");
  await action(card(container, "rb-113"), "down").click();
  const status = container.querySelector("[data-blocks-status]");
  assert.equal(status.dataset.tone, "danger");
  assert.match(status.textContent, /pinned/);
  const inline = card(container, "rb-113").querySelector("[data-block-error]");
  assert.equal(inline.hidden, false);
  assert.match(inline.textContent, /pinned/);
});

test("delete asks for confirmation, then deletes", async () => {
  let answer = false;
  const { section, calls, container } = setup({
    [`GET ${BASE}`]: () => ({ blocks: rich() }),
    [`DELETE ${BASE}/nb-1`]: () => ({ blocks: rich() }),
  }, { confirmFn: () => answer });
  await section.mount(container, "iss");
  await action(card(container, "nb-1"), "delete").click();
  assert.equal(calls.filter((call) => call.method === "DELETE").length, 0);
  answer = true;
  await action(card(container, "nb-1"), "delete").click();
  assert.deepEqual(calls.at(-1), { method: "DELETE", url: `${BASE}/nb-1`, body: undefined });
  assert.match(container.querySelector("[data-blocks-status]").textContent, /Deleted Recording/);
});

test("adding a block posts the chosen type, defaults, edits and position", async () => {
  const types = [
    { type: "recording", label: "Recording", addable: true, fields: [{ ...field("kicker"), default: "RECORDINGS" }, field("title", "text", true)] },
    { type: "sponsor", label: "Sponsor (main)", addable: false, fields: [field("title")] },
  ];
  const { section, calls, container } = setup({
    [`GET ${BASE}`]: () => ({ blocks: rich() }),
    [`GET ${BASE}/types`]: () => ({ types }),
    [`POST ${BASE}`]: () => ({ block: { id: "nb-2" }, blocks: rich() }),
  });
  await section.mount(container, "iss");
  await action(container, "add").click();
  const form = container.querySelector("[data-blocks-add-form]");
  assert.deepEqual(form.querySelector('[name="type"]').children.map((option) => option.value), ["recording"]);
  assert.equal(form.querySelector('[name="kicker"]').value, "RECORDINGS");
  form.querySelector('[name="title"]').value = "New talk";
  form.querySelector('[name="position"]').value = "3";
  await form.dispatch("submit");
  assert.deepEqual(calls.at(-1).body, { type: "recording", data: { kicker: "RECORDINGS", title: "New talk" }, position: 3 });
  assert.match(container.querySelector("[data-blocks-status]").textContent, /Block added/);
});

test("a failed add shows the server refusal", async () => {
  const refusal = Object.assign(new Error("Sponsor blocks come from the sponsor doc."), { status: 409 });
  const types = [{ type: "recording", label: "Recording", addable: true, fields: [field("title")] }];
  const { section, container } = setup({
    [`GET ${BASE}`]: () => ({ blocks: rich() }),
    [`GET ${BASE}/types`]: () => ({ types }),
    [`POST ${BASE}`]: () => { throw refusal; },
  });
  await section.mount(container, "iss");
  await action(container, "add").click();
  await container.querySelector("[data-blocks-add-form]").dispatch("submit");
  assert.match(container.querySelector("[data-blocks-status]").textContent, /Sponsor blocks come from the sponsor doc/);
});
