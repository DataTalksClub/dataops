import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handler } from "../src/handler";
import { createTables, startLocal, stopLocal } from "../scripts/local-dynamodb";
import { getClient } from "../src/db/client";
import { setCalendarHoldGoogleDepsForTests } from "../src/routes/calendarHolds";
import { setDapierBrokerClientsForTests, DEFAULT_HOLD_GOOGLE_CALENDARS, resolveHoldGoogleCalendars } from "../src/calendar/dapierBroker";
import { getCalendarHold, putCalendarHold } from "../src/db/calendarHolds";
import { saveCalendarOverlaySettings } from "../src/db/calendar";
import {
  berlinOffsetSuffix,
  confirmHoldRecord,
  holdInterval,
  isHoldActive,
  proposalTitle,
  confirmedTitle,
  HOLD_ZOOM_LOCATION,
  HOLD_REQUIRED_ATTENDEES,
  HOLD_ATTENDEE_DENY_LIST,
  holdGuestAttendees,
  confirmedHoldDescription,
  confirmedHoldInvite,
} from "../src/calendar/holds";
import { suppressHeldSlots } from "../src/calendar/holdOverlay";

const invoke = (
  method: string,
  pathName: string,
  body?: unknown,
  query: Record<string, string> = {},
) =>
  handler({
    httpMethod: method,
    path: pathName,
    body: body === undefined ? null : JSON.stringify(body),
    headers: {},
    queryStringParameters: query,
  });
const parse = (r: any) => JSON.parse(r.body);

describe("calendar holds (web parity + tentative proposal + 7d TTL)", () => {
  let client: DynamoDBDocumentClient;
  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    await saveCalendarOverlaySettings(client, { connectionId: "google-calendar" }, "test-operator");
    // Holds resolve the Dapier machine token via Secrets Manager (no Coolify env).
    // Keep unit tests offline: pretend the secret is unreadable unless a test injects a credential.
    setDapierBrokerClientsForTests({
      secrets: {
        send: async () => {
          throw Object.assign(new Error('no aws in unit test'), { name: 'CredentialsProviderError' });
        },
      } as any,
    });
  });
  after(stopLocal);

  it("requires an explicit connection and explains a missing machine-agent use grant", async () => {
    let calls = 0;
    setCalendarHoldGoogleDepsForTests({ credential: "test-machine", fetchImpl: (async () => {
      calls += 1;
      return new Response('{}', { status: 403 });
    }) as typeof fetch });
    try {
      await saveCalendarOverlaySettings(client, { connectionId: "" }, "test");
      const missing = parse(await invoke("POST", "/api/calendar-holds", { date: "2026-11-12", title: "Unselected", topic: "Test" })).hold;
      assert.equal(missing.googleSync.state, "deferred");
      assert.match(missing.googleSync.reason, /No Dapier calendar connection selected/);
      assert.equal(calls, 0);
      await saveCalendarOverlaySettings(client, { connectionId: "selected-calendar" }, "test");
      const denied = parse(await invoke("POST", "/api/calendar-holds", { date: "2026-11-12", title: "Denied", topic: "Test" })).hold;
      assert.equal(denied.googleSync.state, "deferred");
      assert.match(denied.googleSync.reason, /selected-calendar/);
      assert.match(denied.googleSync.reason, /personal-scheduler/);
      assert.match(denied.googleSync.reason, /`use`/);
      assert.equal(calls, 1);
    } finally {
      setCalendarHoldGoogleDepsForTests({});
      await saveCalendarOverlaySettings(client, { connectionId: "google-calendar" }, "test");
    }
  });

  it("creates a tentative hold with defaults (60 min, evening, +7d TTL, Proposal title)", async () => {
    const r = await invoke("POST", "/api/calendar-holds", { date: "2026-10-26", title: "GraphRAG workshop", topic: "Adopting GraphRAG in production" });
    assert.equal(r.statusCode, 201, r.body);
    const { hold } = parse(r);
    assert.match(hold.id, /^hold_/);
    assert.equal(hold.status, "tentative");
    assert.equal(hold.topic, "Adopting GraphRAG in production");
    assert.equal(hold.durationMinutes, 60);
    assert.equal(hold.window, "evening");
    assert.equal(hold.timeZone, "Europe/Berlin");
    assert.equal(hold.googleTitle, "(Proposal) GraphRAG workshop");
    // Evening 60-min (podcast/webinar) starts 17:00 Berlin; 2026-10-26 is CET (+01:00).
    assert.equal(hold.startIso, "2026-10-26T16:00:00.000Z");
    assert.equal(hold.endIso, "2026-10-26T17:00:00.000Z");
    assert.equal(
      Date.parse(hold.expiresAt) - Date.parse(hold.proposedAt),
      7 * 86400000,
    );
    assert.equal(hold.googleSync.state, "deferred");
  });

  it("supports the workshop shape: 90 min evening via the web path", async () => {
    const r = await invoke("POST", "/api/calendar-holds", {
      date: "2026-10-27",
      window: "evening",
      duration: 90,
      title: "Evening workshop",
      topic: "Evening workshop topic",
    });
    assert.equal(r.statusCode, 201, r.body);
    const { hold } = parse(r);
    assert.equal(hold.durationMinutes, 90);
    // Workshop shape: 90-min evening starts 16:30 Berlin; 2026-10-27 is CET (+01:00).
    assert.equal(hold.startIso, "2026-10-27T15:30:00.000Z");
    assert.equal(hold.endIso, "2026-10-27T17:00:00.000Z");
    const detail = await invoke("GET", `/api/calendar-holds/${hold.id}`);
    assert.equal(detail.statusCode, 200);
    assert.equal(parse(detail).hold.window, "evening");
  });

  it("occupies the slot search: held windows read as busy in overlays", async () => {
    const created = parse(
      await invoke("POST", "/api/calendar-holds", { date: "2026-10-26", window: "midday", title: "Lunch recording", topic: "Lunch recording topic" }),
    ).hold;
    const overlays = parse(
      await invoke("GET", "/api/calendar-items/overlays", undefined, { from: "2026-10-26", to: "2026-10-26" }),
    );
    const holdItem = overlays.items.find((i: any) => i.id === `calendar-hold:${created.id}`);
    assert.ok(holdItem, "hold is projected as an overlay");
    assert.equal(holdItem.provider, "calendar-holds");
    assert.equal(holdItem.isAvailableSlot, false);
    assert.match(holdItem.label, /\(Proposal\) Lunch recording/);
    assert.ok(overlays.sources["calendar-holds"]);
    // A suppressed owner slot is never offered while the hold is active.
    const withSlot = suppressHeldSlots(
      [
        { provider: "owner-calendar", id: "owner-slot:2026-10-26:midday", startDate: "2026-10-26", endDate: "2026-10-26", label: "12:30 Available", slot: "midday", isAvailableSlot: true },
        { provider: "owner-calendar", id: "owner-slot:2026-10-26:evening", startDate: "2026-10-26", endDate: "2026-10-26", label: "17:00 Available", slot: "evening", isAvailableSlot: true },
      ] as any,
      [{ ...created, status: "tentative" }] as any,
    );
    assert.deepEqual(withSlot.map((i: any) => i.slot), ["evening"]);
  });

  it("confirms a hold: Proposal prefix drops, status confirmed", async () => {
    const created = parse(
      await invoke("POST", "/api/calendar-holds", { date: "2026-10-28", guestRef: "guest@example.com", title: "Confirm me", topic: "Confirm me topic" }),
    ).hold;
    const r = await invoke("POST", `/api/calendar-holds/${created.id}/confirm`);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(parse(r).hold.status, "confirmed");
    assert.equal(parse(r).hold.googleTitle, "Confirm me");
    assert.ok(parse(r).hold.confirmedAt);
    assert.equal((await invoke("POST", `/api/calendar-holds/${created.id}/confirm`)).statusCode, 200, "deferred Google invite can retry");
  });

  it("releases a hold: slot frees up, release recorded as manual", async () => {
    const created = parse(
      await invoke("POST", "/api/calendar-holds", { date: "2026-10-29", window: "midday", title: "Release me", topic: "Release me topic" }),
    ).hold;
    const r = await invoke("POST", `/api/calendar-holds/${created.id}/release`, { reason: "manual" });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(parse(r).hold.status, "released");
    assert.equal(parse(r).hold.releaseReason, "manual");
    const listed = parse(
      await invoke("GET", "/api/calendar-holds", undefined, { from: "2026-10-29", to: "2026-10-29", status: "released" }),
    );
    assert.ok(listed.holds.some((h: any) => h.id === created.id));
    const overlays = parse(
      await invoke("GET", "/api/calendar-items/overlays", undefined, { from: "2026-10-29", to: "2026-10-29" }),
    );
    assert.ok(!overlays.items.some((i: any) => i.id === `calendar-hold:${created.id}`));
  });

  it("expires tentative holds past TTL: released in DataOps, Orin follow-up, never a guest email", async () => {
    const created = parse(
      await invoke("POST", "/api/calendar-holds", { date: "2026-11-02", title: "Stale proposal", topic: "Stale proposal topic" }),
    ).hold;
    const stored = await getCalendarHold(client, created.id);
    assert.ok(stored);
    await putCalendarHold(client, { ...stored!, expiresAt: "2026-01-01T00:00:00.000Z" });
    const r = await invoke("POST", "/api/calendar-holds/expire");
    assert.equal(r.statusCode, 200, r.body);
    const { expired, followUps, note } = parse(r);
    const mine = expired.find((h: any) => h.id === created.id);
    assert.ok(mine);
    assert.equal(mine.status, "expired");
    assert.equal(mine.releaseReason, "expired");
    assert.equal(followUps.length, 1);
    assert.match(followUps[0].note, /Orin follow-up/i);
    assert.match(note + followUps[0].note, /no guest email/i);
  });


  it("confirm persists the fresh deferred reason when Google sync still fails", async () => {
    setCalendarHoldGoogleDepsForTests({});
    const created = parse(
      await invoke("POST", "/api/calendar-holds", { date: "2026-11-05", guestRef: "guest@example.com", title: "Still stuck", topic: "Still stuck topic" }),
    ).hold;
    const staleReason = created.googleSync.reason;
    const r = await invoke("POST", `/api/calendar-holds/${created.id}/confirm`);
    assert.equal(r.statusCode, 200, r.body);
    const { hold } = parse(r);
    assert.equal(hold.status, "confirmed");
    assert.equal(hold.googleSync.state, "deferred");
    assert.ok(hold.googleSync.reason, "deferred reason persisted on confirm");
    assert.notEqual(hold.googleSync.reason, "no mirrored Google events to update");
    const stored = await getCalendarHold(client, created.id);
    assert.equal(stored?.googleSync.state, "deferred");
    assert.equal(stored?.googleSync.reason, hold.googleSync.reason);
    assert.ok(!staleReason || stored?.googleSync.reason !== staleReason || staleReason.includes("broker"));
  });

  it("validates input and list filters", async () => {
    assert.equal((await invoke("POST", "/api/calendar-holds", { date: "not-a-date", title: "x", topic: "t" })).statusCode, 400);
    assert.equal((await invoke("POST", "/api/calendar-holds", { date: "2026-10-26", title: "", topic: "t" })).statusCode, 400);
    assert.equal((await invoke("POST", "/api/calendar-holds", { date: "2026-10-26", title: "x", topic: "t", window: "any" })).statusCode, 400);
    assert.equal((await invoke("POST", "/api/calendar-holds", { date: "2026-10-26", title: "x", topic: "t", duration: 0 })).statusCode, 400);
    assert.equal((await invoke("POST", "/api/calendar-holds", { date: "2026-10-26", title: "x" })).statusCode, 400);
    assert.equal((await invoke("POST", "/api/calendar-holds", { date: "2026-10-26", title: "x", topic: "" })).statusCode, 400);
    assert.equal((await invoke("POST", "/api/calendar-holds", { date: "2026-10-26", title: "x", topic: "t".repeat(301) })).statusCode, 400);
    assert.equal((await invoke("GET", "/api/calendar-holds/does-not-exist")).statusCode, 404);
    assert.equal((await invoke("GET", "/api/calendar-holds", undefined, { status: "bogus" })).statusCode, 400);
    assert.equal((await invoke("GET", "/api/calendar-holds", undefined, { from: "2026-10-30", to: "2026-10-01" })).statusCode, 400);
  });


  it("defaults Proposal mirrors to personal + DTC events calendars (SOP)", () => {
    assert.deepEqual(resolveHoldGoogleCalendars(undefined), [...DEFAULT_HOLD_GOOGLE_CALENDARS]);
    assert.ok(DEFAULT_HOLD_GOOGLE_CALENDARS.includes("alexey.s.grigoriev@gmail.com"));
    assert.ok(
      DEFAULT_HOLD_GOOGLE_CALENDARS.some((id) => id.includes("group.calendar.google.com")),
      "DTC events calendar id present",
    );
  });


  it("domain helpers: Berlin offsets, intervals, titles, transitions", () => {
    assert.equal(berlinOffsetSuffix("2026-10-20"), "+02:00");
    assert.equal(berlinOffsetSuffix("2026-10-26"), "+01:00");
    assert.equal(berlinOffsetSuffix("2026-01-15"), "+01:00");
    const evening90 = holdInterval("2026-10-27", "evening", 90);
    assert.equal(evening90.startLocal, "16:30");
    assert.equal(evening90.endLocal, "18:00");
    const evening60 = holdInterval("2026-10-26", "evening", 60);
    assert.equal(evening60.startLocal, "17:00");
    assert.equal(evening60.endLocal, "18:00");
    const midday60 = holdInterval("2026-10-26", "midday", 60);
    assert.equal(midday60.startLocal, "12:30");
    assert.equal(midday60.endLocal, "13:30");
    const midday90 = holdInterval("2026-10-26", "midday", 90);
    assert.equal(midday90.startLocal, "12:00");
    assert.equal(midday90.endLocal, "13:30");
    assert.equal(proposalTitle("Talk"), "(Proposal) Talk");
    assert.equal(proposalTitle("(Proposal) Talk"), "(Proposal) Talk");
    assert.equal(confirmedTitle("(Proposal) Talk"), "Talk");
    assert.ok(isHoldActive({ status: "tentative" }));
    assert.ok(!isHoldActive({ status: "expired" }));
    const bad: any = { status: "released", version: 2 };
    assert.throws(() => confirmHoldRecord(bad), /Only a tentative hold/);
  });

  it("guest invite rules: required attendees, deduped, deny-listed, Zoom in description", () => {
    assert.equal(HOLD_ZOOM_LOCATION, "https://zoom.us/j/94755324762");
    assert.deepEqual(holdGuestAttendees("sofiia@example.com"), [
      "sofiia@example.com",
      ...HOLD_REQUIRED_ATTENDEES,
    ]);
    // Case-insensitive dedup: a required address never repeats.
    assert.deepEqual(holdGuestAttendees("ALEXEY@DATATALKS.CLUB"), [...HOLD_REQUIRED_ATTENDEES]);
    // Invalid guest references are excluded; the confirm route rejects them.
    assert.deepEqual(holdGuestAttendees("not-an-email"), [...HOLD_REQUIRED_ATTENDEES]);
    assert.deepEqual(holdGuestAttendees(), [...HOLD_REQUIRED_ATTENDEES]);
    // Deny-list: valeriia is never added, not even as the guestRef.
    assert.deepEqual(holdGuestAttendees("valeriia@datatalks.club"), [...HOLD_REQUIRED_ATTENDEES]);
    assert.ok(!HOLD_REQUIRED_ATTENDEES.some((a) => HOLD_ATTENDEE_DENY_LIST.includes(a)));
    assert.match(confirmedHoldDescription(), /Zoom link:/);
    assert.ok(confirmedHoldDescription().includes("Zoom link: https://zoom.us/j/94755324762"));
  });

  it("invite window: start = slot start − 5 min, end = slot end (12:30–13:30 → 12:25–13:30)", () => {
    const midday = holdInterval("2026-11-16", "midday", 60); // 12:30–13:30 Berlin (CET, +01:00)
    assert.equal(midday.startIso, "2026-11-16T11:30:00.000Z");
    const invite = confirmedHoldInvite({
      id: "hold_window1",
      title: "(Proposal) Podcast recording",
      startIso: midday.startIso,
      endIso: midday.endIso,
    });
    assert.equal(invite.summary, "Podcast recording");
    assert.equal(invite.location, HOLD_ZOOM_LOCATION);
    assert.equal(invite.startIso, "2026-11-16T11:25:00.000Z");
    assert.equal(invite.endIso, "2026-11-16T12:30:00.000Z");
  });


});
