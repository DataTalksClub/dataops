import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const realFetch = globalThis.fetch;
const { run } = await import("../src/cli.mjs");
const { parseEventMarkdown, parseEventsYamlRecordingMap } = await import(
  "../src/commands/events.mjs"
);

afterEach(() => {
  globalThis.fetch = realFetch;
});

const sampleEvent = (fields = {}) => ({
  id: "ev-1",
  title: "Deploying ML Models with FastAPI and uv",
  slug: "2025-08-11-deploying-ml-models-with-fastapi-and-uv",
  date: "2025-08-11",
  time: "17:00 Europe/Berlin",
  type: "Workshop",
  course: "ML Zoomcamp",
  series: "ml-zoomcamp",
  module: "Module 5",
  lumaUrl: "https://lu.ma/f8rmlsmh",
  recordingUrl: "https://www.youtube.com/watch?v=synthetic1",
  speakers: ["Alexey Grigorev"],
  description: "## About Event\n\nHands-on FastAPI and uv workshop.",
  version: 2,
  ...fields,
});

describe("events CLI", () => {
  test("parseEventMarkdown parses Luma archive markdown and enriches recordingUrl from events.yaml", () => {
    const md = `# Deploying ML Models with AWS Lambda (Serverless)

- **Type:** Workshop
- **Date:** Monday, August 18, 2025
- **Time:** 17:00 Europe/Berlin
- **Instructor:** Alexey Grigorev, Alexander Guschin
- **Luma:** https://lu.ma/aws12345
- **Course:** ML Zoomcamp, Module 9
- **Registrations:** 156

## About Event

Deploy ML models to AWS Lambda.
`;
    const recordingMap = parseEventsYamlRecordingMap(`
- time: 2025-08-18 17:00:00
  title: "Deploying ML Models with AWS Lambda (Serverless)"
  link: https://lu.ma/aws12345
  youtube: https://www.youtube.com/watch?v=lambda999
`);
    const parsed = parseEventMarkdown(md, {
      filePath: "/tmp/ml-zoomcamp/2025-08-18-deploying-ml-models-with-aws-lambda-serverless.md",
      series: "ml-zoomcamp",
      recordingMap,
    });
    assert.deepEqual(parsed, {
      title: "Deploying ML Models with AWS Lambda (Serverless)",
      slug: "2025-08-18-deploying-ml-models-with-aws-lambda-serverless",
      date: "2025-08-18",
      time: "17:00 Europe/Berlin",
      type: "Workshop",
      course: "ML Zoomcamp",
      series: "ml-zoomcamp",
      module: "Module 9",
      lumaUrl: "https://lu.ma/aws12345",
      recordingUrl: "https://www.youtube.com/watch?v=lambda999",
      speakers: ["Alexey Grigorev", "Alexander Guschin"],
      description: "## About Event\n\nDeploy ML models to AWS Lambda.",
      registrations: 156,
    });
  });

  test("list filters by course and date and prints table", async () => {
    const calls = fakePortal({
      "GET /api/event-records": { items: [sampleEvent()] },
    });
    const io = captureIo();
    assert.equal(
      await run(["events", "list", "--course", "ml-zoomcamp", "--date", "2025-08"], io),
      0,
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].query, { course: "ml-zoomcamp", date: "2025-08" });
    assert.match(io.text(), /2025-08-11/);
    assert.match(io.text(), /ML Zoomcamp/);
    assert.match(io.text(), /Deploying ML Models with FastAPI and uv/);
  });

  test("show prints metadata fields and markdown description", async () => {
    fakePortal({
      "GET /api/event-records/ev-1": sampleEvent(),
    });
    const io = captureIo();
    assert.equal(await run(["events", "show", "ev-1"], io), 0);
    assert.match(io.text(), /https:\/\/lu\.ma\/f8rmlsmh/);
    assert.match(io.text(), /https:\/\/www\.youtube\.com\/watch\?v=synthetic1/);
    assert.match(io.text(), /## About Event/);
  });

  test("create and update send expected payloads", async () => {
    const calls = fakePortal({
      "POST /api/event-records": ({ body }) => ({
        status: 201,
        body: sampleEvent({ ...body, version: 1 }),
      }),
      "GET /api/event-records/ev-1": sampleEvent(),
      "PUT /api/event-records/ev-1": ({ body }) => sampleEvent({ ...body }),
    });
    assert.equal(
      await run(
        [
          "events",
          "create",
          "--title",
          "FastAPI Workshop",
          "--date",
          "2025-08-11",
          "--course",
          "ML Zoomcamp",
          "--speakers",
          "Alexey Grigorev",
          "--luma-url",
          "https://lu.ma/f8rmlsmh",
          "--recording-url",
          "https://www.youtube.com/watch?v=synthetic1",
          "--description",
          "## About Event\n\nBody.",
        ],
        captureIo(),
      ),
      0,
    );
    assert.deepEqual(calls[0].body, {
      title: "FastAPI Workshop",
      date: "2025-08-11",
      course: "ML Zoomcamp",
      speakers: ["Alexey Grigorev"],
      lumaUrl: "https://lu.ma/f8rmlsmh",
      recordingUrl: "https://www.youtube.com/watch?v=synthetic1",
      description: "## About Event\n\nBody.",
    });

    assert.equal(
      await run(["events", "update", "ev-1", "--recording-url", "none"], captureIo()),
      0,
    );
    assert.deepEqual(calls.at(-1).body, {
      recordingUrl: null,
      version: 2,
    });
  });

  test("import walks a folder of Markdown files, skips README.md, and posts bulk import", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "dataops-events-test-"));
    try {
      mkdirSync(path.join(tmpDir, "ml-zoomcamp"), { recursive: true });
      mkdirSync(path.join(tmpDir, "community"), { recursive: true });
      writeFileSync(path.join(tmpDir, "README.md"), "# Index\n");
      writeFileSync(
        path.join(tmpDir, "ml-zoomcamp", "2025-08-11-fastapi-uv.md"),
        `# FastAPI and uv\n\n- **Type:** Workshop\n- **Date:** Monday, August 11, 2025\n- **Time:** 17:00 Europe/Berlin\n- **Instructor:** Alexey Grigorev\n- **Luma:** https://lu.ma/f8rmlsmh\n- **Course:** ML Zoomcamp\n\n## About Event\n\nBody 1.\n`,
      );
      writeFileSync(
        path.join(tmpDir, "community", "2025-04-01-agentic-search.md"),
        `# Agentic Search\n\n- **Type:** Webinar\n- **Date:** Tuesday, April 1, 2025\n- **Instructor:** Florian Hoenicke\n- **Luma:** https://lu.ma/uy0kcjrm\n- **Related course:** LLM Zoomcamp (adjacent, not part of the series)\n\n## About Event\n\nBody 2.\n`,
      );

      const calls = fakePortal({
        "POST /api/event-records/import": ({ body }) => ({
          status: 200,
          body: {
            created: body.items.length,
            updated: 0,
            unchanged: 0,
            total: body.items.length,
            items: body.items,
          },
        }),
      });
      const io = captureIo();
      assert.equal(await run(["events", "import", tmpDir], io), 0);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].body.items.length, 2);
      assert.equal(calls[0].body.items[0].series, "community");
      assert.equal(calls[0].body.items[1].series, "ml-zoomcamp");
      assert.match(io.text(), /Imported 2 event\(s\) \(2 created, 0 updated, 0 unchanged\)\./);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
