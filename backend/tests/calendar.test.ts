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
import { buildNewsletterIssue, issueItem, createNewsletterIssue } from "../src/db/newsletterIssues";
import { TABLE_NEWSLETTER_SLOTS } from "../src/db/tableNames";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { newsletterOverlayItem } from "../src/calendar/newsletterOverlay";
import { createTemplate } from "../src/db/templates";
import { createPodcastEpisode } from "../src/db/podcastEpisodes";
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
  it("does not leak before auth and projects event cards and podcast episodes, each linked to its entity", async () => {
    process.env.SKIP_AUTH = "false";
    assert.equal(
      (await invoke("GET", "/api/calendar-items", undefined, {}, { from: "2030-05-01", to: "2030-05-31" })).statusCode,
      401,
    );
    const session = await createSession(client, "calendar-operator"),
      auth = { authorization: `Bearer ${session.token}` };
    process.env.SKIP_AUTH = "true";
    const webinar = await createTemplate(client, { name: "Webinar", type: "webinar", taskDefinitions: [] });
    const newsletter = await createTemplate(client, { name: "Newsletter", type: "newsletter", taskDefinitions: [] });
    const podcast = await createTemplate(client, { name: "Podcast", type: "podcast", taskDefinitions: [] });
    const card = async (templateId: string, title: string, anchorDate: string, people?: string[]) =>
      parse(await invoke("POST", "/api/cards", { templateId, title, anchorDate, ...(people ? { people } : {}) })).card;
    const event = await card(webinar.id, "Synthetic GraphRAG talk", "2030-05-30", ["Ada Example"]);
    await card(newsletter.id, "Synthetic weekly issue", "2030-05-10");
    await card(podcast.id, "Synthetic podcast card", "2030-05-11");
    const episode = await createPodcastEpisode(client, {
      title: "Synthetic Episode", guests: [{ name: "Grace Sample" }], status: "booked",
      recordingDate: "2030-05-11", releaseDate: "2030-05-25",
    });
    await createPodcastEpisode(client, {
      title: "Synthetic Cancelled", guests: [{ name: "Gone Guest" }], status: "cancelled", recordingDate: "2030-05-12",
    });
    process.env.SKIP_AUTH = "false";
    const r = await invoke("GET", "/api/calendar-items", undefined, auth, { from: "2030-05-01", to: "2030-05-31" });
    assert.equal(r.statusCode, 200, r.body);
    // Only the event Card and the episode's two dates: newsletter and podcast
    // Cards show through their issue and episode, a cancelled episode not at all.
    assert.deepEqual(parse(r).items, [
      {
        id: `podcast-recording:${episode.id}`, kind: "podcast-recording", kindLabel: "Podcast recording",
        title: "Synthetic Episode · Grace Sample", date: "2030-05-11", status: "booked",
        entity: { type: "podcast-episode", id: episode.id }, href: `/podcast?episodeId=${episode.id}`,
      },
      {
        id: `podcast-release:${episode.id}`, kind: "podcast-release", kindLabel: "Podcast release",
        title: "Synthetic Episode · Grace Sample", date: "2030-05-25", status: "booked",
        entity: { type: "podcast-episode", id: episode.id }, href: `/podcast?episodeId=${episode.id}`,
      },
      {
        id: `card:${event.id}`, kind: "webinar", kindLabel: "Webinar", title: "Synthetic GraphRAG talk · Ada Example",
        date: "2030-05-30", status: "preparation", entity: { type: "card", id: event.id }, href: `/cards?cardId=${event.id}`,
      },
    ]);
    // Ascension Day: the upcoming webinar is flagged.
    assert.ok(parse(r).alerts.some((a: any) => a.reasonCode === "public-holiday-overlap" && a.affectedIds.includes(`card:${event.id}`)));
    // The calendar stores nothing: there is no create, edit or delete.
    assert.equal((await invoke("POST", "/api/calendar-items", { title: "Standalone" }, auth)).statusCode, 405);
    assert.equal((await invoke("PUT", `/api/calendar-items/card:${event.id}`, {}, auth)).statusCode, 404);
    process.env.SKIP_AUTH = "true";
  });
  it("validates the range and holiday year edges", async () => {
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
  it("shows a weekly issue with primary and secondary slots as one calendar item", async () => {
    const issue = buildNewsletterIssue({
      kind: "weekly",
      publicationDate: "2027-04-12",
      issueNumber: 402,
      status: "planned",
      slots: { primary: { sponsor: "Synthetic Alpha" }, secondary: {} },
      cardId: "calendar-one-item-card",
    }, "calendar-one-item-test");
    await client.send(new PutCommand({ TableName: TABLE_NEWSLETTER_SLOTS, Item: issueItem(issue) }));
    const response = await invoke("GET", "/api/calendar-items/overlays", undefined, {}, { from: "2027-04-12", to: "2027-04-12" });
    const items = parse(response).items.filter((i: any) => i.provider === "newsletter-issues-readonly");
    assert.equal(items.length, 1);
    assert.equal(items[0].label, "Weekly #402 · Synthetic Alpha");
    assert.equal(items[0].isAvailableSlot, true);
    const booked = newsletterOverlayItem({ ...issue, slots: { ...issue.slots, secondary: { sponsor: "Synthetic Beta" } } });
    assert.equal(booked.label, "Weekly #402 · Synthetic Alpha + Synthetic Beta");
    assert.equal(booked.isAvailableSlot, false);
  });
  it("projects newsletter records read-only and reopens changed dismissed alerts", async () => {
    await createNewsletterIssue(client, buildNewsletterIssue({
      kind: "weekly",
      publicationDate: "2027-04-05",
      issueNumber: 401,
      status: "cancelled",
      slots: { primary: {}, secondary: {} },
    }, "calendar-overlay-test"));
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
          i.label === "Weekly #401" &&
          i.provider === "newsletter-issues-readonly",
      ),
    );
    assert.deepEqual(parse(response).sources["newsletter-issues-readonly"], { state: "connected" });
    assert.ok(parse(response).sources["owner-calendar"].state);
    // A past range still shows newsletter issues but never reads the owner's calendar.
    response = await invoke("GET", "/api/calendar-items/overlays", undefined, {}, { from: "2020-01-01", to: "2020-01-31" });
    assert.deepEqual(Object.keys(parse(response).sources), ["newsletter-issues-readonly"]);
    assert.ok(!parse(response).items.some((i: any) => i.isAvailableSlot && i.provider === "owner-calendar"));
    const template = await createTemplate(client, { name: "Workshop", type: "workshop", taskDefinitions: [] });
    // Whit Monday 2030, a Berlin public holiday.
    const card = parse(await invoke("POST", "/api/cards", { templateId: template.id, title: "Dismissible synthetic", anchorDate: "2030-06-10" })).card;
    const alerts = async () => parse(await invoke("GET", "/api/calendar-items", undefined, {}, { from: "2030-06-01", to: "2030-12-31" })).alerts
      .filter((a: any) => a.affectedIds.includes(`card:${card.id}`));
    const [alert] = await alerts();
    assert.equal(alert.reasonCode, "public-holiday-overlap");
    await invoke("POST", `/api/calendar-items/alerts/${encodeURIComponent(alert.fingerprint)}/dismiss`);
    assert.deepEqual(await alerts(), []);
    // Moving the card onto Christmas raises the alert again.
    const moved = await invoke("PUT", `/api/cards/${card.id}`, { expectedVersion: card.version, anchorDate: "2030-12-25" });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.equal((await alerts()).length, 1);
  });
  it("ships week/month UI, independent layers, accessible status, and API seam", async () => {
    const frontend = path.resolve(__dirname, "../../frontend"),
      html = await fs.readFile(path.join(frontend, "index.html"), "utf8"),
      app = await fs.readFile(path.join(frontend, "src/surfaces/planning.js"), "utf8");
    assert.match(html, /data-workspace-view="calendar"/);
    assert.match(app, /Europe\/Berlin/);
    assert.match(app, /iso-week/);
    for (const id of ["data-view", "data-type", "data-layer", "data-alerts", "data-calendar"])
      assert.ok(app.includes(id));
    assert.match(app, /\/api\/calendar-items/);
  });
  it("exposes GET and PUT /api/calendar-items/settings for overlay configuration", async () => {
    let response = await invoke("GET", "/api/calendar-items/settings");
    assert.equal(response.statusCode, 200);
    const initial = parse(response);
    assert.ok(initial.settings);
    assert.equal(initial.settings.connectionId, "google-calendar");
    assert.equal(initial.settings.filterLunch, true);
    assert.ok(Array.isArray(initial.connections));

    response = await invoke("PUT", "/api/calendar-items/settings", {
      connectionId: "work-calendar",
      filterLunch: false,
      filterBusy: true,
      customKeywords: ["dentist", "haircut"],
    });
    assert.equal(response.statusCode, 200);
    const updated = parse(response).settings;
    assert.equal(updated.connectionId, "work-calendar");
    assert.equal(updated.filterLunch, false);
    assert.equal(updated.filterBusy, true);
    assert.deepEqual(updated.customKeywords, ["dentist", "haircut"]);

    response = await invoke("GET", "/api/calendar-items/settings");
    assert.equal(response.statusCode, 200);
    const persisted = parse(response).settings;
    assert.equal(persisted.connectionId, "work-calendar");
    assert.equal(persisted.filterLunch, false);
    assert.equal(persisted.filterBusy, true);
    assert.deepEqual(persisted.customKeywords, ["dentist", "haircut"]);
  });
});
