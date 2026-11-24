import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const realFetch = globalThis.fetch;
const { run } = await import("../src/cli.mjs");

afterEach(() => {
  globalThis.fetch = realFetch;
});

const PUBLIC = "f8qidjnq0jhscp8809k1eghs60@group.calendar.google.com";
const LISTING = {
  eventKey: "card:card-1",
  googleEventIds: {
    [PUBLIC]: "public-entry",
    "orin@datatalks.club": "silent-copy",
    "alexey.s.grigoriev@gmail.com": "silent-copy",
  },
};

function plannedResponse() {
  return {
    status: 200,
    body: {
      dryRun: true,
      listing: LISTING,
      event: {
        id: "hold_card-1",
        cardId: "card-1",
        status: "proposed",
        date: "2026-11-24",
        time: "17:00",
        timeZone: "Europe/Berlin",
        startIso: "2026-11-24T16:00:00.000Z",
        endIso: "2026-11-24T17:00:00.000Z",
        operations: [
          {
            key: "propose-hold_card-1-v0-1",
            state: "pending",
            desired: {
              summary: "[Proposed] Live Q&A",
              startIso: "2026-11-24T15:55:00.000Z",
              endIso: "2026-11-24T17:00:00.000Z",
              timeZone: "Europe/Berlin",
              location: "https://zoom.us/j/94755324762",
              attendees: [
                "speaker@example.invalid",
                "alexey.s.grigoriev@gmail.com",
                "alexey@datatalks.club",
              ],
              sendUpdates: "all",
              emails: [],
            },
          },
        ],
      },
      hold: { googleTitle: "[Proposed] Live Q&A" },
      sync: { state: "deferred", reason: "Dry run: nothing was written to the Card, Google Calendar or email." },
    },
  };
}

describe("event propose beside a silent Luma listing", () => {
  test("--dry-run sends dryRun and prints the plan, the untouched listing and that nothing was written", async () => {
    const calls = fakePortal({ "POST /api/events/card-1/propose": plannedResponse });
    const io = captureIo();
    const code = await run(
      ["event", "propose", "card-1", "--date", "2026-11-24", "--time", "17:00", "--guest-emails", "speaker@example.invalid", "--dry-run"],
      io,
    );
    assert.equal(code, 0);
    assert.deepEqual(calls[0].body, {
      date: "2026-11-24",
      time: "17:00",
      guestEmails: ["speaker@example.invalid"],
      dryRun: true,
    });
    const text = io.text();
    assert.match(text, /Dry run — would propose event hold_card-1.*\[proposed\] 2026-11-24 17:00 Europe\/Berlin/);
    assert.match(text, /Nothing was written to the Card, Google Calendar or email\./);
    assert.match(text, /Invitation window: 2026-11-24T15:55:00\.000Z \.\. 2026-11-24T17:00:00\.000Z \(Europe\/Berlin\) at https:\/\/zoom\.us\/j\/94755324762/);
    assert.match(text, /Attendees: speaker@example\.invalid, alexey\.s\.grigoriev@gmail\.com, alexey@datatalks\.club/);
    assert.match(text, /Google calendar updates: invitations are sent/);
    assert.match(text, /Emails: 0/);
    assert.match(text, /Kept live and untouched beside the invitation \(card:card-1\)/);
    assert.match(text, new RegExp(`${PUBLIC}: public-entry`));
    assert.match(text, /orin@datatalks\.club: silent-copy/);
    assert.doesNotMatch(text, /Google sync deferred|Proposed event/);

    const json = captureIo();
    assert.equal(await run(["event", "propose", "card-1", "--date", "2026-11-24", "--dry-run", "--json"], json), 0);
    assert.equal(json.json().dryRun, true);
    assert.deepEqual(json.json().listing, LISTING);
  });

  test("without --dry-run the propose is real and sends no dryRun flag", async () => {
    const calls = fakePortal({
      "POST /api/events/card-1/propose": () => ({
        status: 201,
        body: { ...plannedResponse().body, dryRun: undefined, listing: undefined, sync: { state: "synced", eventIds: { "orin@datatalks.club": "gev_1" } } },
      }),
    });
    const io = captureIo();
    assert.equal(await run(["event", "propose", "card-1", "--date", "2026-11-24", "--time", "17:00"], io), 0);
    assert.equal("dryRun" in calls[0].body, false);
    assert.match(io.text(), /Proposed event hold_card-1/);
    assert.doesNotMatch(io.text(), /Dry run/);
  });

  test("--dry-run with a value is a usage error; nothing is sent", async () => {
    const calls = fakePortal({});
    const io = captureIo();
    assert.equal(await run(["event", "propose", "card-1", "--date", "2026-11-24", "--dry-run=false"], io), 2);
    assert.match(io.errors.join("\n"), /--dry-run is a boolean flag/);
    assert.equal(calls.length, 0);
  });

  test("event show on a Card without an invitation answers with the listing and the next step", async () => {
    const calls = fakePortal({
      "GET /api/events/card-1": () => ({
        status: 200,
        body: { event: null, hold: null, history: [], card: { id: "card-1" }, listing: LISTING, nextStep: "No private invitation exists for Card 'card-1'. Create one with: dataops event propose card-1 --date YYYY-MM-DD" },
      }),
    });
    const io = captureIo();
    assert.equal(await run(["event", "show", "card-1"], io), 0);
    assert.equal(calls.length, 1);
    const text = io.text();
    assert.match(text, /invitation:\s+none/);
    assert.match(text, /listing:\s+3 attendee-free entries \(card:card-1\)/);
    assert.match(text, /next step:\s+No private invitation exists for Card 'card-1'/);
    assert.match(text, /dataops event propose card-1 --date YYYY-MM-DD/);
  });

  test("a real conflict stays visible: the server's reason is printed with the conflict exit code", async () => {
    fakePortal({
      "POST /api/events/card-1/propose": () => ({
        status: 409,
        body: { error: "Card 'card-1' already has an active event (hold_card-1, status=approved). Use reschedule to change its date/time.", code: "event_conflict" },
      }),
    });
    const io = captureIo();
    assert.equal(await run(["event", "propose", "card-1", "--date", "2026-11-24", "--dry-run"], io), 5);
    assert.match(io.errors.join("\n"), /error: Card 'card-1' already has an active event \(hold_card-1, status=approved\)/);

    const json = captureIo();
    assert.equal(await run(["event", "propose", "card-1", "--date", "2026-11-24", "--json"], json), 5);
    // Machine-readable failures are printed on the error stream.
    const { error: payload } = JSON.parse(json.errors.join("\n"));
    assert.deepEqual(
      { status: payload.status, code: payload.code, exitCode: payload.exitCode },
      { status: 409, code: "event_conflict", exitCode: 5 },
    );
  });
});
