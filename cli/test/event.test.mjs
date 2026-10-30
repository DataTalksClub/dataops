import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const realFetch = globalThis.fetch;
const { run } = await import("../src/cli.mjs");

afterEach(() => {
  globalThis.fetch = realFetch;
});

function sampleLifecycleResponse(overrides = {}) {
  const status = overrides.status || "proposed";
  const date = overrides.date || "2026-11-18";
  const time = overrides.time || "12:30";
  return {
    event: {
      id: "hold_card-1",
      cardId: "card-1",
      templateId: "podcast-template",
      templateVersion: 1,
      version: 1,
      generation: 1,
      identityGeneration: 1,
      status,
      date,
      time,
      timeZone: "Europe/Berlin",
      startIso: `${date}T11:30:00.000Z`,
      endIso: `${date}T12:30:00.000Z`,
      durationMinutes: 60,
      guestEmails: ["guest@example.invalid"],
      googleEventIds: { "orin@datatalks.club": "gev_1" },
      renderValues: { title: "Agentic Data Stack" },
      ...overrides.event,
    },
    hold: {
      id: "hold_card-1",
      cardId: "card-1",
      status: status === "approved" ? "confirmed" : status === "proposed" ? "tentative" : "released",
      lifecycleStatus: status,
      date,
      time,
      window: "midday",
      durationMinutes: 60,
      title: "Agentic Data Stack",
      googleTitle:
        status === "approved"
          ? "Podcast: Agentic Data Stack"
          : "(Proposal) Podcast: Agentic Data Stack",
      googleSync: { state: "synced" },
      ...overrides.hold,
    },
    history: overrides.history || [
      {
        transition: "propose",
        generation: 1,
        operationKey: "op-1",
        at: "2026-10-30T12:00:00.000Z",
        actor: "test-operator",
      },
    ],
    sync: overrides.sync || { state: "synced", eventIds: { "orin@datatalks.club": "gev_1" } },
    emailReceipts: {},
  };
}

describe("Unified Event Lifecycle CLI (AC2)", () => {
  test("event propose -> approve -> reschedule -> release -> show -> retry -> poll hit unified /api/events endpoints", async () => {
    const calls = fakePortal({
      "POST /api/events/card-1/propose": ({ body }) => ({
        status: 201,
        body: sampleLifecycleResponse({ status: "proposed", date: body.date, time: body.time || "12:30" }),
      }),
      "POST /api/events/card-1/approve": () => ({
        status: 200,
        body: sampleLifecycleResponse({ status: "approved" }),
      }),
      "POST /api/events/card-1/reschedule": ({ body }) => ({
        status: 200,
        body: sampleLifecycleResponse({ status: "proposed", date: body.date, time: body.time || "17:00" }),
      }),
      "POST /api/events/card-1/release": () => ({
        status: 200,
        body: sampleLifecycleResponse({ status: "released" }),
      }),
      "GET /api/events/card-1": () => ({
        status: 200,
        body: sampleLifecycleResponse({
          status: "approved",
          history: [
            {
              transition: "approve",
              generation: 1,
              operationKey: "calendar-accept-hold_card-1-gen-1",
              at: "2026-10-30T12:05:00.000Z",
              actor: "calendar-accept:guest@example.invalid",
              note: "approved via calendar accept",
              attendeeEmail: "guest@example.invalid",
            },
          ],
        }),
      }),
      "POST /api/events/card-1/retry": () => ({
        status: 200,
        body: sampleLifecycleResponse({ status: "proposed" }),
      }),
      "POST /api/events/poll": () => ({
        status: 200,
        body: {
          checked: 1,
          outcomes: [
            {
              holdId: "hold_card-1",
              cardId: "card-1",
              status: "approved",
              action: "approved",
              acceptedEmails: ["guest@example.invalid"],
            },
          ],
        },
      }),
    });

    const ioPropose = captureIo();
    assert.equal(
      await run(
        [
          "event",
          "propose",
          "card-1",
          "--date",
          "2026-11-18",
          "--time",
          "12:30",
          "--guest-emails",
          "guest@example.invalid",
        ],
        ioPropose,
      ),
      0,
    );
    assert.match(ioPropose.text(), /Proposed event hold_card-1.*\[proposed\] 2026-11-18 12:30/);
    assert.deepEqual(calls[0].body, {
      date: "2026-11-18",
      time: "12:30",
      guestEmails: ["guest@example.invalid"],
    });

    const ioApprove = captureIo();
    assert.equal(await run(["event", "approve", "card-1"], ioApprove), 0);
    assert.match(ioApprove.text(), /Approved event hold_card-1.*\[approved\]/);

    const ioResched = captureIo();
    assert.equal(
      await run(["event", "reschedule", "card-1", "--date", "2026-11-25", "--window", "evening"], ioResched),
      0,
    );
    assert.match(ioResched.text(), /Rescheduled event hold_card-1.*\[proposed\] 2026-11-25/);
    assert.deepEqual(calls[2].body, { date: "2026-11-25", window: "evening" });

    const ioRelease = captureIo();
    assert.equal(await run(["event", "release", "card-1"], ioRelease), 0);
    assert.match(ioRelease.text(), /Released event hold_card-1.*\[released\]/);

    const ioShow = captureIo();
    assert.equal(await run(["event", "show", "card-1"], ioShow), 0);
    assert.match(ioShow.text(), /approved via calendar accept \(guest@example\.invalid\)/);

    const ioRetry = captureIo();
    assert.equal(await run(["event", "retry", "card-1", "--force-email-retry"], ioRetry), 0);
    assert.deepEqual(calls[5].body, { forceEmailRetry: true });

    const ioPoll = captureIo();
    assert.equal(await run(["event", "poll"], ioPoll), 0);
    assert.match(ioPoll.text(), /hold_card-1.*-> approved accepted: guest@example\.invalid/);
  });

  test("podcast reschedule and calendar move-hold delegate to unified reschedule/move endpoints", async () => {
    const calls = fakePortal({
      "POST /api/events/ep-1/reschedule": ({ body }) => ({
        status: 200,
        body: sampleLifecycleResponse({ status: "proposed", date: body.date, time: "12:30" }),
      }),
      "POST /api/calendar-holds/hold_1/move": ({ body }) => ({
        status: 200,
        body: {
          hold: {
            id: "hold_1",
            date: body.date,
            window: body.window || "midday",
            durationMinutes: 60,
            title: "Podcast",
            status: "tentative",
          },
        },
      }),
    });

    const ioPod = captureIo();
    assert.equal(
      await run(["podcast", "reschedule", "ep-1", "--date", "2026-12-02", "--window", "midday"], ioPod),
      0,
    );
    assert.match(ioPod.text(), /Rescheduled event hold_card-1.*2026-12-02/);
    assert.deepEqual(calls[0].body, { date: "2026-12-02", window: "midday" });

    const ioCal = captureIo();
    assert.equal(
      await run(["calendar", "move-hold", "hold_1", "--date", "2026-12-03", "--window", "evening"], ioCal),
      0,
    );
    assert.match(ioCal.text(), /Moved hold hold_1: 2026-12-03/);
    assert.deepEqual(calls[1].body, { date: "2026-12-03", window: "evening" });
  });
});
