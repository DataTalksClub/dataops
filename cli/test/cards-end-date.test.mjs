import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const { run } = await import("../src/cli.mjs");

const template = {
  id: "tpl-cohort",
  type: "maven-cohort",
  name: "Maven Buildcamp Cohort",
  revision: "rev-1",
  version: 3,
  triggerType: "manual",
  taskDefinitions: [
    { refId: "kickoff", description: "Kick off", offsetDays: 0 },
    { refId: "certificates", description: "Issue certificates", offsetDays: 7, anchor: "end" },
  ],
};

const findRoutes = {
  "GET /api/templates/maven-cohort": { status: 404, body: { error: "Template not found" } },
  "GET /api/templates": { templates: [template] },
};

describe("cards end-date commands", () => {
  test("create sends --end-date to the portal", async () => {
    const calls = fakePortal({
      ...findRoutes,
      "POST /api/cards": { card: { id: "c-1", title: "Cohort" }, tasks: [] },
    });
    const io = captureIo();
    assert.equal(
      await run(["cards", "create", "--title", "Cohort", "--date", "2026-09-01", "--end-date", "2026-10-13", "--template", "maven-cohort"], io),
      0,
    );
    assert.deepEqual(calls.at(-1).body, {
      anchorDate: "2026-09-01",
      endDate: "2026-10-13",
      title: "Cohort",
      templateId: "tpl-cohort",
    });
  });

  test("create rejects a malformed --end-date before sending", async () => {
    const calls = fakePortal(findRoutes);
    assert.equal(
      await run(["cards", "create", "--title", "Cohort", "--date", "2026-09-01", "--end-date", "tomorrowish", "--template", "maven-cohort"], captureIo()),
      2,
    );
    assert.ok(calls.every((call) => !call.url.endsWith("/api/cards") || call.method === "GET"));
  });

  test("update sends --end-date with the fetched version", async () => {
    const calls = fakePortal({
      "GET /api/cards/c-1": { card: { id: "c-1", version: 5 } },
      "PUT /api/cards/c-1": { card: { id: "c-1", version: 6, endDate: "2026-10-20" } },
    });
    assert.equal(await run(["cards", "update", "c-1", "--end-date", "2026-10-20"], captureIo()), 0);
    assert.deepEqual(calls.at(-1).body, { endDate: "2026-10-20", expectedVersion: 5 });
  });

  test("show prints the card end date when present", async () => {
    fakePortal({
      "GET /api/cards/c-1": { card: { id: "c-1", anchorDate: "2026-09-01", endDate: "2026-10-13" } },
      "GET /api/tasks": { tasks: [] },
    });
    const io = captureIo();
    assert.equal(await run(["cards", "show", "c-1"], io), 0);
    assert.match(io.text(), /2026-10-13/);
  });
});
