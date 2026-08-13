import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert";
import fs from "fs/promises";
import path from "path";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handler } from "../src/handler";
import { createTables } from "../scripts/local-dynamodb";
import { getClient } from "../src/db/client";
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createSession } from "../src/db/sessions";
import {
  builtInHolidayGeneration,
  holidaySnapshot,
} from "../src/calendar/holidays";
import {
  persistHolidayGeneration,
  readHolidayGeneration,
  setHolidaySyncFailureForTests,
} from "../src/db/calendarHolidays";
import { createNewsletterSlot } from "../src/db/newsletterSlots";
const invoke = (
  method: string,
  pathName: string,
  body?: unknown,
  headers: Record<string, string> = {},
  query: Record<string, string> = {},
) =>
  handler(
    {
      httpMethod: method,
      path: pathName,
      body: body === undefined ? null : JSON.stringify(body),
      headers,
      queryStringParameters: query,
    },
    {},
  );
const parse = (r: any) => JSON.parse(r.body);
describe("operations calendar", () => {
  let client: DynamoDBDocumentClient;
  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
  });
  after(stopLocal);
  afterEach(() => {
    process.env.SKIP_AUTH = "true";
  });
  it("does not leak before auth and supports indexed CRUD, versions and idempotency", async () => {
    process.env.SKIP_AUTH = "false";
    assert.equal(
      (
        await invoke(
          "GET",
          "/api/calendar-items",
          undefined,
          {},
          { from: "2026-07-01", to: "2026-07-31" },
        )
      ).statusCode,
      401,
    );
    const session = await createSession(client, "calendar-operator"),
      auth = { authorization: `Bearer ${session.token}` },
      valid = {
        activityType: "webinar",
        title: "Synthetic planning event",
        status: "confirmed",
        allDay: true,
        startDate: "2026-07-20",
        endDate: "2026-08-02",
        sourceType: "synthetic",
        sourceKey: "calendar-test-one",
      };
    let r = await invoke("POST", "/api/calendar-items", valid, auth);
    assert.equal(r.statusCode, 201, r.body);
    const created = parse(r).item;
    assert.equal(
      (await invoke("POST", "/api/calendar-items", valid, auth)).statusCode,
      200,
    );
    r = await invoke("GET", "/api/calendar-items", undefined, auth, {
      from: "2026-08-01",
      to: "2026-08-31",
    });
    assert.equal(parse(r).items.length, 1);
    assert.ok(
      parse(r).alerts.some(
        (a: any) => a.reasonCode === "school-holiday-overlap",
      ),
    );
    r = await invoke(
      "PUT",
      `/api/calendar-items/${created.id}`,
      { version: created.version, title: "Updated synthetic event" },
      auth,
    );
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(
      (
        await invoke(
          "PUT",
          `/api/calendar-items/${created.id}`,
          { version: 1, title: "stale" },
          auth,
        )
      ).statusCode,
      409,
    );
    const updated = parse(r);
    assert.equal(
      (
        await invoke(
          "DELETE",
          `/api/calendar-items/${created.id}`,
          { version: updated.version },
          auth,
        )
      ).statusCode,
      204,
    );
    process.env.SKIP_AUTH = "true";
  });
  it("validates range, UTC offsets, filters, and holiday year edges", async () => {
    assert.equal(
      (
        await invoke(
          "GET",
          "/api/calendar-items",
          undefined,
          {},
          { from: "2020-01-01", to: "2026-01-01" },
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await invoke("POST", "/api/calendar-items", {
          activityType: "webinar",
          title: "DST gap",
          status: "tentative",
          allDay: false,
          startsAt: "2026-03-29T02:30:00",
          endsAt: "2026-03-29T03:30:00",
          timeZone: "Europe/Berlin",
        })
      ).statusCode,
      400,
    );
    assert.ok(
      holidaySnapshot("2028-06-17", "2028-06-17").some(
        (h) => h.startDate === "2028-06-17",
      ),
    );
    assert.ok(
      holidaySnapshot("2026-12-30", "2027-01-03").some(
        (h) => h.startDate === "2026-12-23" && h.endDate === "2027-01-02",
      ),
    );
  });
  it("publishes a persistent holiday generation atomically and retains LKG on refresh failure", async () => {
    let response = await invoke("POST", "/api/calendar-items/holidays/sync");
    assert.equal(response.statusCode, 200, response.body);
    const first = parse(response);
    response = await invoke(
      "GET",
      "/api/calendar-items",
      undefined,
      {},
      { from: "2028-06-01", to: "2028-06-30" },
    );
    const before = parse(response);
    assert.equal(before.holidayMetadata.generationId, first.generationId);
    assert.equal(before.holidayMetadata.persistent, true);
    assert.ok(
      before.holidays.some(
        (h: any) =>
          h.startDate === "2028-06-17" &&
          h.officialSourceUrl.startsWith("https://gesetze.berlin.de/"),
      ),
    );
    setHolidaySyncFailureForTests(2);
    response = await invoke("POST", "/api/calendar-items/holidays/sync");
    assert.equal(response.statusCode, 503);
    setHolidaySyncFailureForTests(null);
    response = await invoke(
      "GET",
      "/api/calendar-items",
      undefined,
      {},
      { from: "2028-06-01", to: "2028-06-30" },
    );
    assert.equal(
      parse(response).holidayMetadata.generationId,
      first.generationId,
    );
  });
  it("rejects incomplete statutory and school generations without moving the LKG pointer", async () => {
    const before = await readHolidayGeneration(client),
      complete = builtInHolidayGeneration(),
      withoutPublic = {
        ...complete,
        occurrences: complete.occurrences.filter(
          (h) => h.startDate !== "2028-06-17",
        ),
      };
    await assert.rejects(
      () => persistHolidayGeneration(client, withoutPublic),
      /incomplete|17 June/,
    );
    assert.equal(
      (await readHolidayGeneration(client))?.generationId,
      before?.generationId,
    );
    const school = complete.occurrences.find(
      (h) => h.kind === "berlin-school-holiday",
    )!;
    await assert.rejects(
      () =>
        persistHolidayGeneration(client, {
          ...complete,
          occurrences: complete.occurrences.filter((h) => h !== school),
        }),
      /incomplete/,
    );
    assert.equal(
      (await readHolidayGeneration(client))?.generationId,
      before?.generationId,
    );
  });
  it("projects newsletter records read-only and reopens changed dismissed alerts", async () => {
    await createNewsletterSlot(client, {
      publicationDate: "2027-04-05",
      campaignLabel: "Synthetic overlay",
      status: "open",
      sourceKey: "calendar-overlay-test",
    });
    let response = await invoke(
      "GET",
      "/api/calendar-items/overlays",
      undefined,
      {},
      { from: "2027-04-01", to: "2027-04-30" },
    );
    assert.ok(
      parse(response).items.some(
        (i: any) =>
          i.label === "Synthetic overlay" &&
          i.provider === "newsletter-slots-readonly",
      ),
    );
    response = await invoke("POST", "/api/calendar-items", {
      activityType: "webinar",
      title: "Dismissible synthetic",
      status: "tentative",
      allDay: true,
      startDate: "2027-04-05",
      endDate: "2027-04-05",
      timeZone: "Europe/Berlin",
      sourceKey: "dismiss-test",
    });
    const item = parse(response).item;
    response = await invoke(
      "GET",
      "/api/calendar-items",
      undefined,
      {},
      { from: "2027-04-01", to: "2027-04-30" },
    );
    const alert = parse(response).alerts.find(
      (a: any) =>
        a.reasonCode === "missing-workflow-context" &&
        a.affectedIds.includes(item.id),
    );
    assert.ok(alert);
    await invoke(
      "POST",
      `/api/calendar-items/alerts/${encodeURIComponent(alert.fingerprint)}/dismiss`,
    );
    response = await invoke(
      "GET",
      "/api/calendar-items",
      undefined,
      {},
      { from: "2027-04-01", to: "2027-04-30" },
    );
    assert.ok(
      !parse(response).alerts.some(
        (a: any) => a.fingerprint === alert.fingerprint,
      ),
    );
    await invoke("PUT", `/api/calendar-items/${item.id}`, {
      version: item.version,
      title: "Dismissible synthetic changed",
    });
    response = await invoke(
      "GET",
      "/api/calendar-items",
      undefined,
      {},
      { from: "2027-04-01", to: "2027-04-30" },
    );
    assert.ok(
      parse(response).alerts.some(
        (a: any) =>
          a.reasonCode === "missing-workflow-context" &&
          a.affectedIds.includes(item.id),
      ),
    );
  });
  it("ships week/month UI, independent layers, accessible status, and API seam", async () => {
    const frontend = path.resolve(__dirname, "../../frontend"),
      html = await fs.readFile(path.join(frontend, "index.html"), "utf8"),
      app = await fs.readFile(path.join(frontend, "src/surfaces/planning.js"), "utf8");
    assert.match(html, /data-workspace-view="calendar"/);
    assert.match(app, /Europe\/Berlin · Monday–Sunday/);
    assert.match(app, /ISO week/);
    for (const id of ["data-view", "data-type", "data-layer", "data-alerts", "data-calendar"])
      assert.ok(app.includes(id));
    assert.match(app, /\/api\/calendar-items/);
  });
});
