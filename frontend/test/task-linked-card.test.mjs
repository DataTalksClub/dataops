import assert from "node:assert/strict";
import { test } from "node:test";

import { linkedCardIdFrom } from "../src/surfaces/work-detail/task-linked-card.js";

test("a linked Card is given as a bare id or a pasted portal address", () => {
  assert.equal(linkedCardIdFrom("  b4a90396-ff08-493e  "), "b4a90396-ff08-493e");
  assert.equal(linkedCardIdFrom("https://ops.example/cards?cardId=card-7&taskId=t1"), "card-7");
  assert.equal(linkedCardIdFrom("https://ops.example/tasks?card=card-8"), "card-8");
  assert.equal(linkedCardIdFrom("https://ops.example/tasks"), "");
  assert.equal(linkedCardIdFrom(""), "");
});
