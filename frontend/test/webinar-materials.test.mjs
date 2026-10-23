import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { renderWebinarMaterialsAction } from "../src/surfaces/work-detail/webinar-materials.js";
import { FakeDocument, FakeElement } from "./support/fake-dom.mjs";
const savedDocument = globalThis.document;
afterEach(() => { globalThis.document = savedDocument; });
const templates = [{ id: "template-webinar", type: "webinar", name: "Webinar" }];
const card = { id: "synthetic-card", templateId: "template-webinar", sponsorDocs: [] };

test("webinar workflow creates a linked speaker form once and reloads the card", async () => {
  globalThis.document = new FakeDocument(new FakeElement("main"));
  const calls = [];
  let reloads = 0;
  const context = { request: async (...args) => { calls.push(args); }, workApiUrl: (path) => path, reload: async () => { reloads += 1; } };
  const section = renderWebinarMaterialsAction(context, card, templates);
  await section.querySelector("button").click();
  assert.deepEqual(JSON.parse(calls[0][1].body), { cardId: card.id, template: "webinar" });
  assert.equal(reloads, 1);
  assert.equal(renderWebinarMaterialsAction(context, { ...card, sponsorDocs: [{ template: "webinar" }] }, templates), null);
  assert.equal(renderWebinarMaterialsAction(context, { ...card, templateId: "other" }, templates), null);
});

test("creation failure stays visible and can be retried", async () => {
  globalThis.document = new FakeDocument(new FakeElement("main"));
  const section = renderWebinarMaterialsAction({ request: async () => { throw new Error("Save failed"); }, workApiUrl: (path) => path, reload: async () => {} }, card, templates);
  await section.querySelector("button").click();
  assert.equal(section.querySelector("button").disabled, false);
  assert.match(section.textContent, /Save failed/);
});
