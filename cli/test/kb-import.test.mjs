import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { importGoogleDoc } from "../src/kbImport.mjs";
import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const { run } = await import("../src/cli.mjs");
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const source = "https://docs.google.com/document/d/source-id/edit?tab=t.0#heading";
const options = { source, id: "template.article", title: "Article: announcement", type: "template" };

test("literal export retains mentions, angle brackets, CRLF normalization and embedded fences", () => {
  const bytes = Buffer.from("\uFEFF<@NAME> & <TITLE>\r\n```\r\nhello 😊");
  const content = importGoogleDoc({ ...options, bytes });
  assert.ok(content.includes("````text\n<@NAME> & <TITLE>\n```\nhello 😊\n````"));
  assert.ok(content.includes(`export SHA256 ${createHash("sha256").update(bytes).digest("hex")}`));
  assert.ok(content.includes('source: "Google Docs https://docs.google.com/document/d/source-id/edit;'));
  assert.ok(content.includes('id: "template.article"'));
});

test("rejects invalid sources, binary exports, missing content and unsafe metadata", () => {
  for (const overrides of [
    { source: "https://evil.example/document/d/id" }, { source: "https://docs.google.com/document/d/e/published/pub" },
    { source: "http://docs.google.com/document/d/id/edit" }, { source: "https://docs.google.com@evil.example/document/d/id" },
    { id: "foo\nid: bar" }, { title: "title\ndoc_type: sop" }, { type: "sop" }, { format: "docx" },
    { bytes: Buffer.from([255]) }, { bytes: Buffer.from("\0abc") }, { bytes: Buffer.from(" \n") },
  ]) assert.throws(() => importGoogleDoc({ ...options, bytes: Buffer.from("hello"), ...overrides }));
});

test("CLI imports exactly once using current publication and absent precondition", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kb-import-"));
  try {
    const file = join(dir, "export.txt");
    writeFileSync(file, "<TITLE>\nhello");
    const calls = fakePortal({ "GET /knowledge/publication": { revision: "head-1" }, "POST /docs": { path: "content/templates/article.md", revision: "head-2" } });
    const io = captureIo();
    assert.equal(await run(["kb", "import", "templates/article.md", "--file", file, "--source", source, "--id", options.id, "--title", options.title, "--type", "template", "--json"], io), 0);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.absent, true);
    assert.equal(calls[1].body.expectedRevision, "head-1");
    assert.match(calls[1].body.content, /<TITLE>/);
    assert.equal(io.json().id, options.id);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("local preparation needs no portal call and refuses to overwrite a file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kb-import-"));
  try {
    const file = join(dir, "export.txt"), output = join(dir, "import.md");
    writeFileSync(file, "# Guidance\n\nRead this.");
    const calls = fakePortal({});
    const args = ["kb", "import", "reference/guide.md", "--file", file, "--source", source, "--id", "reference.guide", "--title", "Guidance", "--format", "markdown", "--output", output];
    assert.equal(await run(args, captureIo()), 0);
    assert.match(readFileSync(output, "utf8"), /# Guidance\n\nRead this/);
    assert.notEqual(await run(args, captureIo()), 0);
    assert.equal(calls.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
