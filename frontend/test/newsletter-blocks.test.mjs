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

function setup(routes) {
  const documentRef = new FakeDocument();
  const calls = [];
  const request = async (url, options = {}) => {
    const method = options.method || "GET";
    calls.push({ method, url, body: options.body ? JSON.parse(options.body) : undefined });
    const handler = routes[`${method} ${url}`];
    if (!handler) throw Object.assign(new Error(`no route ${method} ${url}`), { status: 404 });
    return handler(calls.at(-1));
  };
  const section = createNewsletterBlocksSection({ documentRef, request, workApiUrl: (path) => path });
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
