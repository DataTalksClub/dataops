import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

import {
  ENTITY_VOCABULARY,
  TASKS_SECTIONS,
  WORKSPACE_PATH_BY_VIEW,
  WORKSPACE_ROUTE_DEFINITIONS,
  canonicalWorkspaceUrl,
  isRealIsoDate,
  parseWorkspaceLocation,
  tasksSectionTitle,
  workspacePath,
  workspaceRouteFor,
} from "../src/core/workspace.js";
import { cardLinkTarget } from "../src/core/links.js";
import { SPONSORS_TABS, sponsorRecordPath, sponsorsPath } from "../src/core/sponsor-routes.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const browserLocation = (path = "/") => {
  const url = new URL(path || "/", "https://portal.test");
  return { pathname: url.pathname, search: url.search, hash: url.hash };
};

describe("canonical workspace routing", () => {
  test("directly imports routing from the production workspace module", () => {
    assert.equal(typeof parseWorkspaceLocation, "function");
    assert.equal(typeof canonicalWorkspaceUrl, "function");
  });

  test("Operations nav and path map no longer include mailing exports", () => {
    const markup = readFileSync(path.join(repoRoot, "frontend/index.html"), "utf8");
    assert.doesNotMatch(markup, /mailing-exports-nav-button/);
    assert.doesNotMatch(markup, /data-workspace-view="mailing-exports"/);
    assert.doesNotMatch(markup, />Mailing exports</);
    for (const view of ["bookkeeping", "sponsors", "newsletter", "calendar"]) {
      assert.match(markup, new RegExp(`data-workspace-view="${view}"`));
    }
    assert.equal(Object.hasOwn(WORKSPACE_PATH_BY_VIEW, "mailing-exports"), false);
    assert.doesNotMatch(markup, /data-workspace-view="review"/);
    assert.equal(Object.hasOwn(WORKSPACE_PATH_BY_VIEW, "review"), false);
  });

  test("retains every canonical workspace route", () => {
    assert.deepEqual(Object.keys(WORKSPACE_ROUTE_DEFINITIONS), [
      "/",
      "/operating-model",
      "/tasks",
      "/cards",
      "/cards/archive",
      "/templates",
      "/recurring",
      "/bookkeeping",
      "/sponsors",
      "/sponsors/pipeline",
      "/sponsors/companies",
      "/sponsors/people",
      "/sponsors/leads",
      "/sponsors/newsletters",
      "/sponsors/money",
      "/sponsors/deals/:dealId",
      "/sponsors/companies/:companyId",
      "/sponsors/people/:personId",
      "/sponsors/leads/:leadId",
      "/sponsors/newsletters/:newsletterId",
      "/newsletter",
      "/calendar",
      "/podcast",
      "/podcast/schedule",
      "/podcast/:episodeId",
      "/processes",
      "/admin",
      "/users",
      "/device",
    ]);
  });

  test("gives every Sponsors tab and record its own path", () => {
    for (const [tab] of SPONSORS_TABS) {
      const url = sponsorsPath(tab);
      const route = parseWorkspaceLocation(url, browserLocation(url));
      assert.equal(route.view, "sponsors", url);
      assert.equal(route.sponsorsTab, tab, url);
      assert.equal(route.canonicalUrl, url, url);
      assert.equal(route.normalized, false, url);
    }
    assert.equal(WORKSPACE_PATH_BY_VIEW.sponsors, "/sponsors/pipeline");
    for (const [kind, param, tab] of [
      ["deal", "dealId", "pipeline"],
      ["company", "companyId", "pipeline"],
      ["person", "personId", "people"],
      ["lead", "leadId", "leads"],
      ["newsletter", "newsletterId", "newsletters"],
    ]) {
      const url = sponsorRecordPath(kind, "id 1/2");
      const route = parseWorkspaceLocation(url, browserLocation(url));
      assert.equal(route.params.get(param), "id 1/2", url);
      assert.equal(route.sponsorsTab, tab, url);
      assert.equal(route.canonicalUrl, url, url);
      assert.equal(workspaceRouteFor(url).canonicalUrl, url, url);
    }
  });

  test("redirects bare /sponsors to the default tab and rejects unknown tabs", () => {
    for (const url of ["/sponsors", "/sponsors/", "/sponsors?dealId=old"]) {
      const route = parseWorkspaceLocation(url, browserLocation(url));
      assert.equal(route.canonicalUrl, "/sponsors/pipeline", url);
      assert.equal(route.sponsorsTab, "pipeline", url);
      assert.equal(route.normalized, true, url);
    }
    assert.equal(workspaceRouteFor("/sponsors").canonicalUrl, "/sponsors/pipeline");
    for (const url of ["/sponsors/queue", "/sponsors/finance", "/sponsors/deals", "/sponsors/companies/a/b"]) {
      assert.deepEqual(parseWorkspaceLocation(url, browserLocation(url)), { invalid: true, reason: "unknown path" }, url);
    }
  });

  test("serializes only supported parameters in stable canonical order", () => {
    assert.equal(
      canonicalWorkspaceUrl("/tasks", {
        contextCardId: "return card",
        ignored: "no",
        cardId: "filter card",
        date: "2026-08-12",
        taskId: "task/1",
      }),
      "/tasks?taskId=task%2F1&date=2026-08-12&cardId=filter+card&contextCardId=return+card",
    );
    assert.equal(
      canonicalWorkspaceUrl("/cards/archive", { taskId: "task-1", cardId: "card-1" }),
      "/cards/archive?cardId=card-1&taskId=task-1",
    );
  });

  test("keeps the queue's assignee scope in the URL with Mine as the bare default", () => {
    assert.equal(canonicalWorkspaceUrl("/tasks", { assignee: "me" }), "/tasks");
    assert.equal(canonicalWorkspaceUrl("/tasks", { assignee: "all" }), "/tasks?assignee=all");
    assert.equal(
      canonicalWorkspaceUrl("/tasks", { assignee: "user-1", taskId: "task-1" }),
      "/tasks?taskId=task-1&assignee=user-1",
    );
    const mine = parseWorkspaceLocation("/tasks?assignee=me", browserLocation("/tasks?assignee=me"));
    assert.equal(mine.canonicalUrl, "/tasks");
    assert.equal(mine.normalized, true);
    const unassigned = parseWorkspaceLocation(
      "/tasks?assignee=unassigned",
      browserLocation("/tasks?assignee=unassigned"),
    );
    assert.equal(unassigned.params.get("assignee"), "unassigned");
    assert.equal(unassigned.normalized, false);
    assert.equal(
      parseWorkspaceLocation("/tasks?assignee=", browserLocation("/tasks?assignee=")).invalid,
      true,
    );
  });

  test("parses active, archive, card, and nested task URLs without normalization", () => {
    for (const hash of [
      "/cards",
      "/cards/archive",
      "/cards?cardId=card-1",
      "/cards?cardId=card-1&taskId=task-1",
      "/cards/archive?cardId=card-2&taskId=task-2",
    ]) {
      const route = parseWorkspaceLocation(hash, browserLocation(hash));
      assert.equal(route.invalid, undefined, hash);
      assert.equal(route.view, "tasks", hash);
      assert.equal(route.tasksSection, "workflows", hash);
      assert.equal(route.normalized, false, hash);
      assert.equal(route.canonicalUrl, hash, hash);
    }
  });

  test("rejects orphan tasks, duplicate values, invalid dates, and malformed input", () => {
    const cases = [
      ["", "empty path"],
      ["cards", "malformed path"],
      ["/cards#again", "malformed path"],
      ["/cards?cardId=", "invalid cardId"],
      ["/cards?cardId=one&cardId=two", "invalid cardId"],
      ["/cards?taskId=task-1", "taskId requires cardId"],
      ["/cards/archive?taskId=task-1", "taskId requires cardId"],
      ["/processes?type=", "invalid type"],
      ["/processes?domain=one&domain=two", "invalid domain"],
      ["/processes?view=catalog", "invalid view"],
      ["/review", "unknown path"],
      ["/tasks?date=2026-02-30", "invalid date"],
      ["/tasks?taskId=%E0%A4%A", "malformed encoding"],
      ["/unknown", "unknown path"],
      ["/mailing-exports", "unknown path"],
    ];
    for (const [hash, reason] of cases) {
      assert.deepEqual(parseWorkspaceLocation(hash, browserLocation(hash)), { invalid: true, reason }, hash);
    }
  });

  test("keeps Process Docs › Recently changed in the URL", () => {
    const route = parseWorkspaceLocation("/processes?view=recent", browserLocation("/processes?view=recent"));
    assert.equal(route.view, "docs");
    assert.equal(route.params.get("view"), "recent");
    assert.equal(route.canonicalUrl, "/processes?view=recent");
  });

  test("keeps explicit null invalid instead of falling back to the browser location", () => {
    assert.deepEqual(parseWorkspaceLocation(null, browserLocation("/cards")), {
      invalid: true,
      reason: "empty path",
    });
    assert.equal(parseWorkspaceLocation(undefined, browserLocation("/cards")).path, "/cards");
  });

  test("normalizes trailing slashes and discards unsupported query parameters", () => {
    const route = parseWorkspaceLocation(
      "/cards/archive/?cardId=card-1&unsupported=unsafe",
      browserLocation("/cards/archive/?cardId=card-1&unsupported=unsafe"),
    );
    assert.equal(route.invalid, undefined);
    assert.equal(route.path, "/cards/archive");
    assert.equal(route.canonicalUrl, "/cards/archive?cardId=card-1");
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
      ["recurring", "Recurring"],
    ]);
    assert.equal(workspacePath("tasks", "workflows"), "/cards");
    assert.equal(workspacePath("tasks", "templates"), "/templates");
    assert.equal(workspacePath("tasks", "recurring"), "/recurring");
    assert.equal(tasksSectionTitle("workflows"), "Cards");
    assert.equal(tasksSectionTitle("templates"), "Templates");
    assert.equal(tasksSectionTitle("recurring"), "Recurring");
  });

  test("constructs a route object from canonical path and entity parameters", () => {
    const route = workspaceRouteFor(
      "/cards/archive",
      { cardId: "card-a", taskId: "task-b" },
      browserLocation(),
    );
    assert.equal(route.path, "/cards/archive");
    assert.equal(route.canonicalUrl, "/cards/archive?cardId=card-a&taskId=task-b");
    assert.deepEqual([...route.params], [["cardId", "card-a"], ["taskId", "task-b"]]);
  });

  test("normalizes Process Docs filters into the canonical parameter order", () => {
    const route = workspaceRouteFor(
      "/processes",
      { tag: "people", system: "portal", type: "process", domain: "operations" },
      browserLocation(),
    );
    assert.equal(route.path, "/processes");
    assert.equal(
      route.canonicalUrl,
      "/processes?domain=operations&type=process&system=portal&tag=people",
    );
    assert.deepEqual([...route.params], [
      ["domain", "operations"],
      ["type", "process"],
      ["system", "portal"],
      ["tag", "people"],
    ]);

    const parsed = parseWorkspaceLocation(
      "/processes?tag=people&system=portal&type=process&domain=operations",
      browserLocation("/processes?tag=people&system=portal&type=process&domain=operations"),
    );
    assert.equal(parsed.normalized, true);
    assert.equal(parsed.canonicalUrl, route.canonicalUrl);
    assert.deepEqual([...parsed.params], [...route.params]);
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

describe("podcast schedule route", () => {
  test("/podcast/schedule is its own path, not an episode id", () => {
    const route = parseWorkspaceLocation("/podcast/schedule");
    assert.equal(route.view, "podcast");
    assert.equal(route.path, "/podcast/schedule");
    assert.equal(route.params.get("episodeId"), null);
    assert.equal(parseWorkspaceLocation("/podcast/abc-123").params.get("episodeId"), "abc-123");
  });

  test("?view= rides on the register and an episode, not on the schedule", () => {
    assert.equal(parseWorkspaceLocation("/podcast?view=list").canonicalUrl, "/podcast?view=list");
    const open = parseWorkspaceLocation("/podcast/abc-123?view=list");
    assert.equal(open.params.get("view"), "list");
    assert.equal(open.params.get("episodeId"), "abc-123");
    assert.equal(parseWorkspaceLocation("/podcast/schedule?view=list").canonicalUrl, "/podcast/schedule");
  });
});

describe("Card and Task dialogs over any page", () => {
  test("every route carries the dialog params; a Card page names its Card cardId", () => {
    const queue = parseWorkspaceLocation("/tasks?assignee=all&card=card-1", { pathname: "/tasks", search: "?assignee=all&card=card-1" });
    assert.equal(queue.canonicalUrl, "/tasks?assignee=all&card=card-1");
    assert.equal(queue.modalCardId, "card-1");
    assert.equal(queue.modalTaskId, "");
    assert.equal(queue.cardParam, "card");
    const calendar = workspaceRouteFor("/calendar", { card: "card-2", taskId: "task-2" });
    assert.equal(calendar.canonicalUrl, "/calendar?card=card-2&taskId=task-2");
    assert.equal(calendar.modalTaskId, "task-2");
    const deal = workspaceRouteFor("/sponsors/deals/deal-1", { card: "card-3" });
    assert.equal(deal.canonicalUrl, "/sponsors/deals/deal-1?card=card-3");
    const board = workspaceRouteFor("/cards", { cardId: "card-4", card: "ignored" });
    assert.equal(board.canonicalUrl, "/cards?cardId=card-4");
    assert.equal(board.modalCardId, "card-4");
    assert.equal(board.cardParam, "cardId");
  });

  test("a plain click on a link to a Card's page opens it in place", () => {
    const origin = "https://ops.example";
    const click = (href, extra = {}, attributes = {}) => cardLinkTarget({
      button: 0,
      defaultPrevented: false,
      target: {
        closest: () => ({
          target: attributes.target || "",
          getAttribute: () => href,
          hasAttribute: (name) => name in attributes,
        }),
      },
      ...extra,
    }, origin);
    assert.equal(click("/cards?cardId=card-1"), "card-1");
    assert.equal(click("/cards/archive?cardId=card-2"), "card-2");
    assert.equal(click("/cards?cardId=card-1", { metaKey: true }), "");
    assert.equal(click("/cards?cardId=card-1", { ctrlKey: true }), "");
    assert.equal(click("/cards?cardId=card-1", { button: 1 }), "");
    assert.equal(click("/cards?cardId=card-1", { defaultPrevented: true }), "");
    assert.equal(click("/cards?cardId=card-1", {}, { target: "_blank" }), "");
    assert.equal(click("/cards?cardId=card-1&taskId=task-1"), "");
    assert.equal(click("/cards"), "");
    assert.equal(click("https://elsewhere.example/cards?cardId=card-1"), "");
    assert.equal(click("/tasks?cardId=card-1"), "");
  });
});
