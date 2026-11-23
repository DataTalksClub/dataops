import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const { run } = await import("../src/cli.mjs");

const aishlTemplate = {
  id: "a7549440-c861-409f-906d-23e2661e2fb1",
  type: "aishl-workshop",
  name: "AISHL Workshop",
  origin: "custom",
  version: 13,
  triggerType: "manual",
  taskDefinitions: [],
};

describe("cards create for aishl-workshop", () => {
  test("resolves the aishl-workshop template by type and posts card creation", async () => {
    const calls = fakePortal({
      "GET /api/templates/aishl-workshop": { status: 404, body: { error: "Template not found" } },
      "GET /api/templates": { templates: [aishlTemplate] },
      "POST /api/cards": {
        card: {
          id: "card-aishl-1",
          templateId: aishlTemplate.id,
          title: "UX and Usability Testing for AI Applications",
          anchorDate: "2026-12-17",
        },
        tasks: [],
      },
    });
    const io = captureIo();
    const exitCode = await run([
      "cards",
      "create",
      "--date",
      "2026-12-17",
      "--template",
      "aishl-workshop",
      "--title",
      "UX and Usability Testing for AI Applications",
      "--json",
    ], io);
    assert.equal(exitCode, 0);
    assert.deepEqual(calls.at(-1).body, {
      anchorDate: "2026-12-17",
      title: "UX and Usability Testing for AI Applications",
      templateId: "a7549440-c861-409f-906d-23e2661e2fb1",
    });
    const out = JSON.parse(io.text());
    assert.equal(out.card.templateId, "a7549440-c861-409f-906d-23e2661e2fb1");
  });
});
