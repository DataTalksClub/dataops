import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const realFetch = globalThis.fetch;
const { run } = await import("../src/cli.mjs");
const { docRefFromUrl } = await import("../src/commands/kb.mjs");

afterEach(() => {
  globalThis.fetch = realFetch;
});

const DOCS = [
  { id: "news.schedule", path: "content/newsletter/sops/schedule.md", title: "Schedule the newsletter", doc_type: "sop" },
  { id: "news.ref", path: "content/newsletter/reference.md", title: "Newsletter reference", doc_type: "reference" },
  { id: "fin.invoice", path: "content/finance/reference/invoice.md", title: "Invoices", doc_type: "reference" },
];

const byRef = (ref) => DOCS.find((doc) => doc.id === ref || doc.path === ref || doc.path === `content/${ref}`);
const docsRoutes = {
  "GET /docs": ({ query }) =>
    query.path ? { path: query.path, content: `# ${byRef(query.path).title}\n`, revision: "rev-1" } : { documents: DOCS },
  "GET /docs/resolve": ({ query }) => (byRef(query.ref) ? { document: byRef(query.ref) } : { status: 404, body: { error: `Document reference not found: ${query.ref}` } }),
};

describe("kb search", () => {
  test("queries the docs index directly, not through the /work seam, and keeps rank order", async () => {
    const calls = fakePortal({
      "GET /search": {
        query: "invoice",
        results: [
          { id: "fin.invoice", path: DOCS[2].path, title: "Invoices", doc_type: "reference", score: 3.2, snippet: "…send the invoice…" },
          { id: "news.ref", path: DOCS[1].path, title: "Newsletter reference", doc_type: "reference", score: 1.1, summary: "Plan" },
        ],
      },
    });
    const io = captureIo();
    assert.equal(await run(["kb", "search", "sponsor", "invoice", "--type", "reference", "--limit", "5", "--json"], io), 0);
    assert.equal(calls[0].rawPath, "/search");
    assert.deepEqual(calls[0].query, { q: "sponsor invoice", source: "docs", limit: "5", doc_type: "reference" });
    const result = io.json();
    assert.deepEqual(result.results.map((item) => [item.rank, item.id]), [[1, "fin.invoice"], [2, "news.ref"]]);
    assert.equal(result.results[1].snippet, "Plan");
  });

  test("an empty query is a usage error", async () => {
    assert.equal(await run(["kb", "search"], captureIo()), 2);
  });
});

describe("kb recent", () => {
  test("lists recently changed docs with the limit and a readable table", async () => {
    const calls = fakePortal({
      "GET /knowledge/recent": {
        revision: "rev-2",
        complete: false,
        scanned: 3,
        changes: [
          { path: "content/newsletter/sops/schedule.md", operation: "edit", actor: "git:DataTalksClub/dataops-knowledge@0123456789ab", actorName: "Git 0123456", time: "2026-10-15T10:00:00.000Z", changes: 2, deleted: false },
          { path: "content/old.md", operation: "delete", actor: "u1", actorName: "Orin Vale", time: "2026-10-14T09:00:00.000Z", changes: 1, deleted: true },
        ],
      },
    });
    const io = captureIo();
    assert.equal(await run(["kb", "recent", "--limit", "2"], io), 0);
    assert.equal(calls[0].rawPath, "/knowledge/recent");
    assert.deepEqual(calls[0].query, { limit: "2" });
    assert.match(io.text(), /Git 0123456\s+edit x2\s+newsletter\/sops\/schedule\.md/);
    assert.match(io.text(), /Orin Vale\s+delete\s+old\.md \(deleted\)/);
    assert.equal(await run(["kb", "recent", "--limit", "0"], captureIo()), 2);
  });
});

describe("kb browse", () => {
  test("show resolves an id and prints the markdown", async () => {
    fakePortal(docsRoutes);
    const io = captureIo();
    assert.equal(await run(["kb", "show", "news.schedule"], io), 0);
    assert.equal(io.text(), "# Schedule the newsletter\n");
  });

  test("an unknown reference exits 4", async () => {
    fakePortal(docsRoutes);
    assert.equal(await run(["kb", "show", "missing.doc"], captureIo()), 4);
  });

  test("ls lists one folder; tree nests folders and respects --depth", async () => {
    fakePortal(docsRoutes);
    let io = captureIo();
    await run(["kb", "ls", "content/newsletter", "--json"], io);
    const listing = io.json();
    assert.deepEqual(listing.folders, [{ name: "sops", path: "newsletter/sops", documents: 1 }]);
    assert.deepEqual(listing.documents.map((doc) => doc.id), ["news.ref"]);
    io = captureIo();
    await run(["kb", "tree", "--depth", "1", "--json"], io);
    const tree = io.json();
    assert.deepEqual(tree.folders.map((folder) => folder.name), ["finance", "newsletter"]);
    assert.ok(tree.folders[1].folders[0].collapsed);
    io = captureIo();
    await run(["kb", "tree"], io);
    assert.match(io.text(), /^content\/\n {2}finance\/\n {4}reference\/\n {6}- Invoices \[reference\] fin\.invoice/);
  });
});

describe("kb code", () => {
  const CODE_VIEW_DOC = {
    id: "news.schedule-code",
    path: "content/newsletter/code-views/schedule-code.md",
    title: "Schedule the newsletter — code view",
    doc_type: "code-view",
  };
  const PARSED = {
    files: [
      { name: "schedule.sh", language: "bash", anchor: "file-schedule-sh" },
      { name: "verify.py", language: "python", anchor: "file-verify-py" },
    ],
    blocks: [
      { kind: "markdown", anchor: "section-1-notes", heading: "Notes", body_md: "Dry-run first." },
      { kind: "file", name: "schedule.sh", language: "bash", anchor: "file-schedule-sh", code: "echo dry-run\n" },
      { kind: "file", name: "verify.py", language: "python", anchor: "file-verify-py", code: "print('ok')\n" },
    ],
  };
  const codeRoutes = {
    ...docsRoutes,
    "GET /docs/resolve": ({ query }) => ({ document: byRef(query.ref) || CODE_VIEW_DOC }),
    "GET /docs": ({ query }) => {
      if (query.path === CODE_VIEW_DOC.path) {
        return {
          path: CODE_VIEW_DOC.path,
          content: "# code view\n",
          revision: "rev-1",
          doc_type: "code-view",
          parsed_code_view: PARSED,
          sop_doc: { path: DOCS[0].path, title: DOCS[0].title },
        };
      }
      const base = docsRoutes["GET /docs"]({ query });
      return { ...base, doc_type: "sop", code_view: { path: CODE_VIEW_DOC.path, title: CODE_VIEW_DOC.title } };
    },
  };

  test("follows the SOP's linked code view and prints files in author order", async () => {
    const calls = fakePortal(codeRoutes);
    const io = captureIo();
    assert.equal(await run(["kb", "code", "news.schedule"], io), 0);
    assert.equal(calls[2].query.path, CODE_VIEW_DOC.path, "must fetch the linked code view document");
    const text = io.text();
    assert.match(text, /code view of content\/newsletter\/sops\/schedule\.md/);
    assert.match(text, /```bash schedule\.sh\necho dry-run\n```/);
    assert.match(text, /```python verify\.py/);
    const order = [text.indexOf("schedule.sh"), text.indexOf("verify.py")];
    assert.ok(order[0] >= 0 && order[0] < order[1], "author order is preserved");
  });

  test("prints the code view directly when given the view itself, with --json blocks", async () => {
    fakePortal(codeRoutes);
    const io = captureIo();
    assert.equal(await run(["kb", "code", "news.schedule-code", "--json"], io), 0);
    const result = io.json();
    assert.equal(result.path, CODE_VIEW_DOC.path);
    assert.equal(result.sop, DOCS[0].path);
    assert.deepEqual(result.files, [
      { name: "schedule.sh", language: "bash" },
      { name: "verify.py", language: "python" },
    ]);
    assert.equal(result.blocks.length, 3);
    assert.equal(result.blocks[1].code, "echo dry-run\n");
  });

  test("states plainly when no code view exists instead of inventing one", async () => {
    fakePortal(docsRoutes);
    const io = captureIo();
    assert.equal(await run(["kb", "code", "fin.invoice"], io), 0);
    assert.match(io.text(), /no code view is linked/);
  });

  test("reports a broken code view through parse_code_error", async () => {
    fakePortal({
      ...docsRoutes,
      "GET /docs": ({ query }) => ({
        ...docsRoutes["GET /docs"]({ query }),
        doc_type: "sop",
        code_view: { path: CODE_VIEW_DOC.path, title: CODE_VIEW_DOC.title },
      }),
      "GET /docs/resolve": ({ query }) => ({ document: byRef(query.ref) }),
    });
    const broken = fakePortal({
      ...codeRoutes,
      "GET /docs": ({ query }) => {
        if (query.path === CODE_VIEW_DOC.path) {
          return { path: query.path, content: "", revision: "rev-1", doc_type: "code-view", parsed_code_view: null, parse_code_error: "line 7: duplicate file block 'a.sh'", sop_doc: { path: DOCS[0].path, title: DOCS[0].title } };
        }
        return { path: query.path, content: "", revision: "rev-1", doc_type: "sop", code_view: { path: CODE_VIEW_DOC.path, title: CODE_VIEW_DOC.title } };
      },
    });
    const io = captureIo();
    assert.equal(await run(["kb", "code", "news.schedule"], io), 6);
    assert.match(io.errors.join("\n"), /duplicate file block/);
  });

  test("reports invalid discovery as an error rather than an absent alternative", async () => {
    fakePortal({
      ...docsRoutes,
      "GET /docs": ({ query }) => ({
        path: query.path, code_view: null,
        code_view_error: "Multiple code views target this SOP",
      }),
    });
    const io = captureIo();
    assert.equal(await run(["kb", "code", "news.schedule"], io), 6);
    assert.match(io.errors.join("\n"), /Multiple code views/);
    assert.doesNotMatch(io.text(), /no code view is linked/);
  });
});

describe("kb related", () => {
  test("lists the docs a task links, then search matches that are not already linked", async () => {
    const calls = fakePortal({
      ...docsRoutes,
      "GET /api/tasks/t-1": {
        id: "t-1",
        description: "Schedule the 2026-11-02 issue",
        cardId: "c-1",
        templateId: "tpl-1",
        instructionDocId: "news.schedule",
        instructionsUrl: "https://portal.test/knowledge?path=content/newsletter/reference.md",
      },
      "GET /api/cards/c-1": { card: { id: "c-1", title: "Newsletter", sourceDocIds: ["gone.doc"] } },
      "GET /api/templates/tpl-1": { template: { id: "tpl-1", name: "Newsletter issue", sourceDocIds: ["news.schedule"] } },
      "GET /search": {
        results: [
          { id: "news.schedule", path: DOCS[0].path, title: "Schedule the newsletter", doc_type: "sop", score: 5 },
          { id: "fin.invoice", path: DOCS[2].path, title: "Invoices", doc_type: "reference", score: 1, snippet: "x" },
        ],
      },
    });
    const io = captureIo();
    assert.equal(await run(["kb", "related", "t-1", "--json"], io), 0);
    const result = io.json();
    assert.deepEqual(result.subject, { kind: "task", id: "t-1", title: "Schedule the 2026-11-02 issue", cardId: "c-1", templateId: "tpl-1" });
    assert.deepEqual(result.linked.map((doc) => [doc.id, doc.via]), [
      ["news.schedule", "task instructions"],
      ["news.ref", "task instructions link"],
    ]);
    assert.deepEqual(result.unresolved.map((item) => item.ref), ["gone.doc"]);
    assert.equal(result.query, "Schedule the issue Newsletter Newsletter issue");
    assert.deepEqual(result.matches.map((item) => item.id), ["fin.invoice"]);
    assert.equal(calls.find((call) => call.route === "/search").query.source, "docs");
  });

  test("falls back to a card id and reports a missing id as not found", async () => {
    fakePortal({
      ...docsRoutes,
      "GET /api/cards/c-9": { card: { id: "c-9", title: "Invoice run" } },
      "GET /search": { results: [] },
    });
    let io = captureIo();
    assert.equal(await run(["kb", "related", "c-9", "--json"], io), 0);
    assert.equal(io.json().subject.kind, "card");
    io = captureIo();
    assert.equal(await run(["kb", "related", "nothing"], io), 4);
    assert.match(io.errors.join("\n"), /No Task or Card with id nothing/);
  });

  test("doc references are read out of portal and content links", () => {
    assert.equal(docRefFromUrl("https://ops.example/knowledge?path=content/a/b.md"), "content/a/b.md");
    assert.equal(docRefFromUrl("/docs?docId=a.b"), "a.b");
    assert.equal(docRefFromUrl("https://github.com/org/repo/blob/main/content/a/b.md"), "content/a/b.md");
    assert.equal(docRefFromUrl("https://example.com/unrelated"), "");
    assert.equal(docRefFromUrl(""), "");
  });
});

describe("kb write", () => {
  test("publishes against the document's current revision", async () => {
    const calls = fakePortal({
      ...docsRoutes,
      "PUT /docs": ({ query, body }) => ({ path: query.path, revision: "rev-2", warnings: [], received: body }),
    });
    const file = new URL("../package.json", import.meta.url).pathname;
    assert.equal(await run(["kb", "write", "newsletter/reference.md", "--file", file], captureIo()), 0);
    const put = calls.at(-1);
    assert.equal(put.query.path, "content/newsletter/reference.md");
    assert.equal(put.body.expectedRevision, "rev-1");
  });

  test("a new document needs --create, which creates it at the head revision first", async () => {
    const calls = fakePortal({
      "GET /docs": { status: 404, body: { error: "Document not found" } },
      "GET /knowledge/publication": { revision: "rev-head" },
      "POST /docs": ({ body }) => ({ status: 201, body: { path: body.path, revision: "rev-new" } }),
      "PUT /docs": ({ query }) => ({ path: query.path, revision: "rev-3" }),
    });
    const file = new URL("../package.json", import.meta.url).pathname;
    assert.equal(await run(["kb", "write", "new/doc.md", "--file", file], captureIo()), 2);
    assert.equal(await run(["kb", "write", "new/doc.md", "--file", file, "--create", "--title", "New"], captureIo()), 0);
    const post = calls.find((call) => call.method === "POST");
    assert.deepEqual(post.body, { path: "content/new/doc.md", absent: true, expectedRevision: "rev-head", title: "New" });
    assert.equal(calls.at(-1).body.expectedRevision, "rev-new");
  });
});
