import assert from "node:assert/strict";
import { test } from "node:test";
import { renderNewsletterSyncNote } from "../src/surfaces/operations/sponsor-doc-newsletter-sync.js";
import { FakeDocument } from "./support/fake-dom.mjs";

const documentRef = new FakeDocument();
const el = (tag, className, text) => {
  const node = documentRef.createElement(tag);
  node.className = className || "";
  if (text !== undefined) node.textContent = text;
  return node;
};

test("a failed newsletter sync is a loud alert on the doc page", () => {
  const note = renderNewsletterSyncNote(el, { status: "failed", message: "Relay block 114 changed in Relay" });
  assert.equal(note.dataset.newsletterSync, "failed");
  assert.equal(note.getAttribute("role"), "alert");
  assert.match(note.className, /dk-callout--danger/);
  assert.match(note.textContent, /Newsletter sync FAILED: Relay block 114 changed in Relay/);
});

test("ok and skipped results are quiet lines; no result renders nothing", () => {
  const ok = renderNewsletterSyncNote(el, { status: "ok", message: "Updated issue #304 sponsor block" });
  assert.match(ok.className, /dk-callout--success/);
  assert.equal(ok.getAttribute("role"), "status");
  assert.match(renderNewsletterSyncNote(el, { status: "skipped", message: "No issue uses this doc" }).className, /dk-callout--info/);
  assert.equal(renderNewsletterSyncNote(el, null), null);
});
