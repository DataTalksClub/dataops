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
