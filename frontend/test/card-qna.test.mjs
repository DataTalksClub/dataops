import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { renderCardQna } from "../src/surfaces/work-detail/card-qna.js";
import { FakeDocument, FakeElement } from "./support/fake-dom.mjs";
const savedDocument = globalThis.document;
afterEach(() => { globalThis.document = savedDocument; });

test("a Card without a Q&A room renders nothing", () => {
  globalThis.document = new FakeDocument(new FakeElement("main"));
  assert.equal(renderCardQna({ request: async () => ({}), workApiUrl: (p) => p }, { id: "c1" }), null);
});

test("a Card with a room shows its link and loads questions on one click", async () => {
  globalThis.document = new FakeDocument(new FakeElement("main"));
  const calls = [];
  const card = { id: "c1", qna: { url: "https://qna.dtcdev.click/r/x", presentUrl: "https://qna.dtcdev.click/admin/rooms/1/present" } };
  const section = renderCardQna({
    request: async (url) => { calls.push(url); return { questions: [{ text: "Why?", authorName: null, score: 3, status: "visible" }] }; },
    workApiUrl: (p) => p,
  }, card);
  assert.ok(section.textContent.includes("https://qna.dtcdev.click/r/x"));
  await section.querySelector("button").click();
  assert.deepEqual(calls, ["/api/cards/c1/qna/questions"]);
  assert.ok(section.textContent.includes("Why? — Anonymous (+3)"));
});
