import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const { run } = await import("../src/cli.mjs");

const BASE = "/api/newsletter-issues/900/draft";
const HASH = "a".repeat(64);
const intro = { id: "nb-1", position: 0, type: "intro", label: "Intro", version: 1, data: { summary: "Hello" }, problems: [] };
const draftOf = (blocks = [intro], extra = {}) => ({
  issueId: "iss-900",
  draft: {
    issueId: "iss-900", subject: "Zoomcamp", previewText: "Free", version: 3, payloadHash: HASH,
    approval: { state: "none" }, delivery: null, problems: [], blocks, ...extra,
  },
});

describe("newsletter draft CLI", () => {
  test("draft --create starts an empty DataOps draft and prints it", async () => {
    const calls = fakePortal({ [`POST ${BASE}`]: () => ({ status: 201, body: draftOf() }) });
    const io = captureIo();
    assert.equal(await run(["newsletter", "draft", "900", "--create"], io), 0, io.errors.join("\n"));
    assert.deepEqual(calls.map((c) => `${c.method} ${c.route}`), [`POST ${BASE}`]);
    assert.match(io.text(), /draft started in DataOps \(nothing was imported\)/);
    assert.match(io.text(), /nb-1\s+intro\s+1/);
    assert.match(io.text(), new RegExp(`payload sha256: ${HASH}`));
  });

  test("draft --subject sends the loaded version", async () => {
    const calls = fakePortal({
      [`GET ${BASE}`]: () => draftOf(),
      [`PUT ${BASE}`]: () => ({ changed: true, ...draftOf() }),
    });
    const io = captureIo();
    assert.equal(await run(["newsletter", "draft", "900", "--subject", "New subject"], io), 0, io.errors.join("\n"));
    assert.deepEqual(calls[1].body, { version: 3, subject: "New subject" });
  });

  test("block add / edit / move / delete go to the draft routes", async () => {
    const rec = { id: "nb-2", position: 1, type: "recording", label: "Recording", version: 2, data: { title: "dbt" }, problems: [] };
    const calls = fakePortal({
      [`POST ${BASE}/blocks`]: () => ({ status: 201, body: { block: { ...rec, problems: ["Recording: cta_url is required."] }, ...draftOf([intro, rec]) } }),
      [`GET ${BASE}`]: () => draftOf([intro, rec]),
      [`PUT ${BASE}/blocks/nb-2`]: () => ({ changed: true, ...draftOf([intro, rec]) }),
      [`POST ${BASE}/blocks/nb-2/move`]: () => draftOf([rec, intro]),
      [`DELETE ${BASE}/blocks/nb-2`]: () => draftOf([intro]),
    });
    const io = captureIo();
    assert.equal(await run(["newsletter", "block", "add", "900", "--type", "recording", "--field", "title=dbt"], io), 0, io.errors.join("\n"));
    assert.deepEqual(calls[0].body, { type: "recording", data: { title: "dbt" } });
    assert.match(io.text(), /to finish: Recording: cta_url is required\./);
    assert.equal(await run(["newsletter", "block", "edit", "900", "nb-2", "--field", "cta_url=https://y.example"], captureIo()), 0);
    assert.deepEqual(calls.find((c) => c.method === "PUT").body, { version: 2, data: { title: "dbt", cta_url: "https://y.example" } });
    assert.equal(await run(["newsletter", "block", "move", "900", "nb-2", "--up"], captureIo()), 0);
    assert.deepEqual(calls.find((c) => c.route.endsWith("/move")).body, { direction: "up" });
    const refused = captureIo();
    assert.notEqual(await run(["newsletter", "block", "delete", "900", "nb-2"], refused), 0, "delete needs --yes");
    assert.equal(await run(["newsletter", "block", "delete", "900", "nb-2", "--yes"], captureIo()), 0);
    assert.ok(calls.every((c) => c.route.startsWith(BASE)), "the CLI never talks to Relay");
  });

  test("render prints the version and payload hash and writes the exact HTML", async () => {
    fakePortal({ [`GET ${BASE}/render`]: () => ({ render: { subject: "S", previewText: "P", html: "<html>x</html>", text: "t", payloadHash: HASH, draftVersion: 3, problems: [] }, approval: { state: "none" } }) });
    const out = join(mkdtempSync(join(tmpdir(), "nl-")), "email.html");
    const io = captureIo();
    assert.equal(await run(["newsletter", "render", "900", "--out", out], io), 0, io.errors.join("\n"));
    assert.equal(readFileSync(out, "utf8"), "<html>x</html>");
    assert.match(io.text(), /version: 3/);
    assert.match(io.text(), new RegExp(`payload sha256: ${HASH}`));
  });

  test("approve needs the reviewed version and hash; the test goes to the owner and is confirmed; schedule needs --yes", async () => {
    const calls = fakePortal({
      [`POST ${BASE}/approve`]: () => ({ payloadHash: HASH, ...draftOf([intro], { approval: { state: "current", draftVersion: 4 } }) }),
      [`POST ${BASE}/schedule`]: () => ({ delivery: { campaignKey: "dataops-newsletter-900-iss", scheduledAt: "2027-03-04T08:00:00.000Z" }, adopted: false }),
      [`POST ${BASE}/test-send`]: () => ({
        testSend: { requestId: "cli-req", campaignKey: "dataops-newsletter-900-iss", status: "provider_accepted", emails: ["alexey@datatalks.club"] },
        ...draftOf([intro], { approval: { state: "current", draftVersion: 4, payloadHash: HASH } }),
      }),
      [`POST ${BASE}/test-receipt`]: () => ({ testReceipt: { approvedVersion: 4, payloadHash: HASH } }),
    });
    assert.notEqual(await run(["newsletter", "approve", "900"], captureIo()), 0, "approve without --version/--hash is refused locally");
    const io = captureIo();
    assert.equal(await run(["newsletter", "approve", "900", "--version", "3", "--hash", HASH, "--note", "ok"], io), 0, io.errors.join("\n"));
    assert.deepEqual(calls.at(-1).body, { version: 3, payloadHash: HASH, note: "ok" });

    const before0 = calls.length;
    assert.notEqual(await run(["newsletter", "test-send", "900", "--to", "someone@x.example"], captureIo()), 0, "no recipient choice");
    assert.equal(calls.length, before0);
    const testIo = captureIo();
    assert.equal(await run(["newsletter", "test-send", "900"], testIo), 0, testIo.errors.join("\n"));
    const sent = calls.at(-1).body;
    assert.equal(sent.emails, undefined, "the server picks the owner's mailbox");
    assert.match(sent.requestId, /^cli-[0-9a-f-]{36}$/);
    assert.match(testIo.text(), new RegExp(`test-receipt 900 --test cli-req --version 4 --hash ${HASH}`));

    assert.notEqual(await run(["newsletter", "test-receipt", "900", "--version", "4", "--hash", HASH], captureIo()), 0, "--test is required");
    assert.equal(await run(["newsletter", "test-receipt", "900", "--test", "cli-req", "--version", "4", "--hash", HASH], captureIo()), 0);
    assert.deepEqual(calls.at(-1).body, { testRequestId: "cli-req", version: 4, payloadHash: HASH });

    const before = calls.length;
    assert.notEqual(await run(["newsletter", "schedule", "900", "--at", "2027-03-04T08:00:00Z", "--version", "4", "--hash", HASH], captureIo()), 0);
    assert.equal(calls.length, before, "nothing is sent without --yes");
    assert.equal(await run(["newsletter", "schedule", "900", "--at", "2027-03-04T08:00:00Z", "--version", "4", "--hash", HASH, "--yes"], captureIo()), 0);
    assert.equal(calls.at(-1).body.scheduledAt, "2027-03-04T08:00:00Z");
    assert.equal(calls.at(-1).body.payloadHash, HASH);
  });

  test("help covers the DataOps-owned flow and never mentions Relay import or sync", async () => {
    const io = captureIo();
    assert.equal(await run(["newsletter", "draft", "--help"], io), 0);
    assert.match(io.text(), /Nothing is imported from or written to\s+Relay while the draft is built/);
    assert.doesNotMatch(io.text(), /--import|blocks-sync|relay-sync|final-render/);
  });
});
