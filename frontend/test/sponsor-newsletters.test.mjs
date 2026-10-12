import assert from "node:assert/strict";
import { test } from "node:test";

import { filterNewsletters } from "../src/surfaces/finance/sponsor-newsletters.js";

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
