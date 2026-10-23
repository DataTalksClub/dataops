import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";
isolateConfig();
const realFetch = globalThis.fetch;
const { run } = await import("../src/cli.mjs");
afterEach(() => { globalThis.fetch = realFetch; });

test("webinar doc create links the webinar template and supports an invitation draft", async () => {
  const calls = fakePortal({ "POST /api/sponsor-docs": { doc: { id: "doc-test", template: "webinar", emailDraft: { subject: "Speaker materials", body: "Synthetic invitation" } } } });
  const io = captureIo();
  assert.equal(await run(["webinar", "doc", "create", "card-test", "--speaker", "Test Speaker", "--email"], io), 0);
  assert.deepEqual(calls[0].body, { cardId: "card-test", template: "webinar", sponsorName: "Test Speaker" });
  assert.match(io.text(), /Synthetic invitation/);
});
test("webinar doc update, submit and list have CLI parity", async () => {
  const calls = fakePortal({
    "PUT /api/sponsor-docs/doc-test": { doc: { id: "doc-test", status: "submitted" } },
    "GET /api/sponsor-docs": { docs: [{ id: "webinar", template: "webinar" }, { id: "podcast", template: "podcast" }] },
  });
  assert.equal(await run(["webinar", "doc", "update", "doc-test", "--field", "bio=Test bio", "--json"], captureIo()), 0);
  assert.deepEqual(calls[0].body, { content: { bio: "Test bio" } });
  assert.equal(await run(["webinar", "doc", "submit", "doc-test", "--json"], captureIo()), 0);
  assert.deepEqual(calls[1].body, { status: "submitted" });
  const io = captureIo();
  assert.equal(await run(["webinar", "doc", "list", "--card", "card-test", "--json"], io), 0);
  assert.deepEqual(io.json().docs.map((d) => d.id), ["webinar"]);
});
test("webinar help documents required fields; rejects newsletter flags", async () => {
  const calls = fakePortal({});
  const io = captureIo();
  assert.equal(await run(["webinar", "doc", "--help"], io), 0);
  assert.match(io.text(), /talkTitle, outline.*bio/);
  assert.equal(await run(["webinar", "doc", "create", "card-test", "--slot", "secondary"], captureIo()), 2);
  assert.equal(calls.length, 0);
});
