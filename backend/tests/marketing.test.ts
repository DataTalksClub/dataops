import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { createTables, startLocal, stopLocal } from "../scripts/local-dynamodb";
import { getClient } from "../src/db/client";
import { handleTaskRoutes } from "../src/routes/tasks";
import { handleMarketingRoutes } from "../src/routes/marketing";
import { listTasksByStatus, getTask, updateTask } from "../src/db/tasks";
import { createCard, getCard } from "../src/db/cards";
import { createTemplate } from "../src/db/templates";
import { TABLE_MARKETING, TABLE_TASKS } from "../src/db/tableNames";
import {
  pushSnapshots,
  seriesKey,
  snapshotKey,
  getMarketingRow,
} from "../src/db/marketing";
import {
  goalProgress,
  validateGoal,
  periodRange,
  type Snapshot,
  type Goal,
} from "../src/marketing/model";
import {
  seriesSnapshots,
  accumulateAcademyVisits,
} from "../src/marketing/service";
import { isScopedTokenRequestAllowed } from "../src/auth/tokenScopes";

const snapshot = {
  metricKey: "gsc_nonbrand_clicks",
  scope: "page:https://example.com/a#fragment",
  source: "gsc",
  period: "2026-W47",
  value: 10,
  unit: "count",
} as Snapshot;
const goal = {
  ref: "search-clicks",
  title: "Search clicks",
  metricKey: "gsc_nonbrand_clicks",
  scope: "site",
  source: "gsc",
  baseline: { value: 0, date: "2026-11-01", note: "Synthetic test" },
  target: { value: 100, date: "2027-01-01" },
  window: "week",
} as Goal;

describe("marketing contract", () => {
  let c: DynamoDBDocumentClient;
  before(async () => {
    c = await getClient(await startLocal());
    await createTables(c);
  });
  after(stopLocal);
  async function request(
    method: string,
    path: string,
    body?: any,
    q: Record<string, string> = {},
  ) {
    const result = await handleMarketingRoutes(
      `/api/marketing${path}`,
      method,
      {
        httpMethod: method,
        path: `/api/marketing${path}`,
        headers: { "x-user-id": "test-actor" },
        queryStringParameters: q,
        body: body === undefined ? null : JSON.stringify(body),
      },
      c,
    );
    return { status: result.statusCode, body: JSON.parse(result.body) };
  }
  it("creates a registry-backed plan, protects goal edits with plan version and appends attributed notes", async () => {
    const made = await request("POST", "/plans", {
      id: "test-plan",
      title: "Synthetic plan",
    });
    assert.equal(made.status, 201, JSON.stringify(made));
    assert.equal(
      (await request("GET", "/plans")).body.items[0].id,
      "test-plan",
    );
    assert.equal(
      (
        await request("POST", "/plans/test-plan/goals", {
          ...goal,
          version: 99,
        })
      ).status,
      409,
    );
    const added = await request("POST", "/plans/test-plan/goals", {
      ...goal,
      version: 1,
    });
    assert.equal(added.status, 201, JSON.stringify(added));
    assert.equal(
      (await request("GET", "/plans/test-plan/goals/search-clicks")).body
        .status,
      "no-data",
    );
    assert.equal(
      (
        await request("POST", "/plans/test-plan/notes", {
          version: 2,
          text: "Synthetic note",
          ref: "test",
        })
      ).status,
      200,
    );
    assert.equal(
      (await request("PATCH", "/plans/test-plan", { version: 3, goals: [] }))
        .status,
      400,
      "embedded goals cannot bypass goal validation",
    );
    const list = await c.send(
      new QueryCommand({
        TableName: TABLE_MARKETING,
        KeyConditionExpression: "PK=:pk",
        ExpressionAttributeValues: { ":pk": "PLANS" },
      }),
    );
    assert.equal(list.Items?.[0].id, "test-plan");
  });
  it("validates all snapshots before writing, uses safe keys, deduplicates, replaces with history and keeps latest on older pushes", async () => {
    assert.ok(!seriesKey(snapshot).includes("#"));
    assert.ok(!snapshotKey(snapshot).SK.includes("#"));
    const invalid = {
      ...snapshot,
      scope: "site",
      metricKey: "waitlist_signups",
    };
    await assert.rejects(
      () => pushSnapshots(c, [snapshot, invalid], {}, "test"),
      /Unknown metricKey/,
    );
    assert.equal(await getMarketingRow(c, snapshotKey(snapshot)), undefined);
    const pushed = await pushSnapshots(c, [snapshot], {}, "test");
    assert.equal(pushed.inserted, 1);
    assert.equal((await pushSnapshots(c, [snapshot], {}, "test")).unchanged, 1);
    await assert.rejects(
      () => pushSnapshots(c, [{ ...snapshot, value: 11 }], {}, "test"),
      /different value/,
    );
    const replaced = await pushSnapshots(
      c,
      [{ ...snapshot, value: 11 }],
      { replace: true },
      "test",
    );
    assert.equal(replaced.items[0].history[0].value, 10);
    await pushSnapshots(
      c,
      [{ ...snapshot, period: "2026-W46", value: 100 }],
      {},
      "test",
    );
    const latest = await getMarketingRow(c, {
      PK: "METRICS",
      SK: seriesKey(snapshot),
    });
    assert.equal(latest?.period, "2026-W47");
    assert.equal(latest?.value, 11);
    const provisional = { ...snapshot, scope: "site", provisional: true };
    await pushSnapshots(c, [provisional], {}, "test");
    assert.equal(
      (
        await pushSnapshots(
          c,
          [{ ...provisional, value: 30, provisional: false }],
          {},
          "test",
        )
      ).items[0].value,
      30,
    );
  });
  it("concurrent identical pushes converge and a conflicting batch never partially writes", async () => {
    const same = { ...snapshot, scope: "page:https://example.com/concurrent" };
    const results = await Promise.all([
      pushSnapshots(c, [same], {}, "one"),
      pushSnapshots(c, [same], {}, "two"),
    ]);
    assert.equal(
      results.reduce((n, r) => n + r.inserted, 0),
      1,
    );
    assert.equal(
      results.reduce((n, r) => n + r.unchanged, 0),
      1,
    );
    const fresh = { ...same, period: "2026-W48" };
    await assert.rejects(
      () => pushSnapshots(c, [fresh, { ...same, value: 99 }], {}, "test"),
      /different value/,
    );
    assert.equal(await getMarketingRow(c, snapshotKey(fresh)), undefined);
  });
  it("uses an atomic DynamoDB transaction for snapshots and latest series index with version guards", async () => {
    const seen: any[] = [];
    const fake = {
      send: async (command: any) => {
        seen.push(command);
        return {};
      },
    } as unknown as DynamoDBDocumentClient;
    // Use the production branch of transactWrite; restore emulation after inspecting the command.
    const {
      disableLocalTransactionEmulation,
      enableLocalTransactionEmulation,
    } = await import("../src/db/client");
    disableLocalTransactionEmulation();
    try {
      await pushSnapshots(fake, [snapshot], {}, "test");
    } finally {
      enableLocalTransactionEmulation();
    }
    const tx = seen.find((v) => v instanceof TransactWriteCommand);
    assert.ok(tx);
    assert.equal(tx.input.TransactItems.length, 2);
    assert.equal(tx.input.TransactItems[1].Put.Item.PK, "METRICS");
    assert.equal(
      tx.input.TransactItems[0].Put.ConditionExpression,
      "attribute_not_exists(PK)",
    );
  });
  it("rolls back the entire snapshot batch and index on an injected transaction failure", async () => {
    const one = { ...snapshot, scope: "page:https://example.com/rollback" };
    const two = { ...one, period: "2026-W48" };
    process.env.LOCAL_TRANSACTION_TEST_FAIL_AFTER = "2";
    try {
      await assert.rejects(
        () => pushSnapshots(c, [one, two], {}, "test"),
        /Injected/,
      );
    } finally {
      delete process.env.LOCAL_TRANSACTION_TEST_FAIL_AFTER;
    }
    assert.equal(await getMarketingRow(c, snapshotKey(one)), undefined);
    assert.equal(await getMarketingRow(c, snapshotKey(two)), undefined);
    assert.equal(
      await getMarketingRow(c, { PK: "METRICS", SK: seriesKey(one) }),
      undefined,
    );
  });
  it("rejects an invalid content brief, schedules one ordinary Task exactly once, filters and projects completion", async () => {
    assert.equal(
      (
        await request("POST", "/plans/test-plan/steps", {
          version: 3,
          title: "Missing brief",
          kind: "content",
          doneCriteria: "A URL works",
        })
      ).status,
      400,
    );
    const made = await request("POST", "/plans/test-plan/steps", {
      version: 3,
      title: "Synthetic outreach",
      kind: "outreach",
      doneCriteria: "Review proof",
      ownerId: "test-owner",
      targetUrl: "https://EXAMPLE.com/work?q=1#x",
      primaryKeyword: "keyword",
      goalRefs: ["search-clicks"],
    });
    assert.equal(made.status, 201, JSON.stringify(made));
    const s = made.body;
    assert.equal(s.targetUrl, "https://example.com/work");
    const scheduled = await request("POST", `/steps/${s.id}/schedule`, {
      version: 1,
      mode: "task",
      publishDate: "2026-12-01",
    });
    assert.equal(scheduled.status, 200, JSON.stringify(scheduled));
    assert.ok(scheduled.body.taskId);
    const scheduledTask = await getTask(c, scheduled.body.taskId);
    assert.deepEqual(scheduledTask?.proofRequirement, {
      type: "comment",
      required: true,
    });
    assert.equal(
      scheduledTask?.link,
      undefined,
      "A planned target is not publish proof",
    );
    const retry = await request("POST", `/steps/${s.id}/schedule`, {
      version: 1,
      mode: "task",
      publishDate: "2026-12-01",
    });
    assert.equal(retry.body.taskId, scheduled.body.taskId);
    const tasks = await listTasksByStatus(c, "todo");
    assert.equal(
      tasks.filter((t) => t.subject?.id === `test-plan:${s.id}`).length,
      1,
    );
    assert.equal(
      tasks.find((t) => t.id === scheduled.body.taskId)?.date,
      "2026-12-01",
    );
    const filtered = await request("GET", "/steps", undefined, {
      target_url: "example.com/work",
      primary_keyword: "key",
      done_criteria: "proof",
    });
    assert.equal(filtered.body.items.length, 1);
    const taskList = await handleTaskRoutes(
      "/api/tasks",
      "GET",
      {
        httpMethod: "GET",
        path: "/api/tasks",
        headers: { "x-user-id": "test-actor" },
        queryStringParameters: {
          status: "todo",
          target_url: "example.com/work",
          primary_keyword: "key",
          done_criteria: "proof",
        },
      },
      c,
    );
    assert.equal(taskList?.statusCode, 200);
    const visible = JSON.parse(taskList!.body).tasks;
    assert.ok(visible.some((t: any) => t.id === scheduled.body.taskId));
    assert.equal(
      visible.find((t: any) => t.id === scheduled.body.taskId).subject.href,
      `/marketing/steps/${s.id}`,
    );
    const utm = await request("GET", `/steps/${s.id}/utm`, undefined, {
      source: "linkedin",
    });
    assert.match(utm.body.url, /utm_medium=social/);
    assert.match(utm.body.url, new RegExp(`utm_content=${s.id}`));
    const task = (await getTask(c, scheduled.body.taskId))!;
    await updateTask(c, task.id, {
      expectedVersion: task.version,
      currentTask: task,
      patch: {
        status: "done",
        completedAt: "2026-12-01T12:00:00Z",
        completedBy: "test",
        comment: "Proof checked",
      },
    });
    assert.equal((await request("GET", `/steps/${s.id}`)).body.status, "done");
  });
  it("social steps link an existing campaign-calendar row and create no Task", async () => {
    const card = await createCard(c, {
      title: "Synthetic campaign",
      templateId: "course",
      templateVersion: 1,
      templateDefinitionSnapshot: { taskRefs: [] },
      selectedOptionalGroups: [],
      anchorDate: "2026-12-01",
    });
    const { createCampaignCalendarRow } = await import(
      "../src/db/campaignCalendar"
    );
    const row = await createCampaignCalendarRow(c, card.id, {
      title: "Synthetic social",
      status: "Planned",
      channel: "LinkedIn",
      format: "Post",
      date: "2026-12-02",
    } as any);
    const made = await request("POST", "/plans/test-plan/steps", {
      version: 3,
      title: "Synthetic social",
      kind: "social",
      doneCriteria: "Post live",
    });
    const s = made.body;
    assert.equal(
      (
        await request("POST", `/steps/${s.id}/schedule`, {
          version: 1,
          mode: "task",
          publishDate: "2026-12-02",
        })
      ).status,
      400,
    );
    const before = (await listTasksByStatus(c, "todo")).length;
    const linked = await request("POST", `/steps/${s.id}/schedule`, {
      version: 1,
      mode: "link",
      campaignRowId: row.id,
      publishDate: "2026-12-02",
    });
    assert.equal(linked.status, 200, JSON.stringify(linked));
    assert.equal(linked.body.campaignRowId, row.id);
    assert.equal((await listTasksByStatus(c, "todo")).length, before);
  });
  it("card mode creates one chain and pushes title, brief, target URL, tags and dates one way", async () => {
    const refs = ["research", "draft", "review", "publish", "verify"];
    await createTemplate(c, {
      name: "Synthetic marketing",
      type: "marketing-content",
      version: 1,
      taskDefinitions: refs.map((refId, i) => ({
        refId,
        description: refId,
        offsetDays: i - 3,
        ...(i ? { dependsOn: [refs[i - 1]] } : {}),
        proof: {
          type: refId === "publish" ? "url" : "comment",
          required: true,
        },
      })),
    });
    const made = await request("POST", "/plans/test-plan/steps", {
      version: 3,
      title: "Synthetic content",
      kind: "content",
      targetUrl: "https://example.com/content",
      targetType: "new",
      primaryKeyword: "test",
      doneCriteria: "Page live",
      brief: "Synthetic brief",
      tags: ["test"],
    });
    const s = made.body;
    const scheduled = await request("POST", `/steps/${s.id}/schedule`, {
      version: 1,
      mode: "card",
      publishDate: "2026-12-09",
    });
    assert.equal(scheduled.status, 200, JSON.stringify(scheduled));
    assert.ok(scheduled.body.publishTaskId);
    const { listTasksByCard } = await import("../src/db/tasks");
    const tasks = await listTasksByCard(c, scheduled.body.cardId);
    assert.equal(tasks.length, 5);
    assert.equal(
      tasks.find((t) => t.templateTaskRef === "verify")?.dependsOn?.[0],
      scheduled.body.publishTaskId,
    );
    const retry = await request("POST", `/steps/${s.id}/schedule`, {
      version: 1,
      mode: "card",
      publishDate: "2026-12-09",
    });
    assert.equal(retry.body.cardId, scheduled.body.cardId);
    const updated = await request("PATCH", `/steps/${s.id}`, {
      version: 2,
      title: "Updated synthetic title",
      brief: "Updated brief",
      targetUrl: "https://EXAMPLE.com/updated?discard=yes#fragment",
      tags: ["updated"],
      publishDate: "2026-12-10",
    });
    assert.equal(updated.status, 200, JSON.stringify(updated));
    const card = (await getCard(c, scheduled.body.cardId))!;
    assert.equal(card.title, "Updated synthetic title");
    assert.match(card.description || "", /Updated brief/);
    assert.ok(card.tags?.includes("updated"));
    assert.equal(
      card.cardLinks?.find((l) => l.name === "Target URL")?.url,
      "https://example.com/updated",
    );
    assert.equal(card.anchorDate, "2026-12-10");
    const newTasks = await listTasksByCard(c, card.id);
    assert.equal(
      newTasks.find((t) => t.templateTaskRef === "publish")?.date,
      "2026-12-10",
    );
    const linkStep = (
      await request("POST", "/plans/test-plan/steps", {
        version: 3,
        title: "Linked newsletter",
        kind: "newsletter",
        doneCriteria: "Send verified",
      })
    ).body;
    assert.equal(
      (
        await request("POST", `/steps/${linkStep.id}/schedule`, {
          version: 1,
          mode: "link",
          linkCardId: card.id,
          publishTaskId: scheduled.body.publishTaskId,
          publishDate: "2026-12-10",
        })
      ).status,
      200,
    );
  });
  it("technical live, drop, capacity warnings and review work without a new task system", async () => {
    const s = (
      await request("POST", "/plans/test-plan/steps", {
        version: 3,
        title: "Synthetic technical",
        kind: "technical",
        doneCriteria: "Deploy verified",
      })
    ).body;
    assert.equal(
      (
        await request("POST", `/steps/${s.id}/live`, {
          version: 1,
          url: "https://example.com/live",
          date: "2026-11-25",
        })
      ).status,
      200,
    );
    assert.equal(
      (await request("GET", `/steps/${s.id}`)).body.status,
      "published",
    );
    const review = await request("GET", "/review", undefined, {
      week: "2026-W49",
    });
    assert.equal(review.status, 200, JSON.stringify(review));
    assert.equal(review.body.capacity.weeklyLimit, 2);
    for (const title of ["Second review", "Third review"]) {
      const step = (
        await request("POST", "/plans/test-plan/steps", {
          version: 3,
          title,
          kind: "content",
          targetUrl: "https://example.com/review",
          targetType: "new",
          primaryKeyword: "review",
          doneCriteria: "Published",
        })
      ).body;
      const scheduled = await request("POST", `/steps/${step.id}/schedule`, {
        version: 1,
        mode: "card",
        publishDate: "2026-12-10",
      });
      assert.equal(scheduled.status, 200, JSON.stringify(scheduled));
    }
    const cap = await request("GET", "/capacity", undefined, { weeks: "8" });
    assert.equal(cap.body.items.length, 8);
    assert.equal(
      cap.body.items.find((r: any) => r.week === "2026-W50").reviews,
      3,
    );
    assert.equal(
      cap.body.items.find((r: any) => r.week === "2026-W50").warning,
      true,
    );
    assert.equal(
      (
        await request("POST", `/steps/${s.id}/drop`, {
          version: 2,
          reason: "Synthetic test ended",
        })
      ).status,
      200,
    );
    assert.equal(
      (await request("GET", `/steps/${s.id}`)).body.status,
      "dropped",
    );
  });
  it("reads newsletter_clicks from existing newsletter statistics with source dataops", async () => {
    const { createNewsletterIssue, buildNewsletterIssue } = await import(
      "../src/db/newsletterIssues"
    );
    await createNewsletterIssue(
      c,
      buildNewsletterIssue(
        {
          kind: "weekly",
          publicationDate: "2026-11-24",
          title: "Synthetic newsletter",
          stats: { clicks: 42, recordedAt: "2026-11-25" },
          slots: [],
        } as any,
        "test-newsletter",
      ),
    );
    const rows = await seriesSnapshots(
      c,
      {
        metricKey: "newsletter_clicks",
        scope: "issue:test-newsletter",
        source: "dataops",
      },
      "2026-11-23",
      "2026-11-29",
    );
    assert.equal(rows.find((s) => s.period === "2026-W48")?.value, 42);
  });
  it("imports canonical plans idempotently by stable step key and validates before mutating", async () => {
    const input = {
      plan: { id: "import-test", title: "Synthetic import" },
      goals: [{ ...goal, baseline: null, target: null }],
      steps: [
        {
          key: "outreach-one",
          title: "Imported outreach",
          kind: "outreach",
          doneCriteria: "Proof recorded",
        },
      ],
    };
    const first = await request("POST", "/import", input);
    assert.equal(first.status, 200, JSON.stringify(first));
    const deferred = (
      await request("GET", "/plans/import-test/goals/search-clicks")
    ).body;
    assert.equal(deferred.baseline, null);
    assert.equal(deferred.target, null);
    assert.equal(deferred.calibrationRequired, true);
    const second = await request("POST", "/import", {
      ...input,
      version: first.body.plan.version,
    });
    assert.equal(second.status, 200, JSON.stringify(second));
    assert.equal(second.body.steps[0].id, first.body.steps[0].id);
    assert.equal(
      (await request("GET", "/steps", undefined, { plan: "import-test" })).body
        .items.length,
      1,
    );
    const invalid = await request("POST", "/import", {
      ...input,
      version: second.body.plan.version,
      steps: [{ key: "bad" }],
    });
    assert.equal(invalid.status, 400);
    assert.equal(
      (await request("GET", "/plans/import-test")).body.version,
      second.body.plan.version,
    );
    const calibrated = await request(
      "PATCH", "/plans/import-test/goals/search-clicks",
      {
        version: second.body.plan.version,
        baseline: goal.baseline,
        target: goal.target,
      },
    );
    assert.equal(calibrated.status, 200, JSON.stringify(calibrated));
    assert.deepEqual(calibrated.body.goals[0].baseline, goal.baseline);
    assert.deepEqual(calibrated.body.goals[0].target, goal.target);
  });
});

it("defers unmeasured goals without inventing a baseline, target or progress", () => {
  const deferred = { ...goal, baseline: null, target: null };
  validateGoal(deferred);
  assert.equal(goalProgress(deferred, []).calibrationRequired, true);
  const progress = goalProgress(
    deferred, [{ ...snapshot, period: "2026-W48" }], new Date("2026-11-25"),
  );
  assert.equal(progress.status, "no-data");
  assert.equal(progress.value, 10);
  assert.equal(progress.expected, null);
  assert.equal(progress.calibrationRequired, true);
  assert.throws(() => validateGoal({ ...goal, baseline: null }), /Defer both/);
  assert.throws(
    () => validateGoal({ ...goal, baseline: undefined } as any), /Invalid baseline/,
  );
  validateGoal(goal);
  assert.notEqual(
    goalProgress(goal, [{ ...snapshot, period: "2026-W48" }], new Date("2026-11-25")).status,
    "no-data",
  );
});

it("uses weekly versus monthly staleness from the metric period, supports rolling values and lower-is-better", () => {
  const weekly = { ...snapshot, scope: "site", period: "2026-W45" };
  assert.equal(
    goalProgress(goal, [weekly], new Date("2026-11-25")).status,
    "no-data",
  );
  const monthly = {
    ...snapshot,
    metricKey: "moz_da",
    source: "treg-moz",
    scope: "domain:example.com",
    unit: "score",
    period: "2026-10",
    value: 34,
  };
  assert.notEqual(
    goalProgress(
      { ...goal, metricKey: "moz_da" },
      [monthly],
      new Date("2026-11-25"),
    ).status,
    "no-data",
  );
  assert.equal(
    goalProgress(
      { ...goal, window: "rolling28" },
      [
        { ...snapshot, period: "2026-W47" },
        { ...snapshot, period: "2026-W48", value: 20 },
      ],
      new Date("2026-11-25"),
    ).value,
    30,
  );
  assert.throws(() => periodRange("2026-W54"), /Invalid ISO week/);
});
it("cards:write grants marketing and the existing task/card/file paths while unrelated scopes do not", () => {
  for (const path of [
    "/api/marketing/plans",
    "/api/marketing/metrics/batch",
    "/api/tasks",
    "/api/cards",
    "/api/files",
  ])
    assert.equal(
      isScopedTokenRequestAllowed(["cards:write"], "POST", path),
      true,
      path,
    );
  assert.equal(
    isScopedTokenRequestAllowed(
      ["newsletter:write"],
      "POST",
      "/api/marketing/plans",
    ),
    false,
  );
});

it("derives Academy visits from existing PV counters, excluding test traffic and respecting date/UTM scopes", () => {
  const rows = [
    {
      pk: "PV#2026-11-24",
      sk: "https://example.com/academy/ai-engineering|newsletter|email|plan-one|s-one",
      count: 7,
    },
    {
      pk: "PV#2026-11-25",
      sk: "https://example.com/academy/ai-engineering|test|email|plan-one|s-one",
      count: 99,
    },
    {
      pk: "PV#2026-11-24",
      sk: "https://example.com/academy/ai-engineering|linkedin|social|plan-two|s-two",
      count: 3,
    },
    {
      pk: "PV#2026-10-01",
      sk: "https://example.com/academy/ai-engineering|newsletter|email|plan-one|s-one",
      count: 100,
    },
    { pk: "SIGNUP#redacted", sk: "not a pageview", count: 99 },
  ];
  assert.equal(
    accumulateAcademyVisits(rows, "track:all", "2026-11-23", "2026-11-29").get(
      "2026-W48",
    ),
    10,
  );
  assert.equal(
    accumulateAcademyVisits(rows, "site", "2026-11-23", "2026-11-29").get(
      "2026-W48",
    ),
    10,
  );
  assert.equal(
    accumulateAcademyVisits(
      rows,
      "utm_content:s-one",
      "2026-11-23",
      "2026-11-29",
    ).get("2026-W48"),
    7,
  );
  assert.equal(
    accumulateAcademyVisits(
      rows,
      "prefix:https://example.com/academy/",
      "2026-11-23",
      "2026-11-29",
    ).get("2026-W48"),
    10,
  );
});
