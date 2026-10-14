import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { hasIcon } from "../src/core/icons.js";
import { resourcesFromPayload } from "../src/core/resources.js";

const vocabulary = JSON.parse(
  readFileSync(new URL("../../backend/src/resources/requiredResources.json", import.meta.url), "utf8"),
);

test("every required resource names a glyph in the shared icon set", () => {
  for (const resource of vocabulary.resources) {
    assert.ok(hasIcon(resource.icon), `${resource.id} icon ${resource.icon}`);
  }
});

test("the payload adapter keeps only entries with an id", () => {
  assert.deepEqual(resourcesFromPayload({ resources: [{ id: "luma" }, null, { name: "x" }] }), [{ id: "luma" }]);
  assert.deepEqual(resourcesFromPayload(undefined), []);
});
