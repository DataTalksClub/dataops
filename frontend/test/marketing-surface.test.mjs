import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { parseWorkspaceLocation, WORKSPACE_PATH_BY_VIEW, WORKSPACE_ROUTE_DEFINITIONS } from "../src/core/workspace.js";
import { SELF_LOADING_VIEWS } from "../src/shell/startup-orchestration.js";
import { goalChartMarkup, sparklineSvg } from "../src/surfaces/marketing/charts.js";
import { goalDetailMarkup, stepDetailMarkup } from "../src/surfaces/marketing/detail.js";
import { createMarketingSurface } from "../src/surfaces/marketing/index.js";
import { filterStepsByTab, planDetailMarkup, planListMarkup } from "../src/surfaces/marketing/plans.js";
import { ALEXEY_WEEKLY_REVIEW_LIMIT, weeklyReviewMarkup } from "../src/surfaces/marketing/review.js";
import { FakeDocument, FakeElement, nextTicks } from "./support/fake-dom.mjs";

function surfaceHarness(request, route) {
  const root = new FakeElement("main");
  const documentRef = new FakeDocument(root);
  const titles = [];
  const navigations = [];
  const surface = createMarketingSurface({
    apiUrl: (p) => p,
    documentList: root,
    documentRef,
    getActiveWorkspaceRoute: () => route,
    navigateCanonicalWorkspace: (dest) => navigations.push(dest),
    request,
    setRouteTitle: (t) => titles.push(t),
    todayIsoDate: () => "2026-11-25",
    workApiUrl: (p, query = {}) => {
      const search = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== "" && v !== undefined && v !== null) search.set(k, String(v));
      }
      return `${p}${search.toString() ? `?${search}` : ""}`;
    },
  });
  return { root, titles, navigations, surface };
}

describe("marketing navigation and routes", () => {
  test("index.html places Marketing nav group between Operations and Knowledge with one item", () => {
    const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const opsIdx = html.indexOf('<h2 class="dk-nav-group__label">Operations</h2>');
    const mktIdx = html.indexOf('<h2 class="dk-nav-group__label">Marketing</h2>');
    const knowIdx = html.indexOf('<h2 class="dk-nav-group__label">Knowledge</h2>');
    assert.ok(opsIdx > 0 && mktIdx > opsIdx && knowIdx > mktIdx);
    const mktGroup = html.slice(mktIdx, knowIdx);
    const items = mktGroup.match(/class="dk-nav-item\b/g) || [];
    assert.equal(items.length, 1);
    assert.match(mktGroup, /href="\/marketing"/);
    assert.match(mktGroup, /data-workspace-view="marketing"/);
  });

  test("registers all marketing routes and marks marketing as self-loading", () => {
    assert.equal(WORKSPACE_PATH_BY_VIEW.marketing, "/marketing");
    assert.ok(SELF_LOADING_VIEWS.has("marketing"));
    for (const pattern of [
      "/marketing",
      "/marketing/plans/:planId",
      "/marketing/plans/:planId/goals/:goalRef",
      "/marketing/steps/:stepId",
      "/marketing/review",
    ]) {
      assert.equal(WORKSPACE_ROUTE_DEFINITIONS[pattern]?.view, "marketing");
    }
    const planRoute = parseWorkspaceLocation("/marketing/plans/academy-visibility");
    assert.equal(planRoute.view, "marketing");
    assert.equal(planRoute.params.get("planId"), "academy-visibility");

    const goalRoute = parseWorkspaceLocation("/marketing/plans/academy-visibility/goals/nonbrand-impressions");
    assert.equal(goalRoute.params.get("planId"), "academy-visibility");
    assert.equal(goalRoute.params.get("goalRef"), "nonbrand-impressions");

    const stepRoute = parseWorkspaceLocation("/marketing/steps/s-1a2b3c4d");
    assert.equal(stepRoute.params.get("stepId"), "s-1a2b3c4d");

    const reviewRoute = parseWorkspaceLocation("/marketing/review?week=2026-W49");
    assert.equal(reviewRoute.params.get("week"), "2026-W49");
  });
});

describe("marketing markup and charts", () => {
  test("plan list renders plans, goal chips, and empty/error states", () => {
    const empty = planListMarkup([], "2026-11-25");
    assert.match(empty, /No marketing plans yet/);

    const withErr = planListMarkup([], "2026-11-25", "Marketing API is not available yet (404).");
    assert.match(withErr, /Marketing API is not available yet \(404\)/);

    const html = planListMarkup(
      [
        {
          id: "academy-visibility",
          title: "Academy Visibility",
          status: "active",
          ownerId: "marketer",
          startDate: "2026-12-01",
          endDate: "2027-02-28",
          stepsDueThisWeek: 2,
          lastSnapshotDate: "2026-11-22",
          goals: [{ ref: "nonbrand", title: "Non-brand impr.", status: "at-risk" }],
        },
      ],
      "2026-11-25",
    );
    assert.match(html, /\/marketing\/plans\/academy-visibility/);
    assert.match(html, /Academy Visibility/);
    assert.match(html, /3 days old/);
    assert.match(html, /at risk/);
  });

  test("plan page renders inline SVG sparklines for goals and filters steps by tab", () => {
    const snapshots = [
      { periodEnd: "2026-11-09", value: 25, unit: "count" },
      { periodEnd: "2026-11-16", value: 33, unit: "count" },
      { periodEnd: "2026-11-23", value: 41, unit: "count" },
    ];
    const goal = {
      ref: "nonbrand-impressions",
      title: "Non-brand impressions on /academy/",
      metricKey: "gsc_nonbrand_impressions",
      scope: "prefix:/academy/",
      source: "gsc",
      target: { value: 100, date: "2027-02-28" },
      status: "at-risk",
    };
    const spark = sparklineSvg(snapshots, goal);
    assert.match(spark, /<svg class="mkt-sparkline"/);
    assert.match(spark, /<polyline class="mkt-sparkline__line"/);
    assert.match(spark, /<line class="mkt-sparkline__target"/);

    const steps = [
      { id: "s-11111111", title: "Planned post", kind: "content", size: "L", status: "planned" },
      { id: "s-22222222", title: "Scheduled refresh", kind: "refresh", size: "S", status: "scheduled", publishDate: "2026-12-04" },
      { id: "s-33333333", title: "Published guide", kind: "technical", status: "published", publishDate: "2026-11-20" },
    ];
    assert.equal(filterStepsByTab(steps, "all").length, 3);
    assert.equal(filterStepsByTab(steps, "planned").length, 1);
    assert.equal(filterStepsByTab(steps, "scheduled").length, 1);
    assert.equal(filterStepsByTab(steps, "published").length, 1);

    const seriesMap = new Map([["gsc_nonbrand_impressions|prefix:/academy/|gsc", snapshots]]);
    const html = planDetailMarkup(
      {
        id: "academy-visibility",
        title: "Academy Visibility",
        status: "active",
        ownerId: "marketer",
        goals: [goal],
        notesLog: [{ id: "n1", createdAt: "2026-11-25", ref: "t390u", text: "Track keywords" }],
      },
      steps,
      seriesMap,
      "all",
    );
    assert.match(html, /mkt-sparkline/);
    assert.match(html, /Planned post/);
    assert.match(html, /Track keywords/);
  });

  test("goal detail page renders full inline SVG chart with baseline, target, and publish markers", () => {
    const snapshots = [
      { periodStart: "2026-11-02", periodEnd: "2026-11-08", value: 25, unit: "count", source: "gsc" },
      { periodStart: "2026-11-09", periodEnd: "2026-11-15", value: 33, unit: "count", source: "gsc" },
      { periodStart: "2026-11-16", periodEnd: "2026-11-22", value: 41, unit: "count", source: "gsc", provisional: true },
    ];
    const goal = {
      ref: "nonbrand-impressions",
      title: "Non-brand impressions",
      metricKey: "gsc_nonbrand_impressions",
      scope: "prefix:/academy/",
      source: "gsc",
      baseline: { value: 20, date: "2026-11-01", note: "GSC export" },
      target: { value: 100, date: "2027-02-28" },
      status: "at-risk",
    };
    const chart = goalChartMarkup(snapshots, goal, [
      { id: "s-1a2b3c4d", title: "Comparison page", publishedAt: "2026-11-12" },
    ]);
    assert.match(chart, /<figure class="mkt-chart">/);
    assert.match(chart, /mkt-chart__baseline/);
    assert.match(chart, /mkt-chart__target/);
    assert.match(chart, /mkt-chart__marker/);
    assert.match(chart, /Comparison page/);

    const page = goalDetailMarkup({ id: "academy-visibility", title: "Academy Visibility" }, goal, snapshots);
    assert.match(page, /Snapshots/);
    assert.match(page, /provisional/);
  });

  test("step detail page renders brief fields and execution forms", () => {
    const html = stepDetailMarkup(
      {
        id: "s-1a2b3c4d",
        planId: "academy-visibility",
        title: "Refresh free DE courses",
        kind: "refresh",
        size: "S",
        ownerId: "orin",
        targetUrl: "https://datatalks.club/blog/free-de-courses",
        targetType: "refresh",
        primaryKeyword: "free data engineering courses",
        doneCriteria: "Page refreshed and indexed",
        prompts: ["P02", "P14"],
        goalRefs: ["nonbrand-impressions"],
        brief: "Add internal links to /academy/",
        status: "planned",
      },
      { id: "academy-visibility", title: "Academy Visibility" },
      "https://datatalks.club/blog/free-de-courses?utm_source=linkedin&utm_medium=social&utm_campaign=academy-visibility&utm_content=s-1a2b3c4d",
    );
    assert.match(html, /free data engineering courses/);
    assert.match(html, /Page refreshed and indexed/);
    assert.match(html, /P02/);
    assert.match(html, /data-mkt-schedule-form/);
    assert.match(html, /utm_content=s-1a2b3c4d/);
  });

  test("weekly review renders missing data, goals, work lists, and warns when reviews exceed limit 2", () => {
    assert.equal(ALEXEY_WEEKLY_REVIEW_LIMIT, 2);
    const html = weeklyReviewMarkup(
      {
        week: "2026-W49",
        weekStart: "2026-11-30",
        weekEnd: "2026-12-06",
        dataAsOf: "2026-12-09",
        missingData: [{ metricKey: "bing_clicks", source: "bing" }],
        goals: [
          {
            planId: "academy-visibility",
            planTitle: "Academy Visibility",
            ref: "nonbrand-impressions",
            goalTitle: "Non-brand impr.",
            previousValue: 33,
            currentValue: 41,
            delta: 8,
            status: "at-risk",
          },
        ],
        shippedLastWeek: [{ id: "s-1", title: "Shipped guide", publishDate: "2026-12-02" }],
        dueThisWeek: [],
        overdue: [{ id: "s-2", title: "Overdue pass", publishDate: "2026-11-28" }],
        needsDecision: [{ planId: "academy-visibility", goalRef: "aio", goalTitle: "Google AIO", reason: "off-track 2w", proposal: "Add FAQ" }],
      },
      { alexeyReviews: 3 },
    );
    assert.match(html, /bing_clicks/);
    assert.match(html, /Shipped guide/);
    assert.match(html, /Overdue pass/);
    assert.match(html, /weekly limit 2 — over capacity/);
    assert.match(html, /is-over-limit/);
  });
});

describe("marketing surface controller", () => {
  test("loads plan list and handles 404 gracefully without crashing", async () => {
    const { root, surface } = surfaceHarness(
      async () => {
        const err = new Error("HTTP 404 Not Found");
        err.status = 404;
        throw err;
      },
      { path: "/marketing", pathParams: {}, params: new URLSearchParams() },
    );
    await surface.renderMarketingSurface();
    await nextTicks();
    const bodyHtml = root.children[0].children[0].innerHTML;
    assert.match(bodyHtml, /Marketing API is not available yet \(404\)/);
  });

  test("renders plan detail route by fetching plan, steps, and goal metrics", async () => {
    const calls = [];
    const { root, titles, surface } = surfaceHarness(
      async (url) => {
        calls.push(url);
        if (url === "/api/marketing/plans/academy-visibility") {
          return {
            plan: {
              id: "academy-visibility",
              title: "Academy Visibility",
              status: "active",
              goals: [
                {
                  ref: "nonbrand",
                  title: "Non-brand impr.",
                  metricKey: "gsc_nonbrand_impressions",
                  scope: "prefix:/academy/",
                  source: "gsc",
                  target: { value: 100, date: "2027-02-28" },
                  status: "at-risk",
                },
              ],
            },
          };
        }
        if (url.startsWith("/api/marketing/steps")) {
          return { steps: [{ id: "s-1a2b3c4d", title: "Comparison page", kind: "content", size: "L", status: "planned" }] };
        }
        if (url.startsWith("/api/marketing/metrics")) {
          return { snapshots: [{ periodEnd: "2026-11-23", value: 41, unit: "count" }] };
        }
        return {};
      },
      { path: "/marketing/plans/academy-visibility", params: new URLSearchParams({ planId: "academy-visibility" }) },
    );

    await surface.renderMarketingSurface();
    await nextTicks();
    assert.ok(titles.includes("Marketing · Academy Visibility"));
    const bodyHtml = root.children[0].children[0].innerHTML;
    assert.match(bodyHtml, /Comparison page/);
    assert.match(bodyHtml, /mkt-sparkline/);
    assert.equal(calls.length, 3);
  });

  test("renders goal detail, step detail, and weekly review routes", async () => {
    const { root: goalRoot, titles: goalTitles, surface: goalSurface } = surfaceHarness(
      async (url) => {
        if (url.includes("/goals/")) {
          return {
            goal: {
              ref: "nonbrand",
              title: "Non-brand impr.",
              metricKey: "gsc_nonbrand_impressions",
              scope: "prefix:/academy/",
              source: "gsc",
              target: { value: 100, date: "2027-02-28" },
            },
            snapshots: [{ periodEnd: "2026-11-23", value: 41, unit: "count" }],
          };
        }
        if (url.startsWith("/api/marketing/steps")) {
          return { steps: [{ id: "s-1", title: "Published step", status: "published", publishedAt: "2026-11-20" }] };
        }
        return { plan: { id: "academy-visibility", title: "Academy Visibility" } };
      },
      { path: "/marketing/plans/academy-visibility/goals/nonbrand", params: new URLSearchParams({ planId: "academy-visibility", goalRef: "nonbrand" }) },
    );
    await goalSurface.renderMarketingSurface();
    await nextTicks();
    assert.ok(goalTitles.includes("Marketing · Non-brand impr."));
    assert.match(goalRoot.children[0].children[0].innerHTML, /mkt-chart/);

    const { root: stepRoot, titles: stepTitles, surface: stepSurface } = surfaceHarness(
      async (url) => {
        if (url.startsWith("/api/marketing/steps/")) {
          return {
            step: {
              id: "s-1a2b3c4d",
              planId: "academy-visibility",
              title: "Refresh guide",
              kind: "refresh",
              doneCriteria: "Indexed",
              status: "planned",
              targetUrl: "https://datatalks.club/academy/",
            },
          };
        }
        return { plan: { id: "academy-visibility", title: "Academy Visibility" } };
      },
      { path: "/marketing/steps/s-1a2b3c4d", params: new URLSearchParams({ stepId: "s-1a2b3c4d" }) },
    );
    await stepSurface.renderMarketingSurface();
    await nextTicks();
    assert.ok(stepTitles.includes("Marketing · Refresh guide"));
    assert.match(stepRoot.children[0].children[0].innerHTML, /Refresh guide/);

    const { root: reviewRoot, titles: reviewTitles, surface: reviewSurface } = surfaceHarness(
      async (url) => {
        if (url.startsWith("/api/marketing/review")) {
          return {
            week: "2026-W49",
            goals: [],
            shippedLastWeek: [],
            dueThisWeek: [],
            overdue: [],
          };
        }
        return { alexeyReviews: 2 };
      },
      { path: "/marketing/review", params: new URLSearchParams() },
    );
    await reviewSurface.renderMarketingSurface();
    await nextTicks();
    assert.ok(reviewTitles.includes("Marketing · Weekly Review"));
    assert.match(reviewRoot.children[0].children[0].innerHTML, /Weekly Marketing Review · 2026-W49/);
  });

  test("handles click interactions and form submissions on marketing surface", async () => {
    const requests = [];
    const { root, navigations, surface } = surfaceHarness(
      async (url, opts) => {
        requests.push([url, opts?.method || "GET"]);
        if (url === "/api/marketing/plans" && !opts?.method) {
          return { plans: [{ id: "academy-visibility", title: "Academy Visibility", status: "active", goals: [] }] };
        }
        if (url === "/api/marketing/plans/academy-visibility") {
          return {
            plan: { id: "academy-visibility", title: "Academy Visibility", status: "active", goals: [] },
            steps: [{ id: "s-1", title: "Step 1", kind: "content", size: "S", status: "planned" }],
          };
        }
        return {};
      },
      { path: "/marketing/plans/academy-visibility", params: new URLSearchParams({ planId: "academy-visibility" }) },
    );
    await surface.renderMarketingSurface();
    await nextTicks();

    const section = root.children[0];
    // Click nav link
    let prevented = false;
    await section.dispatch("click", {
      button: 0,
      target: { closest: (sel) => (sel === "a[data-mkt-nav]" ? { getAttribute: () => "/marketing/review" } : null) },
      preventDefault: () => { prevented = true; },
    });
    assert.equal(prevented, true);
    assert.deepEqual(navigations, ["/marketing/review"]);

    // Click step tab
    await section.dispatch("click", {
      button: 0,
      target: { closest: (sel) => (sel === "[data-mkt-step-tab]" ? { getAttribute: () => "planned" } : null) },
    });

    // Submit note, new-plan, and add-step forms
    const originalFormData = globalThis.FormData;
    globalThis.FormData = class {
      constructor(form) { this.data = form._data; }
      get(k) { return this.data[k]; }
    };
    try {
      await section.dispatch("submit", {
        target: {
          matches: (sel) => sel === "[data-mkt-note-form]",
          _data: { text: "Checked GSC", ref: "t390u" },
        },
      });
      await section.dispatch("submit", {
        target: {
          matches: (sel) => sel === "[data-mkt-new-plan-form]",
          closest: () => ({ close: () => {} }),
          _data: { id: "new-plan", title: "New Plan", tags: "seo, academy", objective: "Grow", startDate: "2026-12-01", endDate: "2027-02-28" },
        },
      });
      await section.dispatch("submit", {
        target: {
          matches: (sel) => sel === "[data-mkt-add-step-form]",
          closest: () => ({ close: () => {} }),
          _data: { title: "New Step", kind: "content", size: "S", doneCriteria: "Live", targetUrl: "https://datatalks.club/", primaryKeyword: "kw", brief: "Brief" },
        },
      });
      await nextTicks();
      assert.ok(requests.some(([u, m]) => u.includes("/notes") && m === "POST"));
      assert.ok(requests.some(([u, m]) => u === "/api/marketing/plans" && m === "POST"));
      assert.ok(requests.some(([u, m]) => u.includes("/steps") && m === "POST"));
    } finally {
      globalThis.FormData = originalFormData;
    }
  });
});
