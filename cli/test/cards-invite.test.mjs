import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const { run } = await import("../src/cli.mjs");

describe("cards invite commands", () => {
  test("invite add posts the invite and prints confirmation", async () => {
    const calls = fakePortal({
      "POST /api/cards/card-1/calendar-invites": (call) => ({
        card: { id: "card-1" },
        invites: [{ ...call.body }],
      }),
    });
    const io = captureIo();
    const code = await run(
      ["cards", "invite", "add", "card-1", "--event-id", "evt1", "--calendar", "alexey@datatalks.club", "--label", "original"],
      io,
    );
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].route, "/api/cards/card-1/calendar-invites");
    assert.deepEqual(calls[0].body, {
      eventId: "evt1",
      calendar: "alexey@datatalks.club",
      label: "original",
    });
    assert.match(io.text(), /Linked invite evt1/);
  });

  test("invite add supports --url and --json", async () => {
    fakePortal({
      "POST /api/cards/card-2/calendar-invites": (call) => ({
        card: { id: "card-2" },
        invites: [{ ...call.body }],
      }),
    });
    const io = captureIo();
    const code = await run(
      ["cards", "invite", "add", "card-2", "--event-id", "evt2", "--calendar", "c2", "--url", "https://example.com/e", "--json"],
      io,
    );
    assert.equal(code, 0);
    const result = io.json();
    assert.equal(result.invites[0].url, "https://example.com/e");
  });

  test("invite list prints the invites table", async () => {
    fakePortal({
      "GET /api/cards/card-1/calendar-invites": {
        invites: [
          { eventId: "evt1", calendar: "alexey@datatalks.club", label: "original" },
          { eventId: "evt2", calendar: "alexey.s.grigoriev@gmail.com", url: "https://example.com/e" },
        ],
      },
    });
    const io = captureIo();
    const code = await run(["cards", "invite", "list", "card-1"], io);
    assert.equal(code, 0);
    assert.match(io.text(), /evt1/);
    assert.match(io.text(), /evt2/);
  });

  test("invite list --json returns the invites", async () => {
    fakePortal({
      "GET /api/cards/card-9/calendar-invites": { invites: [] },
    });
    const io = captureIo();
    const code = await run(["cards", "invite", "list", "card-9", "--json"], io);
    assert.equal(code, 0);
    assert.deepEqual(io.json(), { invites: [] });
  });
});
