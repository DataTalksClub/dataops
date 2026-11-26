import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isolateConfig, fakePortal } from "./helpers.mjs";
isolateConfig();
const marketing = await import("../src/commands/marketing.mjs");
const io = { print() {} };
test("marketing CLI explicitly defers and later calibrates goals through the API", async () => {
  fakePortal({
    "POST /api/marketing/plans/deferred-plan/goals": ({ body }) => body,
    "PATCH /api/marketing/plans/deferred-plan/goals/search-clicks": ({ body }) => body,
  });
  const deferred = await marketing.goals({
    _: ["add", "deferred-plan"], version: "1", ref: "search-clicks",
    baseline: "deferred", target: "deferred",
  }, io);
  assert.equal(deferred.baseline, null);
  assert.equal(deferred.target, null);
  const measured = await marketing.goals({
    _: ["update", "deferred-plan", "search-clicks"], version: "2",
    baseline: "5@2026-11-25", baselineNote: "First measurement",
    target: "10@2027-01-01",
  }, io);
  assert.equal(measured.baseline.value, 5);
  assert.equal(measured.target.value, 10);
});
test("marketing CLI calls the shared API with explicit versions and canonical fields", async () => {
  const calls = fakePortal({
    "POST /api/marketing/plans": ({ body }) => ({ ...body, version: 1 }),
    "PATCH /api/marketing/plans/cli-plan": ({ body }) => ({
      ...body,
      version: 3,
    }),
    "POST /api/marketing/plans/cli-plan/notes": ({ body }) => body,
    "POST /api/marketing/plans/cli-plan/goals": ({ body }) => body,
    "DELETE /api/marketing/plans/cli-plan/goals/clicks": ({ body }) => body,
    "POST /api/marketing/plans/cli-plan/steps": ({ body }) => ({
      ...body,
      id: "s-test",
    }),
    "POST /api/marketing/steps/s-test/schedule": ({ body }) => body,
    "GET /api/marketing/steps": ({ query }) => ({ items: [], query }),
    "GET /api/marketing/steps/s-test/utm": ({ query }) => ({
      url: "https://example.com/",
      query,
    }),
    "POST /api/marketing/metrics": ({ body }) => body,
    "POST /api/marketing/metrics/batch": ({ body }) => body,
    "GET /api/marketing/metrics": ({ query }) => ({ items: [], query }),
    "POST /api/marketing/import": ({ body }) => ({
      plan: body.plan,
      steps: body.steps,
    }),
  });
  const plan = await marketing.plans(
    {
      _: ["create"],
      id: "cli-plan",
      title: "CLI plan",
      owner: "operator",
      tags: "one,two",
      start: "2026-11-25",
      json: true,
    },
    io,
  );
  assert.equal(plan.ownerId, "operator");
  assert.deepEqual(plan.tags, ["one", "two"]);
  assert.equal(plan.startDate, "2026-11-25");
  await marketing.plans(
    { _: ["update", "cli-plan"], version: "2", status: "active", json: true },
    io,
  );
  assert.equal(calls.at(-1).body.version, 2);
  await assert.rejects(
    () =>
      marketing.plans(
        { _: ["update", "cli-plan"], title: "Unsafe", json: true },
        io,
      ),
    /--version is required/,
  );
  const goal = await marketing.goals(
    {
      _: ["add", "cli-plan"],
      version: "3",
      ref: "clicks",
      title: "Clicks",
      metric: "gsc_nonbrand_clicks",
      scope: "site",
      source: "gsc",
      baseline: "0@2026-11-25",
      baselineNote: "Measured",
      target: "100@2027-02-01",
      json: true,
    },
    io,
  );
  assert.equal(goal.metricKey, "gsc_nonbrand_clicks");
  assert.deepEqual(goal.baseline, {
    value: 0,
    date: "2026-11-25",
    note: "Measured",
  });
  assert.equal(goal.version, 3);
  const step = await marketing.steps(
    {
      _: ["add", "cli-plan"],
      version: "4",
      title: "Work",
      kind: "refresh",
      targetUrl: "https://example.com/",
      targetType: "refresh",
      primaryKeyword: "test",
      doneCriteria: "Live",
      goals: "clicks",
      json: true,
    },
    io,
  );
  assert.deepEqual(step.goalRefs, ["clicks"]);
  assert.equal(step.doneCriteria, "Live");
  const scheduled = await marketing.steps(
    {
      _: ["schedule", "s-test"],
      version: "1",
      publishDate: "2026-12-01",
      campaignRow: "row-1",
      json: true,
    },
    io,
  );
  assert.equal(scheduled.mode, "link");
  assert.equal(scheduled.campaignRowId, "row-1");
  assert.equal(scheduled.version, 1);
  const listed = await marketing.steps(
    {
      _: ["list"],
      targetUrl: "https://example.com/",
      primaryKeyword: "test",
      doneCriteria: "Live",
      published: true,
      json: true,
    },
    io,
  );
  assert.equal(listed.query.target_url, "https://example.com/");
  assert.equal(listed.query.primary_keyword, "test");
  assert.equal(listed.query.published, "true");
  const metric = await marketing.metrics(
    {
      _: ["push"],
      metric: "bing_clicks",
      scope: "site",
      source: "manual",
      period: "2026-W48",
      value: "12",
      unit: "count",
      json: true,
    },
    io,
  );
  assert.equal(metric.value, 12);
  assert.equal(metric.metricKey, "bing_clicks");
  const folder = mkdtempSync(path.join(tmpdir(), "dataops-marketing-cli-"));
  const file = path.join(folder, "metrics.json");
  writeFileSync(
    file,
    JSON.stringify({
      snapshots: [
        {
          metricKey: "bing_clicks",
          scope: "site",
          source: "manual",
          period: "2026-W48",
          value: 12,
          unit: "count",
        },
      ],
    }),
  );
  const batch = await marketing.metrics(
    { _: ["push"], file, replace: true, json: true },
    io,
  );
  assert.equal(batch.snapshots[0].value, 12);
  assert.equal(batch.replace, true);
  const seed = path.join(folder, "plan.json");
  writeFileSync(
    seed,
    JSON.stringify({
      plan: { id: "cli-plan", title: "CLI plan" },
      goals: [],
      steps: [
        { key: "one", kind: "outreach", title: "One", doneCriteria: "Done" },
      ],
    }),
  );
  await marketing.importPlan(
    { _: [], file: seed, version: "4", dryRun: true, json: true },
    io,
  );
  assert.equal(calls.at(-1).body.version, 4);
  assert.equal(calls.at(-1).body.dryRun, true);
  await marketing.commands.utm(
    { _: ["s-test"], source: "linkedin", json: true },
    io,
  );
  assert.equal(calls.at(-1).query.source, "linkedin");
});

test("ordinary tasks list forwards marketing brief filters to the shared task API", async () => {
  const tasks = await import("../src/commands/tasks.mjs");
  const calls = fakePortal({ "GET /api/tasks": { tasks: [] } });
  await tasks.list(
    {
      _: [],
      status: "todo",
      targetUrl: "example.com",
      primaryKeyword: "keyword",
      doneCriteria: "proof",
      json: true,
    },
    io,
  );
  assert.equal(calls[0].query.target_url, "example.com");
  assert.equal(calls[0].query.primary_keyword, "keyword");
  assert.equal(calls[0].query.done_criteria, "proof");
});

test("YAML imports preserve unquoted civil dates as API date strings", async () => {
  const folder = mkdtempSync(path.join(tmpdir(), "dataops-marketing-yaml-"));
  const file = path.join(folder, "plan.yaml");
  writeFileSync(
    file,
    "plan:\n  id: yaml-plan\n  title: YAML plan\n  startDate: 2026-12-01\n  endDate: 2027-02-28\ngoals: []\nsteps: []\n",
  );
  const calls = fakePortal({
    "POST /api/marketing/import": ({ body }) => body,
  });
  await marketing.importPlan({ _: [], file, dryRun: true, json: true }, io);
  assert.equal(calls[0].body.plan.startDate, "2026-12-01");
  assert.equal(calls[0].body.plan.endDate, "2027-02-28");
});

test("marketing CLI manages tracked sites, authority evidence and backlink audit seed/check", async () => {
  const folder = mkdtempSync(path.join(tmpdir(), "dataops-marketing-bl-"));
  const seedFile = path.join(folder, "seed.txt");
  writeFileSync(
    seedFile,
    [
      "0=https://example.org/",
      "1=https://example.org/blog/guide.html",
      "0 alexey_sent https://partner.example/article",
      "1 orin_sent https://partner.example/article",
    ].join("\n"),
  );
  const calls = fakePortal({
    "GET /api/marketing/sites": { items: [{ domain: "example.org", authority: [] }], ahrefsConfigured: false },
    "POST /api/marketing/sites": ({ body }) => ({ ...body, version: 1 }),
    "POST /api/marketing/sites/example.org/refresh-authority": { status: "unavailable", reason: "No token" },
    "POST /api/marketing/metrics": ({ body }) => body,
    "POST /api/marketing/backlinks": ({ body }) => ({ inserted: body.items.length, items: body.items }),
    "GET /api/marketing/backlinks": {
      items: [{ id: "bl-1" }, { id: "bl-2" }],
      summary: { total: 2, added_follow: 1, added_qualified: 0, absent: 1, unavailable: 0, unchecked: 0 },
      groups: {},
    },
    "POST /api/marketing/backlinks/check": ({ body }) => ({
      checked: body.ids.length,
      summary: { total: 2, added_follow: 1, added_qualified: 0, absent: 1, unavailable: 0, unchecked: 0 },
      groups: {},
    }),
  });

  await marketing.sites({ _: ["add"], domain: "example.org", label: "Example", json: true }, io);
  await marketing.sites({ _: ["refresh-authority", "example.org"], json: true }, io);
  await marketing.metrics(
    {
      _: ["push"],
      metric: "domain_rating",
      scope: "domain:example.org",
      source: "ahrefs-free",
      date: "2026-11-26",
      value: "57",
      observedAt: "2026-11-26T10:00:00Z",
      evidenceUrl: "https://ahrefs.com/website-authority-checker/?input=example.org",
      provider: "ahrefs",
      metricVersion: "unexposed",
      json: true,
    },
    io,
  );
  await marketing.backlinks({ _: ["import"], file: seedFile, json: true }, io);
  await marketing.backlinks({ _: ["check"], chunkSize: "1", json: true }, io);

  const metricPush = calls.find((c) => c.route === "/api/marketing/metrics");
  assert.equal(metricPush.body.provider, "ahrefs");
  assert.equal(metricPush.body.metricVersion, "unexposed");
  const blImport = calls.find((c) => c.route === "/api/marketing/backlinks" && c.method === "POST");
  assert.equal(blImport.body.items.length, 2);
  assert.equal(blImport.body.items[0].owner, "alexey");
  assert.equal(blImport.body.items[1].owner, "orin");
  const checkCalls = calls.filter((c) => c.route === "/api/marketing/backlinks/check");
  assert.equal(checkCalls.length, 2);
});
