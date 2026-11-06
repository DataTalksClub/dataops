import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const { run } = await import("../src/cli.mjs");

const DOC_ID = "1AbCdEfGhIjKlMnOpQrStUvWx";
const DOC_TEXT = "Hello <RECIPIENT_NAME>,\n\nPlease review <DOC_NAME> before <DUE_DATE>.\n";
const GDOC_EXPORT_BODY = {
  docId: DOC_ID,
  source: `https://docs.google.com/document/d/${DOC_ID}/edit`,
  content: DOC_TEXT,
  sha256: "a".repeat(64),
  sizeBytes: DOC_TEXT.length,
};

describe("CLI kb import-gdoc", () => {
  function fake(routes) {
    const calls = fakePortal(routes);
    return { calls, restore: () => { delete globalThis.fetch; } };
  }

  test("fetches via the backend and prepares a local markdown file with --output", async () => {
    const io = captureIo();
    const dir = mkdtempSync(path.join(tmpdir(), "dataops-gdoc-"));
    const output = path.join(dir, "prepared.md");
    const portal = fake({
      "POST /api/kb/import-gdoc": GDOC_EXPORT_BODY,
    });
    try {
      const code = await run(
        ["kb", "import-gdoc", "--path", "content/x/sops/doc-review.md", "--doc-id", DOC_ID, "--title", "Doc review", "--output", output],
        io,
      );
      assert.equal(code, 0);
      const imported = readFileSync(output, "utf8");
      assert.match(imported, /^---\nid: "doc-review"/);
      assert.match(imported, /doc_type: reference/);
      assert.match(imported, /# Doc review/);
      assert.match(imported, /Hello <RECIPIENT_NAME>/);
      assert.match(imported, new RegExp(DOC_ID));
      // The fetch call carries the doc id; no Google host is contacted by the CLI itself.
      assert.equal(portal.calls.length, 1);
      assert.equal(portal.calls[0].route, "/api/kb/import-gdoc");
      assert.deepEqual(portal.calls[0].body, { docId: DOC_ID });
    } finally {
      portal.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("publishes through the knowledge revision flow without --output", async () => {
    const io = captureIo();
    const portal = fake({
      "POST /api/kb/import-gdoc": GDOC_EXPORT_BODY,
      "GET /knowledge/publication": { revision: "rev-7" },
      "POST /docs": { revision: "rev-8" },
    });
    try {
      const code = await run(
        ["kb", "import-gdoc", "content/x/sops/doc-review.md", "--doc-id", `https://docs.google.com/document/d/${DOC_ID}/edit`, "--title", "Doc review", "--type", "template"],
        io,
      );
      assert.equal(code, 0);
      assert.equal(portal.calls.length, 3);
      const save = portal.calls[2];
      assert.equal(save.method, "POST");
      assert.equal(save.route, "/docs");
      assert.equal(save.body.path, "content/x/sops/doc-review.md");
      assert.equal(save.body.doc_type, "template");
      assert.equal(save.body.expectedRevision, "rev-7");
      assert.match(save.body.content, /## Template/);
      assert.match(io.text(), /Imported content\/x\/sops\/doc-review\.md \(doc-review, revision rev-8\)/);
    } finally {
      portal.restore();
    }
  });

  test("surfaces a backend fetch failure and stops before publishing", async () => {
    const io = captureIo();
    const portal = fake({
      "POST /api/kb/import-gdoc": { status: 502, body: { error: "The Google Docs export failed (HTTP 403).", code: "gdoc-fetch-failed" } },
    });
    try {
      const code = await run(["kb", "import-gdoc", "--path", "content/x/sops/doc-review.md", "--doc-id", DOC_ID, "--title", "Doc review"], io);
      assert.equal(code, 7);
      assert.equal(portal.calls.length, 1);
    } finally {
      portal.restore();
    }
  });

  test("rejects a missing --doc-id before any call", async () => {
    const io = captureIo();
    const portal = fake({});
    try {
      const code = await run(["kb", "import-gdoc", "--path", "content/x/sops/doc-review.md", "--title", "Doc review"], io);
      assert.equal(code, 2);
      assert.equal(portal.calls.length, 0);
    } finally {
      portal.restore();
    }
  });
});

describe("CLI text-templates", () => {
  function fake(routes) {
    const calls = fakePortal(routes);
    return { calls, restore: () => { delete globalThis.fetch; } };
  }

  const RECORD = {
    templates: [{
      id: "reply.out-of-office", title: "Out of office", body: "Hi <NAME>, back <DATE>.", description: null,
      placeholders: ["NAME", "DATE"], updatedAt: "2026-11-05T10:00:00Z", updatedBy: "u1",
    }],
    version: 3,
  };

  test("list prints the record summary", async () => {
    const io = captureIo();
    const portal = fake({ "GET /api/text-templates": RECORD });
    try {
      const code = await run(["text-templates", "list"], io);
      assert.equal(code, 0);
      assert.match(io.text(), /reply\.out-of-office/);
      assert.match(io.text(), /<NAME>/);
    } finally { portal.restore(); }
  });

  test("create reads the version first, then posts", async () => {
    const io = captureIo();
    const portal = fake({
      "GET /api/text-templates": { templates: [], version: 0 },
      "POST /api/text-templates": { template: { id: "reply.a" }, version: 1 },
    });
    try {
      const code = await run(["text-templates", "create", "reply.a", "--title", "A", "--body", "hello <NAME>"], io);
      assert.equal(code, 0);
      assert.equal(portal.calls.length, 2);
      assert.equal(portal.calls[1].body.expectedVersion, 0);
      assert.equal(portal.calls[1].body.body, "hello <NAME>");
    } finally { portal.restore(); }
  });

  test("update honors an explicit --expected-version and skips the read", async () => {
    const io = captureIo();
    const portal = fake({
      "PUT /api/text-templates/reply.a": { template: { id: "reply.a" }, version: 4 },
    });
    try {
      const code = await run(["text-templates", "update", "reply.a", "--title", "A2", "--expected-version", "3"], io);
      assert.equal(code, 0);
      assert.equal(portal.calls.length, 1);
      assert.equal(portal.calls[0].body.expectedVersion, 3);
      assert.equal(portal.calls[0].body.title, "A2");
    } finally { portal.restore(); }
  });

  test("render sends values and prints the rendered text", async () => {
    const io = captureIo();
    const portal = fake({
      "POST /api/text-templates/reply.a/render": { id: "reply.a", text: "Hi Anna, back 3 November.", placeholders: ["NAME", "DATE"], unused: [] },
    });
    try {
      const code = await run(["text-templates", "render", "reply.a", "--value", "NAME=Anna", "--value", "DATE=3 November"], io);
      assert.equal(code, 0);
      assert.deepEqual(portal.calls[0].body, { values: { NAME: "Anna", DATE: "3 November" } });
      assert.match(io.text(), /Hi Anna, back 3 November\./);
    } finally { portal.restore(); }
  });

  test("delete passes the version as a query parameter", async () => {
    const io = captureIo();
    const portal = fake({
      "GET /api/text-templates": RECORD,
      "DELETE /api/text-templates/reply.out-of-office": { deleted: "reply.out-of-office", version: 4 },
    });
    try {
      const code = await run(["text-templates", "delete", "reply.out-of-office"], io);
      assert.equal(code, 0);
      assert.equal(portal.calls[1].query.expectedVersion, "3");
    } finally { portal.restore(); }
  });
});
