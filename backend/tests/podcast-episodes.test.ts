import { before, after, describe, it } from "node:test";
import assert from "node:assert";
import { PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handler } from "../src/handler";
import { createTables, startLocal, stopLocal } from "../scripts/local-dynamodb";
import { getClient } from "../src/db/client";
import { createCard, getCard } from "../src/db/cards";
import { createTemplate } from "../src/db/templates";
import { listTasksByCard } from "../src/db/tasks";
import { TABLE_CARDS, TABLE_PODCAST_EPISODES } from "../src/db/tableNames";
import { handlePodcastEpisodeRoutes } from "../src/routes/podcastEpisodes";

const invoke = (method: string, path: string, body?: unknown, query: Record<string, string> = {}) =>
  handler(
    { httpMethod: method, path, headers: {}, queryStringParameters: query, body: body === undefined ? null : JSON.stringify(body) },
    {},
  );
const data = (response: any) => JSON.parse(response.body);
const booked = {
  title: "Synthetic Systems Thinking",
  guests: [{ name: "Ada Example", slug: "adaexample" }],
  recordingDate: "2027-05-03",
  status: "booked",
};

describe("podcast episodes", () => {
  let client: DynamoDBDocumentClient;
  before(async () => {
    client = await getClient(await startLocal());
    await createTables(client);
  });
  after(stopLocal);

  it("creates, reads, filters, updates with versions, and deletes", async () => {
    const created = await invoke("POST", "/api/podcast-episodes", booked);
    assert.equal(created.statusCode, 201, created.body);
    const episode = data(created);
    assert.equal(episode.version, 1);
    const published = data(await invoke("POST", "/api/podcast-episodes", {
      season: 30,
      episode: 1,
      title: "Synthetic Published Episode",
      guests: [{ name: "Grace Sample" }],
      releaseDate: "2027-01-15",
      status: "published",
      publication: { spotify: { publicVerifiedAt: "2026-01-15T09:00:00Z", episodeUrl: "https://open.spotify.com/episode/synthetic" } },
      websiteSlug: "synthetic-published-episode",
      links: { youtube: "https://www.youtube.com/watch?v=synthetic" },
    }));

    const all = data(await invoke("GET", "/api/podcast-episodes"));
    assert.deepEqual(all.items.map((item: any) => item.id), [published.id, episode.id]);
    assert.equal(all.items[0].card, null);
    assert.deepEqual(
      data(await invoke("GET", "/api/podcast-episodes", undefined, { status: "booked" })).items.map((item: any) => item.id),
      [episode.id],
    );
    assert.deepEqual(
      data(await invoke("GET", "/api/podcast-episodes", undefined, { season: "30" })).items.map((item: any) => item.id),
      [published.id],
    );
    assert.deepEqual(
      data(await invoke("GET", "/api/podcast-episodes", undefined, { from: "2027-04-01", to: "2027-06-30" })).items.map((item: any) => item.id),
      [episode.id],
    );
    assert.equal((await invoke("GET", "/api/podcast-episodes", undefined, { status: "aired" })).statusCode, 400);
    assert.equal((await invoke("GET", "/api/podcast-episodes", undefined, { from: "2027-02-30" })).statusCode, 400);

    const updated = await invoke("PUT", `/api/podcast-episodes/${episode.id}`, { version: 1, status: "recorded", notes: "Synthetic note" });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(data(updated).status, "recorded");
    assert.equal(data(updated).title, booked.title);
    assert.equal((await invoke("PUT", `/api/podcast-episodes/${episode.id}`, { version: 1, status: "edited" })).statusCode, 409);
    const cleared = data(await invoke("PUT", `/api/podcast-episodes/${episode.id}`, { version: 2, notes: null }));
    assert.equal(cleared.notes, undefined);
    assert.equal(data(await invoke("GET", `/api/podcast-episodes/${episode.id}`)).version, 3);

    assert.equal((await invoke("DELETE", `/api/podcast-episodes/${episode.id}`, { version: 2 })).statusCode, 409);
    assert.equal((await invoke("DELETE", `/api/podcast-episodes/${episode.id}`, { version: 3 })).statusCode, 204);
    assert.equal((await invoke("GET", `/api/podcast-episodes/${episode.id}`)).statusCode, 404);
  });

  it("validates fields", async () => {
    const reject = async (body: Record<string, unknown>, message: RegExp) => {
      const response = await invoke("POST", "/api/podcast-episodes", { ...booked, ...body });
      assert.equal(response.statusCode, 400, response.body);
      assert.match(data(response).error, message);
    };
    await reject({ status: "aired" }, /status/);
    await reject({ season: 0 }, /season/);
    await reject({ recordingDate: "2027-13-01" }, /recordingDate/);
    await reject({ guests: [{ slug: "nameless" }] }, /guests/);
    await reject({ guests: [], title: undefined }, /title or at least one guest/);
    await reject({ links: { youtube: "http://insecure.example" } }, /link/);
    await reject({ links: { myspace: "https://example.com" } }, /link/);
    await reject({ websiteSlug: "Not A Slug" }, /websiteSlug/);
    await reject({ unexpected: true }, /Unknown field/);
    await reject({ version: 4 }, /system-owned/);
  });

  it("refuses duplicate website slugs, schedule rows, and episode numbers", async () => {
    const first = data(await invoke("POST", "/api/podcast-episodes", {
      ...booked,
      season: 31,
      episode: 2,
      websiteSlug: "synthetic-duplicate",
      scheduleSourceKey: "schedule-synthetic-1",
    }));
    for (const clash of [
      { websiteSlug: "synthetic-duplicate" },
      { scheduleSourceKey: "schedule-synthetic-1" },
      { season: 31, episode: 2 },
    ]) {
      const response = await invoke("POST", "/api/podcast-episodes", { ...booked, ...clash });
      assert.equal(response.statusCode, 409, JSON.stringify(clash));
    }
    const other = data(await invoke("POST", "/api/podcast-episodes", { ...booked, season: 31, episode: 3 }));
    assert.equal((await invoke("PUT", `/api/podcast-episodes/${other.id}`, { version: other.version, episode: 2 })).statusCode, 409);
    assert.equal((await invoke("PUT", `/api/podcast-episodes/${first.id}`, { version: first.version, episode: 2, title: "Same Number Kept" })).statusCode, 200);
  });

  it("links podcast Cards uniquely, pushes guests and dates, and creates Cards with rollback", async () => {
    const podcastTemplate = await createTemplate(client, {
      name: "Podcast",
      type: "podcast",
      taskDefinitions: [
        { refId: "prep", description: "Prepare questions", offsetDays: -2 },
        { refId: "record", description: "Record", offsetDays: 0 },
      ],
    });
    const newsletterCard = await createCard(client, { title: "[Newsletter] Weekly email #400(01MAR 2027) -Sponsor", anchorDate: "2027-03-01", stage: "preparation" });
    const podcastCard = await createCard(client, { title: "Synthetic topic", templateId: podcastTemplate.id, anchorDate: "2027-06-07", stage: "preparation" });
    const a = data(await invoke("POST", "/api/podcast-episodes", { ...booked, recordingDate: "2027-06-14" }));
    const b = data(await invoke("POST", "/api/podcast-episodes", { ...booked, recordingDate: "2027-06-21" }));
    assert.equal((await invoke("PUT", `/api/podcast-episodes/${a.id}`, { version: a.version, cardId: newsletterCard.id })).statusCode, 422);
    const linked = await invoke("PUT", `/api/podcast-episodes/${a.id}`, { version: a.version, cardId: podcastCard.id });
    assert.equal(linked.statusCode, 200, linked.body);
    assert.equal(data(linked).cardSync, "synced");
    let card = (await getCard(client, podcastCard.id))!;
    assert.equal(card.anchorDate, "2027-06-14");
    assert.deepEqual(card.people, ["Ada Example"]);
    // The Podcast Template authors no card_title, so the Card keeps its title.
    assert.equal(card.title, "Synthetic topic");
    assert.equal((await invoke("PUT", `/api/podcast-episodes/${b.id}`, { version: b.version, cardId: podcastCard.id })).statusCode, 409);
    const byCard = data(await invoke("GET", "/api/podcast-episodes", undefined, { cardId: podcastCard.id }));
    assert.deepEqual(byCard.items.map((item: any) => item.id), [a.id]);
    assert.equal(byCard.items[0].card.id, podcastCard.id);

    const moved = await invoke("PUT", `/api/podcast-episodes/${a.id}`, {
      version: data(linked).version,
      recordingDate: "2027-06-28",
      guests: [{ name: "Ada Example" }, { name: "Bo Placeholder" }],
    });
    assert.equal(moved.statusCode, 200, moved.body);
    card = (await getCard(client, podcastCard.id))!;
    assert.equal(card.anchorDate, "2027-06-28");
    assert.deepEqual(card.people, ["Ada Example", "Bo Placeholder"]);

    const created = await invoke("POST", `/api/podcast-episodes/${b.id}/card`, { version: b.version });
    assert.equal(created.statusCode, 201, created.body);
    const result = data(created);
    assert.equal(result.episode.cardId, result.card.id);
    const newCard = (await getCard(client, result.card.id))!;
    assert.equal(newCard.title, booked.title);
    assert.equal(newCard.anchorDate, "2027-06-21");
    assert.deepEqual(newCard.people, ["Ada Example"]);
    assert.equal((await listTasksByCard(client, newCard.id)).length, 2);
    assert.equal((await invoke("POST", `/api/podcast-episodes/${b.id}/card`, {})).statusCode, 409);

    const undated = data(await invoke("POST", "/api/podcast-episodes", { title: "Synthetic Undated", guests: [], status: "booked" }));
    assert.equal((await invoke("POST", `/api/podcast-episodes/${undated.id}/card`, {})).statusCode, 422);

    const doomed = data(await invoke("POST", "/api/podcast-episodes", { ...booked, title: "Synthetic Doomed Episode", recordingDate: "2027-07-05" }));
    const originalSend = client.send.bind(client);
    (client as any).send = (command: any) => {
      if (command instanceof PutCommand && command.input.TableName === TABLE_PODCAST_EPISODES && command.input.Item?.cardId)
        return Promise.reject(Object.assign(new Error("synthetic race"), { name: "ConditionalCheckFailedException" }));
      return originalSend(command);
    };
    let failed;
    try {
      failed = await handlePodcastEpisodeRoutes(
        `/api/podcast-episodes/${doomed.id}/card`,
        "POST",
        { httpMethod: "POST", path: `/api/podcast-episodes/${doomed.id}/card`, headers: {}, queryStringParameters: {}, body: "{}" },
        client,
      );
    } finally {
      (client as any).send = originalSend;
    }
    assert.equal(failed.statusCode, 409, failed.body);
    const leftovers = await client.send(new ScanCommand({ TableName: TABLE_CARDS, FilterExpression: "title = :title", ExpressionAttributeValues: { ":title": "Synthetic Doomed Episode" } }));
    assert.equal(leftovers.Items?.length, 0);
  });
});
