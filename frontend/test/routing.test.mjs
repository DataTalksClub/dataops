import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ENTITY_VOCABULARY,
  TASKS_SECTIONS,
  WORKSPACE_ROUTE_DEFINITIONS,
  canonicalWorkspaceUrl,
  isRealIsoDate,
  parseWorkspaceHash,
  tasksSectionTitle,
  workspaceHashPath,
  workspaceRouteFor,
} from "../src/core/routing.js";

const browserLocation = (hash = "") => ({ pathname: "/", search: "", hash });

describe("canonical workspace routing", () => {
  test("directly imports the production routing module", () => {
    assert.equal(typeof parseWorkspaceHash, "function");
    assert.equal(typeof canonicalWorkspaceUrl, "function");
  });

  test("retains every top-level and nested workspace route", () => {
    assert.deepEqual(Object.keys(WORKSPACE_ROUTE_DEFINITIONS), [
      "/",
      "/inbox",
      "/tasks",
      "/cards",
      "/cards/archive",
      "/assistants",
      "/templates",
      "/recurring",
      "/artifacts",
      "/notifications",
      "/bookkeeping",
      "/sponsors",
      "/newsletter",
      "/calendar",
      "/mailing-exports",
      "/processes",
      "/admin",
      "/users",
    ]);
  });

  test("serializes only supported parameters in stable canonical order", () => {
    assert.equal(
      canonicalWorkspaceUrl("/tasks", {
        contextBundleId: "return card",
        ignored: "no",
        bundleId: "filter card",
        date: "2026-08-12",
        taskId: "task/1",
      }),
      "/#/tasks?taskId=task%2F1&date=2026-08-12&bundleId=filter+card&contextBundleId=return+card",
    );
    assert.equal(
      canonicalWorkspaceUrl("/cards/archive", { taskId: "task-1", cardId: "card-1" }),
      "/#/cards/archive?cardId=card-1&taskId=task-1",
    );
  });

  test("parses active, archive, card, and nested task URLs without normalization", () => {
    for (const hash of [
      "#/cards",
      "#/cards/archive",
      "#/cards?cardId=card-1",
      "#/cards?cardId=card-1&taskId=task-1",
      "#/cards/archive?cardId=card-2&taskId=task-2",
    ]) {
      const route = parseWorkspaceHash(hash, browserLocation(hash));
      assert.equal(route.invalid, undefined, hash);
      assert.equal(route.view, "tasks", hash);
      assert.equal(route.tasksSection, "workflows", hash);
      assert.equal(route.normalized, false, hash);
      assert.equal(route.canonicalUrl, `/${hash}`, hash);
    }
  });

  test("rejects orphan tasks, duplicate values, invalid dates, and malformed input", () => {
    const cases = [
      ["", "empty hash"],
      ["cards", "malformed hash"],
      ["#/cards#again", "malformed hash"],
      ["#/cards?cardId=", "invalid cardId"],
      ["#/cards?cardId=one&cardId=two", "invalid cardId"],
      ["#/cards?taskId=task-1", "taskId requires cardId"],
      ["#/cards/archive?taskId=task-1", "taskId requires cardId"],
      ["#/tasks?date=2026-02-30", "invalid date"],
      ["#/tasks?taskId=%E0%A4%A", "malformed encoding"],
      ["#/unknown", "unknown path"],
    ];
    for (const [hash, reason] of cases) {
      assert.deepEqual(parseWorkspaceHash(hash, browserLocation(hash)), { invalid: true, reason }, hash);
    }
  });

  test("keeps explicit null invalid instead of falling back to the browser hash", () => {
    assert.deepEqual(parseWorkspaceHash(null, browserLocation("#/cards")), {
      invalid: true,
      reason: "empty hash",
    });
    assert.equal(parseWorkspaceHash(undefined, browserLocation("#/cards")).path, "/cards");
  });

  test("normalizes trailing slashes and discards unsupported query parameters", () => {
    const route = parseWorkspaceHash(
      "#/cards/archive/?cardId=card-1&unsupported=unsafe",
      browserLocation("#/cards/archive/?cardId=card-1&unsupported=unsafe"),
    );
    assert.equal(route.invalid, undefined);
    assert.equal(route.path, "/cards/archive");
    assert.equal(route.canonicalUrl, "/#/cards/archive?cardId=card-1");
    assert.equal(route.normalized, true);
    assert.deepEqual([...route.params], [["cardId", "card-1"]]);
  });

  test("maps navigation and titles to Template, Card, and Task vocabulary", () => {
    assert.deepEqual(ENTITY_VOCABULARY, {
      template: "Template",
      card: "Card",
      task: "Task",
    });
    assert.deepEqual(TASKS_SECTIONS, [
      ["queue", "Queue"],
      ["workflows", "Cards"],
      ["templates", "Templates"],
      ["assistants", "Assistants"],
      ["artifacts", "Artifacts"],
    ]);
    assert.equal(workspaceHashPath("tasks", "workflows"), "/cards");
    assert.equal(workspaceHashPath("tasks", "templates"), "/templates");
    assert.equal(tasksSectionTitle("workflows"), "Tasks - Cards");
    assert.equal(tasksSectionTitle("templates"), "Tasks - Templates");
  });

  test("constructs a route object from canonical path and entity parameters", () => {
    const route = workspaceRouteFor(
      "/cards/archive",
      { cardId: "card-a", taskId: "task-b" },
      browserLocation(),
    );
    assert.equal(route.path, "/cards/archive");
    assert.equal(route.canonicalUrl, "/#/cards/archive?cardId=card-a&taskId=task-b");
    assert.deepEqual([...route.params], [["cardId", "card-a"], ["taskId", "task-b"]]);
  });

  test("returns an invalid route for an unknown programmatic destination", () => {
    assert.deepEqual(workspaceRouteFor("/unknown", {}, browserLocation()), {
      invalid: true,
      reason: "unknown path",
    });
  });

  test("validates real ISO calendar dates", () => {
    assert.equal(isRealIsoDate("2024-02-29"), true);
    assert.equal(isRealIsoDate("2026-08-12"), true);
    assert.equal(isRealIsoDate("2025-02-29"), false);
    assert.equal(isRealIsoDate("2026-13-01"), false);
    assert.equal(isRealIsoDate("12-08-2026"), false);
  });
});
