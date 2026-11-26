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

function surfaceHarness(request, route, today = "2026-11-25") {
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
    todayIsoDate: () => today,
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


const snapshots = [
  { period: "2026-W46", value: 25, unit: "count", source: "gsc" },
  { period: "2026-W47", value: 33, unit: "count", source: "gsc", provisional: true },
];
const goal = {
  ref: "nonbrand", title: "Non-brand impressions", metricKey: "gsc_nonbrand_impressions",
  scope: "prefix:/academy/", source: "gsc", status: "at-risk", value: 33, snapshots,
  baseline: { value: 20, date: "2026-11-01", note: "GSC export" },
  target: { value: 100, date: "2027-02-28" }, window: "week",
};
const step = {
  id: "s-12345678", planId: "academy", title: "Refresh guide", version: 4,
  kind: "refresh", size: "S", status: "planned", ownerId: "orin", goalRefs: ["nonbrand"],
  targetUrl: "https://datatalks.club/academy/", targetType: "refresh",
  primaryKeyword: "free data engineering courses", doneCriteria: "Indexed", brief: "Add internal links",
};
const plan = {
  id: "academy", title: "Academy Visibility", status: "active", version: 7,
  ownerId: "marketer", goals: [goal], steps: [step], notesLog: [],
};
const review = {
  week: "2026-W48", from: "2026-11-23", to: "2026-11-29", plans: [plan],
  missing: [{ metricKey: "bing_clicks", source: "manual" }],
  shipped: [{ ...step, title: "Shipped guide" }], due: [], overdue: [step],
  idle: ["authority"], stale: [step],
  capacity: { items: [
    { week: "2026-W48", small: 2, large: 1, reviews: 3, limit: 2, warning: true },
  ], weeklyLimit: 2 },
};
const page = (root) => root.children[0].children[0].innerHTML;

function route(path, params = {}) {
  return { path, params: new URLSearchParams(params) };
}
async function submit(root, selector, data) {
  const original = globalThis.FormData;
  globalThis.FormData = class { get(key) { return data[key]; } };
  try {
    await root.children[0].dispatch("submit", {
      preventDefault() {},
      target: { dataset: {}, matches: (s) => s === selector, closest: () => null },
    });
  } finally { globalThis.FormData = original; }
}

describe("marketing API contract and rendering", () => {
  test("plan list is uncluttered and shows API goals and snapshot age", () => {
    const markup = planListMarkup([plan], "2026-11-25");
    assert.match(markup, /Academy Visibility/);
    assert.match(markup, /3 days old/);
    assert.match(markup, /at risk/);
    assert.match(planListMarkup([]), /No marketing plans yet/);
    assert.match(planListMarkup([], "2026-11-25", "Unavailable"), /Unavailable/);
  });

  test("plan list counts the current ISO week's steps through one collection read", async () => {
    const calls = [];
    const otherPlan = { ...plan, id: "authority", title: "Authority" };
    const h = surfaceHarness(async (url) => {
      calls.push(url);
      if (url === "/api/marketing/plans") return { items: [plan, otherPlan] };
      assert.equal(url, "/api/marketing/steps?week=2026-W48");
      return { items: [
        { ...step, publishDate: "2026-11-23" },
        { ...step, id: "s-87654321", publishDate: "2026-11-29" },
      ] };
    }, route("/marketing"));
    await h.surface.renderMarketingSurface();
    assert.deepEqual(calls, ["/api/marketing/plans", "/api/marketing/steps?week=2026-W48"]);
    const rows = page(h.root).match(/<tr>[\s\S]*?<\/tr>/g);
    assert.match(rows[1], /Academy Visibility[\s\S]*class="mkt-num">2<\/td>/);
    assert.match(rows[2], /Authority[\s\S]*class="mkt-num">0<\/td>/);
  });

  test("plan list uses the ISO week year around New Year", async () => {
    const calls = [];
    const h = surfaceHarness(async (url) => {
      calls.push(url);
      return { items: url === "/api/marketing/plans" ? [plan] : [] };
    }, route("/marketing"), "2027-01-01");
    await h.surface.renderMarketingSurface();
    assert.deepEqual(calls, ["/api/marketing/plans", "/api/marketing/steps?week=2026-W53"]);
  });

  test("failed step counts keep plans visible, show unknown and can be retried", async () => {
    let failed = true;
    const h = surfaceHarness(async (url) => {
      if (url === "/api/marketing/plans") return { items: [plan] };
      if (failed) throw new Error("Step service unavailable");
      return { items: [{ ...step, publishDate: "2026-11-25" }] };
    }, route("/marketing"));
    await h.surface.renderMarketingSurface();
    assert.match(page(h.root), /Academy Visibility/);
    assert.match(page(h.root), /Due this week is unavailable\. Step service unavailable/);
    assert.match(page(h.root), /class="mkt-num">–<\/td>/);
    assert.doesNotMatch(page(h.root), /class="mkt-num">0<\/td>/);
    assert.match(page(h.root), /data-mkt-retry/);
    failed = false;
    await h.root.children[0].dispatch("click", {
      target: { closest: (selector) => selector === "[data-mkt-retry]" ? {} : null },
    });
    await nextTicks();
    assert.doesNotMatch(page(h.root), /Due this week is unavailable/);
    assert.match(page(h.root), /class="mkt-num">1<\/td>/);
  });

  test("ISO week and month snapshots render real chart points and tables", () => {
    assert.match(sparklineSvg(snapshots, goal), /mkt-sparkline__line/);
    const chart = goalChartMarkup(snapshots, goal, [{ ...step, publishedAt: "2026-11-18" }]);
    assert.match(chart, /mkt-chart__baseline/);
    assert.match(chart, /mkt-chart__target/);
    assert.match(chart, /mkt-chart__marker/);
    assert.match(chart, /11-22/);
    assert.doesNotMatch(chart, /NaN/);
    assert.match(goalChartMarkup([{ period: "2026-11", value: 20 }], goal), /11-30/);
    assert.match(goalDetailMarkup(plan, goal, snapshots), /2026-11-16 – 2026-11-22/);
    assert.match(goalDetailMarkup(plan, goal, snapshots), /provisional/);
    assert.match(planDetailMarkup(plan, [step]), /mkt-sparkline__line/);
    assert.match(planDetailMarkup(plan, [step]), /Refresh guide/);
    assert.match(goalChartMarkup([], goal), /No snapshots/);
    assert.equal(filterStepsByTab([step], "planned").length, 1);
    assert.equal(filterStepsByTab([step], "published").length, 0);
  });

  test("step brief and scheduling support card, task, link and existing social rows", () => {
    const markup = stepDetailMarkup(step, plan);
    for (const field of ["free data engineering courses", "Indexed", "Add internal links", "linkCardId", "publishTaskId", "template", "assignee"]) {
      assert.ok(markup.includes(field), field);
    }
    assert.match(stepDetailMarkup({ ...step, kind: "social" }, plan), /name="campaignRowId" required/);
    assert.match(stepDetailMarkup({ ...step, kind: "technical" }, plan), /data-mkt-live-form/);
  });

  test("review consumes nested plan goals, work lists and weekly capacity", () => {
    assert.equal(ALEXEY_WEEKLY_REVIEW_LIMIT, 2);
    const markup = weeklyReviewMarkup(review);
    for (const text of ["Non-brand impressions", "bing_clicks", "Shipped guide", "Refresh guide", "authority", "weekly limit 2 — over capacity", "2026-11-23 to 2026-11-29"]) {
      assert.ok(markup.includes(text), text);
    }
    assert.match(markup, /is-over-limit/);
    assert.match(markup, /33/);
  });

  test("reads canonical collection and bare detail envelopes on every route", async () => {
    const cases = [
      [route("/marketing"), "Academy Visibility"],
      [route("/marketing/plans/academy", { planId: "academy" }), "mkt-sparkline__line"],
      [route("/marketing/plans/academy/goals/nonbrand", { planId: "academy", goalRef: "nonbrand" }), "mkt-chart__line"],
      [route("/marketing/steps/s-12345678", { stepId: step.id }), "Indexed"],
      [route("/marketing/review", { week: "2026-W48" }), "weekly limit 2 — over capacity"],
    ];
    for (const [activeRoute, expected] of cases) {
      const calls = [];
      const { root, surface } = surfaceHarness(async (url) => {
        calls.push(url);
        if (url === "/api/marketing/plans") return { items: [plan] };
        if (url.includes("/goals/")) return { ...goal, planId: plan.id, version: plan.version };
        if (url.startsWith("/api/marketing/steps/")) return step;
        if (url.startsWith("/api/marketing/steps?")) return { items: [step] };
        if (url.startsWith("/api/marketing/review?")) return review;
        return plan;
      }, activeRoute);
      await surface.renderMarketingSurface();
      assert.ok(page(root).includes(expected), activeRoute.path);
      if (activeRoute.path === "/marketing/review") {
        assert.deepEqual(calls, ["/api/marketing/review?week=2026-W48"]);
      }
    }
  });

  test("plan and step writes send current versions and all schedule options", async () => {
    const writes = [];
    const request = async (url, options) => {
      if (options?.method) { writes.push([url, JSON.parse(options.body)]); return {}; }
      return url.includes("/steps/") ? step : plan;
    };
    const h = surfaceHarness(request, route("/marketing/plans/academy", { planId: plan.id }));
    await h.surface.renderMarketingSurface();
    await submit(h.root, "[data-mkt-note-form]", { text: "Checked GSC", ref: "review" });
    await submit(h.root, "[data-mkt-add-step-form]", { title: "Refresh", kind: "refresh", targetType: "refresh", doneCriteria: "Indexed" });
    assert.equal(writes[0][1].version, 7);
    assert.equal(writes[1][1].version, 7);
    assert.equal(writes[1][1].targetType, "refresh");
    const h2 = surfaceHarness(request, route("/marketing/steps/s-12345678", { stepId: step.id }));
    await h2.surface.renderMarketingSurface();
    await submit(h2.root, "[data-mkt-schedule-form]", { publishDate: "2026-12-04", mode: "link", linkCardId: "card-1", publishTaskId: "task-1" });
    await submit(h2.root, "[data-mkt-live-form]", { date: "2026-12-04", url: step.targetUrl });
    await submit(h2.root, "[data-mkt-drop-form]", { reason: "Reprioritized" });
    assert.deepEqual(writes[2][1], { version: 4, publishDate: "2026-12-04", mode: "link", linkCardId: "card-1", publishTaskId: "task-1" });
    assert.equal(writes[3][1].version, 4);
    assert.equal(writes[4][1].version, 4);
  });

  test("failed writes preserve the form and display an actionable error", async () => {
    const h = surfaceHarness(async (_, options) => {
      if (options?.method) throw new Error("Record changed; reload and retry with version");
      return plan;
    }, route("/marketing/plans/academy", { planId: plan.id }));
    await h.surface.renderMarketingSurface();
    await submit(h.root, "[data-mkt-note-form]", { text: "Keep this note" });
    assert.match(page(h.root), /Academy Visibility/);
    const notice = h.root.children[0].children[0].children.at(-1);
    assert.match(notice.textContent, /Record changed/);
  });

  test("API errors render retry states and navigation uses the shell", async () => {
    const h = surfaceHarness(async () => { const error = new Error("Not found"); error.status = 404; throw error; }, route("/marketing"));
    await h.surface.renderMarketingSurface();
    assert.match(page(h.root), /Marketing API is not available yet/);
    let prevented = false;
    await h.root.children[0].dispatch("click", {
      button: 0, preventDefault() { prevented = true; },
      target: { closest: (selector) => selector === "a[data-mkt-nav]" ? { getAttribute: () => "/marketing/review" } : null },
    });
    assert.ok(prevented);
    assert.deepEqual(h.navigations, ["/marketing/review"]);
  });

  test("site metrics and backlink audit route renders authority without mixing providers and sorts link buckets", async () => {
    const writes = [];
    const sitesPayload = {
      ahrefsConfigured: false,
      items: [
        {
          domain: "example.org",
          label: "Main site",
          version: 1,
          authority: [
            {
              metricKey: "domain_rating",
              source: "ahrefs-free",
              provider: "ahrefs",
              metricVersion: "unexposed",
              unit: "score",
              delta: 2,
              latest: {
                value: 57,
                unit: "score",
                source: "ahrefs-free",
                period: "2026-11-26",
                observedAt: "2026-11-26T10:00:00Z",
                metricVersion: "unexposed",
                evidenceUrl: "https://ahrefs.com/website-authority-checker/?input=example.org",
              },
            },
          ],
        },
        {
          domain: "sub.example.org",
          label: "Secondary site",
          version: 1,
          authority: [],
        },
      ],
    };
    const backlinksPayload = {
      items: [
        {
          id: "bl-1",
          sourceUrl: "https://partner.example/a",
          targetUrl: "https://example.org/",
          outreachState: "alexey_sent",
          owner: "alexey",
          version: 1,
          latestCheck: {
            checkedAt: "2026-11-26T12:00:00Z",
            bucket: "added_follow",
            httpStatus: 200,
            finalUrl: "https://partner.example/a",
            matchedHref: "https://example.org/",
            matchedRel: [],
            matchCount: 1,
            reason: "Link present (follow)",
          },
        },
        {
          id: "bl-2",
          sourceUrl: "https://partner.example/b",
          targetUrl: "https://example.org/",
          outreachState: "orin_sent",
          owner: "orin",
          version: 1,
          latestCheck: {
            checkedAt: "2026-11-26T12:00:00Z",
            bucket: "unavailable",
            httpStatus: 403,
            finalUrl: "https://partner.example/b",
            matchedHref: null,
            matchedRel: [],
            matchCount: 0,
            reason: "HTTP 403",
          },
        },
      ],
      summary: { total: 2, added_follow: 1, added_qualified: 0, absent: 0, unavailable: 1, unchecked: 0 },
      groups: {
        added_follow: [
          {
            id: "bl-1",
            sourceUrl: "https://partner.example/a",
            targetUrl: "https://example.org/",
            outreachState: "alexey_sent",
            owner: "alexey",
            version: 1,
            latestCheck: {
              checkedAt: "2026-11-26T12:00:00Z",
              bucket: "added_follow",
              httpStatus: 200,
              finalUrl: "https://partner.example/a",
              matchedHref: "https://example.org/",
              matchedRel: [],
              matchCount: 1,
              reason: "Link present (follow)",
            },
          },
        ],
        added_qualified: [],
        absent: [],
        unavailable: [
          {
            id: "bl-2",
            sourceUrl: "https://partner.example/b",
            targetUrl: "https://example.org/",
            outreachState: "orin_sent",
            owner: "orin",
            version: 1,
            latestCheck: {
              checkedAt: "2026-11-26T12:00:00Z",
              bucket: "unavailable",
              httpStatus: 403,
              finalUrl: "https://partner.example/b",
              matchedHref: null,
              matchedRel: [],
              matchCount: 0,
              reason: "HTTP 403",
            },
          },
        ],
        unchecked: [],
      },
    };
    const h = surfaceHarness(async (url, options) => {
      if (options?.method) {
        writes.push([url, options.method, options.body ? JSON.parse(options.body) : null]);
        return {};
      }
      if (url === "/api/marketing/sites") return sitesPayload;
      if (url === "/api/marketing/backlinks") return backlinksPayload;
      return {};
    }, route("/marketing/metrics"));
    await h.surface.renderMarketingSurface();
    const htmlOut = page(h.root);
    assert.match(htmlOut, /<strong>57\/100<\/strong>/);
    assert.match(htmlOut, /No DR snapshot yet/);
    assert.match(htmlOut, /Added \(follow\)/);
    assert.match(htmlOut, /Unavailable/);
    assert.match(htmlOut, /alexey_sent \(alexey\)/);

    await submit(h.root, "[data-mkt-add-site-form]", { domain: "blog.example.org", label: "Blog" });
    await submit(h.root, "[data-mkt-record-authority-form]", {
      domain: "example.org",
      metricKey: "domain_rating",
      source: "ahrefs-free",
      period: "2026-12-03",
      value: "58",
      metricVersion: "unexposed",
      evidenceUrl: "https://ahrefs.com/website-authority-checker/?input=example.org",
    });
    assert.equal(writes[0][0], "/api/marketing/sites");
    assert.equal(writes[0][2].domain, "blog.example.org");
    assert.equal(writes[1][0], "/api/marketing/metrics");
    assert.equal(writes[1][2].provider, "ahrefs");
    assert.equal(writes[1][2].value, 58);
  });
});
