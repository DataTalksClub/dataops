import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateConfig, fakePortal } from "./helpers.mjs";

isolateConfig();
const { exportDocument } = await import("../src/commands/documents-transfer.mjs");
const { create } = await import("../src/commands/sponsorDocs.mjs");
const directory = mkdtempSync(join(tmpdir(), "doc-transfer-"));
after(() => rmSync(directory, { recursive: true, force: true }));
const io = { print() {} };

test("DOCX download preserves bytes and fails before writing on HTTP errors", async () => {
  const bytes = Buffer.from([80, 75, 3, 4, 0, 255, 128, 42]);
  const calls = fakePortal({ "GET /api/sponsor-docs/source/export": () => new Response(bytes) });
  const output = join(directory, "export.docx");
  await exportDocument({ format: "docx", output }, io, "/api/sponsor-docs/source/export", "source");
  assert.deepEqual(readFileSync(output), bytes);
  assert.equal(calls[0].query.format, "docx");
  fakePortal({ "GET /api/sponsor-docs/source/export": { status: 403, body: { error: "Denied" } } });
  await assert.rejects(exportDocument({ format: "docx", output }, io, "/api/sponsor-docs/source/export", "source"), /Denied/);
  assert.deepEqual(readFileSync(output), bytes);
});

test("exports Markdown to stdout and rejects unsupported formats or missing DOCX output", async () => {
  fakePortal({ "GET /api/documents/id/export": () => new Response("# Authored ✓") });
  const lines = [];
  const result = await exportDocument({}, { print: line => lines.push(line) }, "/api/documents/id/export", "id");
  assert.equal(result.content, "# Authored ✓");
  assert.deepEqual(lines, ["# Authored ✓"]);
  await assert.rejects(exportDocument({ format: "pdf" }, io, "unused", "id"), /--format/);
  await assert.rejects(exportDocument({ format: "docx" }, io, "unused", "id"), /--output/);
});

test("copy CLI sends source ID and leaves podcast template inference to source", async () => {
  const calls = fakePortal({ "POST /api/sponsor-docs": { doc: { id: "new" } } });
  await create({ _: ["target-card"], _domain: "podcast", from: "https://ops.dtcdev.click/podcast-docs/source?code=secret", json: true }, io);
  assert.equal(calls[0].body.from, "source");
  assert.equal(calls[0].body.cardId, "target-card");
  assert.equal(calls[0].body.template, undefined);
});
