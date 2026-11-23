import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const { run } = await import("../src/cli.mjs");

const set = (blocks) => ({
  issueId: "iss-304",
  blocks: {
    issueId: "iss-304",
    relay: { target: "production", issueKey: "weekly-304" },
    relayIssue: { subject: "Weekly 304" },
    lastSync: { at: "2026-11-23T10:00:00Z", byName: "Orin", summary: "imported 2 blocks" },
    blocks,
  },
});
const intro = { id: "rb-113", relayBlockId: 113, position: 0, type: "intro", label: "Intro", version: 1, data: { summary: "Hello" }, changedSinceSync: false };

describe("newsletter blocks CLI", () => {
  test("blocks --import posts the Relay key and prints every block", async () => {
    const calls = fakePortal({ "POST /api/newsletter-issues/304/blocks/import": () => ({ status: 201, body: set([intro]) }) });
    const io = captureIo();
    assert.equal(await run(["newsletter", "blocks", "304", "--import", "weekly-304"], io), 0, io.errors.join("\n"));
    assert.deepEqual(calls[0].body, { issueKey: "weekly-304", target: "production" });
    assert.match(io.text(), /imported 1 blocks from Relay production weekly-304/);
    assert.match(io.text(), /rb-113\s+intro\s+1\s+in sync/);
  });

  test("block-edit sends the block's version with one field replaced", async () => {
    const calls = fakePortal({
      "GET /api/newsletter-issues/304/blocks": () => set([intro]),
      "PUT /api/newsletter-issues/304/blocks/rb-113": () => ({ changed: true, ...set([{ ...intro, version: 2 }]) }),
    });
    const io = captureIo();
    assert.equal(await run(["newsletter", "block-edit", "304", "113", "--field", "issue_label", "--value", "#304"], io), 0, io.errors.join("\n"));
    assert.deepEqual(calls[1].body, { version: 1, data: { summary: "Hello", issue_label: "#304" } });
    assert.match(io.text(), /saved rb-113 as version 2/);
  });

  test("blocks-sync surfaces a conflict refusal as an error", async () => {
    fakePortal({
      "POST /api/newsletter-issues/304/blocks/sync": () => ({
        status: 409,
        body: { error: "Sync refused: 1 block(s) changed both in DataOps and in Relay since the last sync.", code: "blocks_sync_conflict" },
      }),
    });
    const io = captureIo();
    assert.notEqual(await run(["newsletter", "blocks-sync", "304"], io), 0);
    assert.match(io.errors.join("\n"), /Sync refused/);
  });

  test("revisions lists revisions and --diff prints field line diffs", async () => {
    const revisions = [
      { revision: 1, blockId: "rb-113", blockType: "intro", label: "Intro", origin: "import", createdAt: "2026-11-23T10:00:00Z", actorName: "Orin", relayActor: "api:dtc", before: null, after: { summary: "Hello" }, changes: [{ field: "summary", before: "", after: "Hello" }] },
      { revision: 2, blockId: "rb-113", blockType: "intro", label: "Intro", origin: "edit", createdAt: "2026-11-23T11:00:00Z", actorName: "Alexey", before: { summary: "Hello\nworld" }, after: { summary: "Hello\nthere" }, changes: [{ field: "summary", before: "Hello\nworld", after: "Hello\nthere" }] },
    ];
    const calls = fakePortal({ "GET /api/newsletter-issues/304/blocks/revisions": () => ({ issueId: "iss-304", revisions }) });
    const io = captureIo();
    assert.equal(await run(["newsletter", "revisions", "304"], io), 0, io.errors.join("\n"));
    assert.match(io.text(), /2\s+2026-11-23 11:00:00\s+rb-113 intro\s+edit\s+Alexey\s+summary/);

    const diff = captureIo();
    assert.equal(await run(["newsletter", "revisions", "304", "--origin", "edit", "--diff", "--block", "rb-113"], diff), 0, diff.errors.join("\n"));
    assert.deepEqual(calls[1].query, { block: "113" });
    assert.match(diff.text(), /=== rev 2 · rb-113 Intro · edit by Alexey/);
    assert.match(diff.text(), /  Hello\n- world\n\+ there/);
    assert.doesNotMatch(diff.text(), /rev 1/);
  });
});

describe("newsletter block add/move/delete CLI", () => {
  const sponsor = { ...intro, id: "rb-114", relayBlockId: 114, position: 1, type: "sponsor", label: "Sponsor (main)", sponsor: "primary", pinned: true, readOnly: true, data: { title: "Acme" } };
  const refusal = (code, error) => ({ status: 409, body: { error, code } });

  test("block add posts type, position and fields", async () => {
    const calls = fakePortal({
      "POST /api/newsletter-issues/304/blocks": () => ({ status: 201, block: { id: "nb-1", position: 2 }, ...set([intro]) }),
    });
    const io = captureIo();
    const argv = ["newsletter", "block", "add", "304", "--type", "recording", "--position", "2", "--field", "title=Talk", "--field", "cta_url=https://x.io"];
    assert.equal(await run(argv, io), 0, io.errors.join("\n"));
    assert.deepEqual(calls[0].body, { type: "recording", data: { title: "Talk", cta_url: "https://x.io" }, position: 2 });
    assert.match(io.text(), /added nb-1 at position 2/);
  });

  test("block add of a sponsor type prints the server refusal and fails", async () => {
    fakePortal({ "POST /api/newsletter-issues/304/blocks": () => refusal("sponsor_block_doc_only", "Sponsor blocks come from the sponsor doc.") });
    const io = captureIo();
    assert.notEqual(await run(["newsletter", "block", "add", "304", "--type", "sponsor"], io), 0);
    assert.match(io.errors.join("\n"), /Sponsor blocks come from the sponsor doc/);
  });

  test("block edit with name=value merges into the block's data", async () => {
    const calls = fakePortal({
      "GET /api/newsletter-issues/304/blocks": () => set([intro]),
      "PUT /api/newsletter-issues/304/blocks/rb-113": () => ({ changed: true, ...set([intro]) }),
    });
    const io = captureIo();
    assert.equal(await run(["newsletter", "block", "edit", "304", "rb-113", "--field", "summary=Hi"], io), 0, io.errors.join("\n"));
    assert.deepEqual(calls[1].body, { version: 1, data: { summary: "Hi" } });
  });

  test("block edit of a sponsor block is refused loudly", async () => {
    fakePortal({
      "GET /api/newsletter-issues/304/blocks": () => set([intro, sponsor]),
      "PUT /api/newsletter-issues/304/blocks/rb-114": () => refusal("sponsor_block_readonly", "Sponsor content is edited in the sponsor doc."),
    });
    const io = captureIo();
    assert.notEqual(await run(["newsletter", "block", "edit", "304", "rb-114", "--field", "title=X"], io), 0);
    assert.match(io.errors.join("\n"), /edited in the sponsor doc/);
  });

  test("block move sends direction or index; pinned move is refused", async () => {
    const calls = fakePortal({
      "GET /api/newsletter-issues/304/blocks": () => set([intro, sponsor]),
      "POST /api/newsletter-issues/304/blocks/rb-113/move": () => set([{ ...intro, position: 1 }, { ...sponsor, position: 0 }]),
      "POST /api/newsletter-issues/304/blocks/rb-114/move": () => refusal("sponsor_block_pinned", "The main sponsor block is pinned."),
    });
    const io = captureIo();
    assert.equal(await run(["newsletter", "block", "move", "304", "rb-113", "--down"], io), 0, io.errors.join("\n"));
    assert.deepEqual(calls[1].body, { direction: "down" });
    const bad = captureIo();
    assert.notEqual(await run(["newsletter", "block", "move", "304", "rb-114", "--to", "0"], bad), 0);
    assert.deepEqual(calls.at(-1).body, { to: 0 });
    assert.match(bad.errors.join("\n"), /pinned/);
  });

  test("block delete needs --yes and surfaces the secondary-sponsor refusal", async () => {
    const calls = fakePortal({
      "GET /api/newsletter-issues/304/blocks": () => set([intro]),
      "DELETE /api/newsletter-issues/304/blocks/rb-113": () => set([]),
    });
    const io = captureIo();
    assert.notEqual(await run(["newsletter", "block", "delete", "304", "rb-113"], io), 0);
    assert.equal(calls.filter((c) => c.method === "DELETE").length, 0);
    const ok = captureIo();
    assert.equal(await run(["newsletter", "block", "delete", "304", "rb-113", "--yes"], ok), 0, ok.errors.join("\n"));
    assert.match(ok.text(), /deleted rb-113/);
  });

  test("sponsor-sync posts slot, dry-run and force", async () => {
    const calls = fakePortal({ "POST /api/newsletter-issues/304/blocks/sponsor-sync": () => ({ result: { summary: "updated 1 block" } }) });
    const io = captureIo();
    assert.equal(await run(["newsletter", "sponsor-sync", "304", "--slot", "secondary", "--force"], io), 0, io.errors.join("\n"));
    assert.deepEqual(calls[0].body, { slot: "secondary", dryRun: false, force: true });
    assert.match(io.text(), /sponsor-sync secondary: updated 1 block/);
  });

  test("revisions shows the detail of a move", async () => {
    fakePortal({
      "GET /api/newsletter-issues/304/blocks/revisions": () => ({
        issueId: "iss-304",
        revisions: [{ revision: 3, blockId: "rb-113", blockType: "intro", label: "Intro", origin: "move", detail: "moved 0 -> 2", createdAt: "2026-11-23T11:00:00Z", actorName: "Alexey", before: null, after: null, changes: [] }],
      }),
    });
    const io = captureIo();
    assert.equal(await run(["newsletter", "revisions", "304", "--diff"], io), 0, io.errors.join("\n"));
    assert.match(io.text(), /moved 0 -> 2/);
  });
});
