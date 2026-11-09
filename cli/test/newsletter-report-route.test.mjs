import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const { run } = await import("../src/cli.mjs");

const route = { to: "contact@sponsor.example", cc: ["valeriia@datatalks.club"], sender: "orin@datatalks.club", threadRef: "thread-1" };
const report = (overrides = {}) => ({
  issueId: "issue-1", label: "Weekly #1", publicationDate: "2026-11-02", slot: "primary", sponsor: "Synthetic", message: "Hi <NAME>", route, ...overrides,
});

describe("newsletter report routing", () => {
  test("report prints To, Cc, sender and threadRef", async () => {
    fakePortal({ "GET /api/newsletter-issues/issue-1/report": () => ({ reports: [report()] }) });
    const io = captureIo();
    assert.equal(await run(["newsletter", "report", "issue-1"], io), 0);
    assert.match(io.text(), /To: contact@sponsor\.example/);
    assert.match(io.text(), /Cc: valeriia@datatalks\.club/);
    assert.match(io.text(), /From: orin@datatalks\.club/);
    assert.match(io.text(), /threadRef: thread-1/);
  });

  test("report says plainly when no route is recorded", async () => {
    fakePortal({ "GET /api/newsletter-issues/issue-1/report": () => ({ reports: [report({ route: null })] }) });
    const io = captureIo();
    assert.equal(await run(["newsletter", "report", "issue-1"], io), 0);
    assert.match(io.text(), /Route: none recorded/);
  });

  test("--send needs a slot and a contact, then posts and prints the Gmail message id", async () => {
    const calls = fakePortal({
      "POST /api/newsletter-issues/issue-1/report/send": () => ({
        taskId: "task-1", route, emailDelivery: { from: route.sender, to: route.to, cc: route.cc, messageId: "gmail-9" },
      }),
    });
    const bare = captureIo();
    assert.notEqual(await run(["newsletter", "report", "issue-1", "--send", "--contact", "Sam"], bare), 0);
    assert.match(bare.errors.join("\n"), /needs a slot/);
    const noContact = captureIo();
    assert.notEqual(await run(["newsletter", "report", "issue-1", "primary", "--send"], noContact), 0);
    assert.match(noContact.errors.join("\n"), /--contact/);
    assert.equal(calls.length, 0);

    const io = captureIo();
    assert.equal(await run(["newsletter", "report", "issue-1", "primary", "--send", "--contact", "Sam"], io), 0);
    assert.deepEqual(calls[0].body, { slot: "primary", contactName: "Sam" });
    assert.match(io.text(), /Replied in thread thread-1 .*Gmail message gmail-9/);
    assert.match(io.text(), /Closed task task-1/);
  });

  test("route adopts an email-sponsor message", async () => {
    const calls = fakePortal({
      "PUT /api/newsletter-issues/issue-1/slots/primary/route": () => ({ route, taskIds: ["a", "b"] }),
    });
    const io = captureIo();
    assert.equal(await run(["newsletter", "route", "issue-1", "primary", "--message-id", "gmail-1"], io), 0);
    assert.deepEqual(calls[0].body, { messageId: "gmail-1" });
    assert.match(io.text(), /thread thread-1; copied onto 2 task/);
  });
});
