import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handler } from "../src/handler";
import { createTables, startLocal, stopLocal } from "../scripts/local-dynamodb";
import { getClient } from "../src/db/client";
import { setCalendarHoldGoogleDepsForTests } from "../src/routes/calendarHolds";
import { setDapierBrokerClientsForTests, DEFAULT_HOLD_GOOGLE_CALENDARS, resolveHoldGoogleCalendars } from "../src/calendar/dapierBroker";
import { createHoldGoogleEvents } from "../src/calendar/holdGoogleSync";
import { getCalendarHold, putCalendarHold } from "../src/db/calendarHolds";
import {
  berlinOffsetSuffix,
  confirmHoldRecord,
  holdInterval,
  isHoldActive,
  proposalTitle,
  confirmedTitle,
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
      await invoke("POST", "/api/calendar-holds", { date: "2026-10-28", title: "Confirm me", topic: "Confirm me topic" }),
    ).hold;
    const r = await invoke("POST", `/api/calendar-holds/${created.id}/confirm`);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(parse(r).hold.status, "confirmed");
    assert.equal(parse(r).hold.googleTitle, "Confirm me");
    assert.ok(parse(r).hold.confirmedAt);
    assert.equal((await invoke("POST", `/api/calendar-holds/${created.id}/confirm`)).statusCode, 409);
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

  it("mirrors Google Proposal create/confirm/release across DTC + personal calendars", async () => {
    const calls: Array<{ url: string; method: string; body?: any }> = [];
    const fakeJson = (payload: any, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });
    let seq = 0;
    setCalendarHoldGoogleDepsForTests({
      credential: "test-broker-token",
      calendarIds: ["dtc-events", "personal-alexey"],
      fetchImpl: (async (url: any, init: any) => {
        const u = String(url);
        const method = init?.method || "GET";
        calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (u.includes("/api/agent/token")) return fakeJson({ access_token: "google-at" });
        if (method === "POST" && u.includes("/calendar/v3/")) {
          seq += 1;
          return fakeJson({ id: `gev-${seq}` });
        }
        if (method === "PATCH") return fakeJson({ id: "gev-x" });
        if (method === "DELETE") return fakeJson({}, 204);
        throw new Error(`unexpected ${method} ${u}`);
      }) as any,
    });
    try {
      const created = parse(
        await invoke("POST", "/api/calendar-holds", { date: "2026-11-03", title: "Synced workshop", topic: "Synced workshop topic" }),
      ).hold;
      assert.deepEqual(created.googleEventIds, { "dtc-events": "gev-1", "personal-alexey": "gev-2" });
      assert.equal(created.googleSync.state, "synced");
      const creates = calls.filter((c) => c.method === "POST" && c.url.includes("/calendar/v3/"));
      assert.equal(creates.length, 2);
      assert.ok(creates.every((c) => c.body.summary === "(Proposal) Synced workshop"));
      calls.length = 0;
      const confirmed = parse(await invoke("POST", `/api/calendar-holds/${created.id}/confirm`)).hold;
      assert.equal(confirmed.googleTitle, "Synced workshop");
      const patches = calls.filter((c) => c.method === "PATCH");
      assert.equal(patches.length, 2);
      assert.ok(patches.every((c) => c.body.summary === "Synced workshop"));
      calls.length = 0;
      await invoke("POST", `/api/calendar-holds/${created.id}/release`, { reason: "manual" });
      assert.equal(calls.filter((c) => c.method === "DELETE").length, 2);
    } finally {
      setCalendarHoldGoogleDepsForTests({});
    }
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
    assert.ok(DEFAULT_HOLD_GOOGLE_CALENDARS.includes("primary"));
    assert.ok(
      DEFAULT_HOLD_GOOGLE_CALENDARS.some((id) => id.includes("group.calendar.google.com")),
      "DTC events calendar id present",
    );
  });

  it("reads the Dapier machine token from Secrets Manager (no Coolify env) and syncs both calendars", async () => {
    setDapierBrokerClientsForTests({
      secrets: {
        send: async () => ({ SecretString: JSON.stringify({ api_token: "dap_test_machine" }) }),
      } as any,
    });
    const calls: Array<{ url: string; method: string; auth?: string; body?: any }> = [];
    const fakeJson = (payload: any, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    });
    let seq = 0;
    try {
      const sync = await createHoldGoogleEvents(
        {
          summary: "(Proposal) SM hold",
          startIso: "2026-11-10T11:00:00.000Z",
          endIso: "2026-11-10T12:00:00.000Z",
          timeZone: "Europe/Berlin",
          description: "unit",
        },
        {
          fetchImpl: (async (url: any, init: any) => {
            const u = String(url);
            const method = init?.method || "GET";
            calls.push({
              url: u,
              method,
              auth: init?.headers?.Authorization,
              body: init?.body ? JSON.parse(String(init.body)) : undefined,
            });
            if (u.includes("/api/agent/token")) {
              assert.equal(init.headers.Authorization, "Bearer dap_test_machine");
              assert.deepEqual(JSON.parse(String(init.body)), {
                connection_id: "google-calendar",
                agent: "personal-scheduler",
              });
              return fakeJson({ access_token: "google-at" });
            }
            if (method === "POST" && u.includes("/calendar/v3/")) {
              seq += 1;
              return fakeJson({ id: `gev-sm-${seq}` });
            }
            throw new Error(`unexpected ${method} ${u}`);
          }) as any,
        },
      );
      assert.equal(sync.state, "synced");
      if (sync.state === "synced") {
        assert.equal(Object.keys(sync.eventIds).length, 2);
        assert.ok(sync.eventIds.primary);
        assert.ok(Object.keys(sync.eventIds).some((k) => k.includes("group.calendar.google.com")));
      }
      assert.equal(calls.filter((c) => c.url.includes("/api/agent/token")).length, 1);
      assert.equal(calls.filter((c) => c.method === "POST" && c.url.includes("/calendar/v3/")).length, 2);
    } finally {
      setDapierBrokerClientsForTests({
        secrets: {
          send: async () => {
            throw Object.assign(new Error("no aws in unit test"), { name: "CredentialsProviderError" });
          },
        } as any,
      });
    }
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
});
