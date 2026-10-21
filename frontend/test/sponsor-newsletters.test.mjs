import assert from "node:assert/strict";
import { test } from "node:test";

import { filterNewsletters } from "../src/surfaces/finance/sponsor-newsletters.js";
import {
  parseSponsorBulletItems,
  readVisualFileAsDataUrl,
  serializeSponsorBulletItems,
} from "../src/surfaces/operations/sponsor-docs.js";

test("attention filter keeps overdue missing and pending titles", () => {
  const items = [
    { id: "late", health: "overdue" },
    { id: "none", health: "missing" },
    { id: "sign", health: "pending" },
    { id: "ok", health: "current" },
    { id: "wait", health: "waiting" },
  ];
  assert.deepEqual(filterNewsletters(items, "").map((item) => item.id), [
    "late", "none", "sign", "ok", "wait",
  ]);
  assert.deepEqual(filterNewsletters(items, "attention").map((item) => item.id), [
    "late", "none", "sign",
  ]);
  assert.deepEqual(filterNewsletters(items, "current").map((item) => item.id), ["ok"]);
});

test("sponsor newsletter bullet list helpers preserve structured items and visual file reader encodes data URL", async () => {
  const parsed = parseSponsorBulletItems("• Fast ingestion\n• SQL transforms\n• Zero ops", 3);
  assert.deepEqual(parsed, ["Fast ingestion", "SQL transforms", "Zero ops"]);
  assert.equal(
    serializeSponsorBulletItems([...parsed, "Real-time alerting"]),
    "- Fast ingestion\n- SQL transforms\n- Zero ops\n- Real-time alerting",
  );

  const bytes = new Uint8Array([137, 80, 78, 71]);
  const dataUrl = await readVisualFileAsDataUrl({
    name: "sponsor-banner.png",
    type: "image/png",
    arrayBuffer: async () => bytes.buffer,
  });
  assert.equal(dataUrl, "data:image/png;base64,iVBORw==");
});
