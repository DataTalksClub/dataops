import { before, after, describe, it } from "node:test";
import assert from "node:assert";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handler } from "../src/handler";
import { createTables, startLocal, stopLocal } from "../scripts/local-dynamodb";
import { getClient } from "../src/db/client";

const invoke = (
  method: string,
  path: string,
  body?: unknown,
  queryStringParameters: Record<string, string> = {},
) =>
  handler(
    {
      httpMethod: method,
      path,
      headers: {},
      queryStringParameters,
      body: body === undefined ? null : JSON.stringify(body),
    },
    {},
  );
const data = (response: any) => JSON.parse(response.body);

describe("past events archive register", () => {
  let client: DynamoDBDocumentClient;
  before(async () => {
    client = await getClient(await startLocal());
    await createTables(client);
  });
  after(stopLocal);

  it("creates, reads by id/slug/luma, filters by course and date, updates with versions, and deletes", async () => {
    const created = await invoke("POST", "/api/event-records", {
      title: "Deploying ML Models with FastAPI and uv",
      slug: "2025-08-11-deploying-ml-models-with-fastapi-and-uv",
      date: "2025-08-11",
      time: "17:00 Europe/Berlin",
      type: "Workshop",
      course: "ML Zoomcamp, Module 5",
      lumaUrl: "https://lu.ma/f8rmlsmh",
      recordingUrl: "https://www.youtube.com/watch?v=synthetic1",
      speakers: ["Alexey Grigorev"],
      description: "## About Event\n\nHands-on workshop on FastAPI and uv.",
      registrations: 210,
    });
    assert.equal(created.statusCode, 201, created.body);
    const createdBody = data(created);
    assert.equal(createdBody.version, 1);
    assert.equal(createdBody.course, "ML Zoomcamp");
    assert.equal(createdBody.series, "ml-zoomcamp");
    assert.equal(createdBody.module, "Module 5");
    assert.deepEqual(createdBody.speakers, ["Alexey Grigorev"]);
    assert.equal(createdBody.recordingUrl, "https://www.youtube.com/watch?v=synthetic1");

    // Read by UUID, slug, and Luma short code
    const byId = data(await invoke("GET", `/api/event-records/${createdBody.id}`));
    assert.equal(byId.title, "Deploying ML Models with FastAPI and uv");
    const bySlug = data(
      await invoke("GET", "/api/event-records/2025-08-11-deploying-ml-models-with-fastapi-and-uv"),
    );
    assert.equal(bySlug.id, createdBody.id);
    const byLumaCode = data(await invoke("GET", "/api/event-records/f8rmlsmh"));
    assert.equal(byLumaCode.id, createdBody.id);
    assert.equal((await invoke("GET", "/api/event-records/nonexistent")).statusCode, 404);

    // Create a second event in another course/date
    const second = await invoke("POST", "/api/event-records", {
      title: "Analytics Engineering with dbt Workshop",
      slug: "2026-01-27-analytics-engineering-with-dbt-workshop",
      date: "2026-01-27",
      type: "Workshop",
      course: "DE Zoomcamp",
      lumaUrl: "https://luma.com/dbt2026",
      speakers: ["Juan Manuel Perafan"],
      descriptionMarkdown: "## About Event\n\ndbt workshop description.",
    });
    assert.equal(second.statusCode, 201, second.body);

    // Filter by course (display name and slug) and date
    const all = data(await invoke("GET", "/api/event-records"));
    assert.equal(all.items.length, 2);
    assert.equal(all.items[0].date, "2026-01-27");

    const mlBySlug = data(
      await invoke("GET", "/api/event-records", undefined, { course: "ml-zoomcamp" }),
    );
    assert.equal(mlBySlug.items.length, 1);
    assert.equal(mlBySlug.items[0].id, createdBody.id);

    const deByFullName = data(
      await invoke("GET", "/api/event-records", undefined, {
        course: "Data Engineering Zoomcamp",
      }),
    );
    assert.equal(deByFullName.items.length, 1);
    assert.equal(deByFullName.items[0].title, "Analytics Engineering with dbt Workshop");

    const byDateExact = data(
      await invoke("GET", "/api/event-records", undefined, { date: "2025-08-11" }),
    );
    assert.equal(byDateExact.items.length, 1);
    assert.equal(byDateExact.items[0].id, createdBody.id);

    const byDateYear = data(
      await invoke("GET", "/api/event-records", undefined, { date: "2026" }),
    );
    assert.equal(byDateYear.items.length, 1);
    assert.equal(byDateYear.items[0].date, "2026-01-27");

    // Duplicate slug or lumaUrl rejected with 409
    assert.equal(
      (
        await invoke("POST", "/api/event-records", {
          title: "Duplicate Luma",
          date: "2025-08-11",
          lumaUrl: "https://luma.com/f8rmlsmh",
          speakers: ["Alexey Grigorev"],
          description: "Duplicate",
        })
      ).statusCode,
      409,
    );

    // Validation errors
    for (const [badBody, pattern] of [
      [{ date: "2025-08-11", speakers: ["A"], description: "x" }, /title/],
      [{ title: "T", date: "2025-13-40", speakers: ["A"], description: "x" }, /date/],
      [{ title: "T", date: "2025-08-11", lumaUrl: "http://lu.ma/x", speakers: ["A"], description: "x" }, /lumaUrl/],
      [{ title: "T", date: "2025-08-11", recordingUrl: "not-a-url", speakers: ["A"], description: "x" }, /recordingUrl/],
    ] as Array<[Record<string, unknown>, RegExp]>) {
      const res = await invoke("POST", "/api/event-records", badBody);
      assert.equal(res.statusCode, 400);
      assert.match(data(res).error, pattern);
    }

    // Update with version check
    const updated = data(
      await invoke("PUT", `/api/event-records/${createdBody.id}`, {
        version: 1,
        recordingUrl: "https://www.youtube.com/watch?v=updated2",
        registrations: null,
      }),
    );
    assert.equal(updated.version, 2);
    assert.equal(updated.recordingUrl, "https://www.youtube.com/watch?v=updated2");
    assert.equal(updated.registrations, undefined);

    assert.equal(
      (await invoke("PUT", `/api/event-records/${createdBody.id}`, { version: 1, title: "Stale" }))
        .statusCode,
      409,
    );

    // Delete both
    assert.equal(
      (await invoke("DELETE", `/api/event-records/${createdBody.id}`, { version: 2 })).statusCode,
      204,
    );
    assert.equal(
      (await invoke("DELETE", `/api/event-records/${data(second).id}`, { version: 1 })).statusCode,
      204,
    );
  });

  it("bulk imports event records idempotently", async () => {
    const batch = [
      {
        title: "MLOps Zoomcamp Competition - Bot or Not?",
        slug: "2025-06-10-mlops-zoomcamp-competition-bot-or-not",
        date: "2025-06-10",
        time: "17:00 Europe/Berlin",
        type: "Webinar",
        course: "MLOps Zoomcamp",
        series: "mlops-zoomcamp",
        lumaUrl: "https://lu.ma/bc9hdw61",
        speakers: ["Alexey Grigorev", "Alexander Guschin"],
        description: "## About Event\n\nLive preview.",
      },
    ];
    const firstImport = data(await invoke("POST", "/api/event-records/import", { items: batch }));
    assert.equal(firstImport.created, 1);
    assert.equal(firstImport.updated, 0);
    assert.equal(firstImport.unchanged, 0);

    const secondImport = data(await invoke("POST", "/api/event-records/import", { items: batch }));
    assert.equal(secondImport.created, 0);
    assert.equal(secondImport.updated, 0);
    assert.equal(secondImport.unchanged, 1);

    const thirdImport = data(
      await invoke("POST", "/api/event-records/import", {
        items: [
          {
            ...batch[0],
            recordingUrl: "https://www.youtube.com/watch?v=botornot",
          },
        ],
      }),
    );
    assert.equal(thirdImport.created, 0);
    assert.equal(thirdImport.updated, 1);
    assert.equal(thirdImport.items[0].recordingUrl, "https://www.youtube.com/watch?v=botornot");
  });
});
