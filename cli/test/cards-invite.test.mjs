import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const { run } = await import("../src/cli.mjs");

describe("cards invite commands", () => {
  test("invite add is refused: invites come only from cards time", async () => {
    const calls = fakePortal({});
    const io = captureIo();
    const code = await run(["cards", "invite", "add", "card-1", "--event-id", "evt1", "--calendar", "c"], io);
    assert.equal(code, 2);
    assert.equal(calls.length, 0);
    assert.match(io.errors.join("\n"), /dataops cards time <card-id>/);
  });

  test("invite remove unlinks the reference and says the Google event is untouched", async () => {
    const calls = fakePortal({
      "DELETE /api/cards/card-1/calendar-invites": (call) => ({
        removed: [{ eventId: call.body.eventId, calendar: "f8q@group.calendar.google.com" }],
        invites: [],
      }),
    });
    const io = captureIo();
    const code = await run(["cards", "invite", "remove", "card-1", "73k76upek7pl1muft4dd52sggg"], io);
    assert.equal(code, 0);
    assert.deepEqual(calls[0].body, { eventId: "73k76upek7pl1muft4dd52sggg" });
    assert.match(io.text(), /Unlinked invite 73k76upek7pl1muft4dd52sggg on DTC events .*Google event is untouched/);
  });

  test("invite remove --calendar narrows to one calendar and --json returns the result", async () => {
    const calls = fakePortal({
      "DELETE /api/cards/card-2/calendar-invites": (call) => ({ removed: [{ ...call.body }], invites: [] }),
    });
    const io = captureIo();
    const code = await run(["cards", "invite", "remove", "card-2", "evt", "--calendar", "alexey.s.grigoriev@gmail.com", "--json"], io);
    assert.equal(code, 0);
    assert.deepEqual(calls[0].body, { eventId: "evt", calendar: "alexey.s.grigoriev@gmail.com" });
    assert.equal(io.json().removed[0].calendar, "alexey.s.grigoriev@gmail.com");
  });

  test("event-slots previews by default and --apply creates", async () => {
    const calls = fakePortal({
      "GET /api/cards/course-1/event-slots": { eventSlots: [{ slot: "Pre-Course Live Q&A", taskId: "t1", taskStatus: "todo", outcome: "planned", cardTitle: "Course: Pre-Course Live Q&A" }] },
      "POST /api/cards/course-1/event-slots": { eventSlots: [{ slot: "Pre-Course Live Q&A", taskId: "t1", taskStatus: "todo", outcome: "created", cardId: "ev-1" }] },
    });
    const preview = captureIo();
    assert.equal(await run(["cards", "event-slots", "course-1"], preview), 0);
    assert.match(preview.text(), /planned/);
    assert.match(preview.text(), /--apply creates/);
    const applied = captureIo();
    assert.equal(await run(["cards", "event-slots", "course-1", "--apply"], applied), 0);
    assert.match(applied.text(), /created/);
    assert.deepEqual(calls.map((call) => call.method), ["GET", "POST"]);
  });

  test("link adds a link the Card's Template defines but the Card predates", async () => {
    const card = { id: "ev-2", title: "Webinar", stage: "preparation", version: 3, templateId: "tpl-w", cardLinks: [{ name: "Meetup", url: "" }] };
    const calls = fakePortal({
      "GET /api/cards/ev-2": { card },
      "GET /api/templates/tpl-w": { template: { id: "tpl-w", cardLinkDefinitions: [{ name: "Meetup" }, { name: "Meetup Global" }] } },
      "PUT /api/cards/ev-2": ({ body }) => ({ card: { ...card, ...body } }),
    });
    assert.equal(await run(["cards", "link", "ev-2", "Meetup Global", "https://www.meetup.com/datatalks-meetups-global/events/1/"], captureIo()), 0);
    assert.deepEqual(calls.at(-1).body.cardLinks, [
      { name: "Meetup", url: "" },
      { name: "Meetup Global", url: "https://www.meetup.com/datatalks-meetups-global/events/1/" },
    ]);
    const io = captureIo();
    assert.equal(await run(["cards", "link", "ev-2", "Meetup Mars", "https://example.test"], io), 2);
    assert.match(io.errors.join("\n"), /Known links: Meetup, Meetup Global/);
  });

  test("invite list prints the invites table", async () => {
    fakePortal({
      "GET /api/cards/card-1/calendar-invites": (call) => {
        assert.equal(call.query.verify, "1", "list checks the invites in Google");
        return {
          invites: [
            { eventId: "evt1", calendar: "alexey@datatalks.club", label: "original" },
            { eventId: "evt2", calendar: "alexey.s.grigoriev@gmail.com", staleAt: "2026-10-31T15:00:00.000Z" },
          ],
          check: { state: "verified", stale: [] },
        };
      },
    });
    const io = captureIo();
    const code = await run(["cards", "invite", "list", "card-1"], io);
    assert.equal(code, 0);
    assert.match(io.text(), /evt1/);
    assert.match(io.text(), /evt2 .*Alexey personal .*stale/);
  });

  test("invite list --json returns the invites", async () => {
    fakePortal({
      "GET /api/cards/card-9/calendar-invites": { invites: [] },
    });
    const io = captureIo();
    const code = await run(["cards", "invite", "list", "card-9", "--json"], io);
    assert.equal(code, 0);
    assert.deepEqual(io.json().invites, []);
  });
});
