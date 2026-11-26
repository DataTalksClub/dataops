import test, { before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createTables, startLocal, stopLocal } from "../scripts/local-dynamodb";
import { getClient } from "../src/db/client";
import { handleMarketingRoutes } from "../src/routes/marketing";
import {
  assertPublicTargetUrl,
  auditBacklinkPairs,
  classifyBacklinkCheck,
  fetchPublicHtmlPage,
  isPublicIpAddress,
  matchesTargetUrl,
} from "../src/marketing/backlinkAudit";
import { fetchAhrefsDomainRating } from "../src/marketing/ahrefs";
import type { LambdaEvent } from "../src/types";

function makeEvent(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  query?: Record<string, string>,
): LambdaEvent {
  return {
    httpMethod: method,
    path,
    headers: { "content-type": "application/json", "x-user-id": "test-actor" },
    queryStringParameters: query || {},
    body: body ? JSON.stringify(body) : null,
  } as unknown as LambdaEvent;
}

test("SSRF and public URL guards reject non-public IPs, hosts and redirects", async () => {
  assert.equal(isPublicIpAddress("93.184.216.34"), true);
  assert.equal(isPublicIpAddress("127.0.0.1"), false);
  assert.equal(isPublicIpAddress("10.0.0.5"), false);
  assert.equal(isPublicIpAddress("169.254.169.254"), false);
  assert.equal(isPublicIpAddress("172.16.0.1"), false);
  assert.equal(isPublicIpAddress("192.168.1.1"), false);
  assert.equal(isPublicIpAddress("100.64.0.1"), false);
  assert.equal(isPublicIpAddress("::1"), false);
  assert.equal(isPublicIpAddress("fe80::1"), false);
  assert.equal(isPublicIpAddress("::ffff:127.0.0.1"), false);
  assert.equal(isPublicIpAddress("2606:2800:220:1:248:1893:25c8:1946"), true);

  const privateLookup = async () => [{ address: "192.168.0.10", family: 4 }];
  await assert.rejects(
    () => assertPublicTargetUrl("https://internal.example.com/", privateLookup),
    /Non-public IP/,
  );
  await assert.rejects(
    () => assertPublicTargetUrl("http://localhost:8080/admin"),
    /Non-public host/,
  );
  await assert.rejects(
    () => assertPublicTargetUrl("http://169.254.169.254/latest/meta-data/"),
    /Non-public IP/,
  );
  await assert.rejects(
    () => assertPublicTargetUrl("file:///etc/passwd"),
    /Only public http\(s\) URLs/,
  );

  // Redirect to private IP must be rejected before fetching the redirect target.
  const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
  const fetchedUrls: string[] = [];
  const fakeFetch = (async (url: string | URL) => {
    fetchedUrls.push(String(url));
    return new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data/" },
    });
  }) as unknown as typeof fetch;
  const page = await fetchPublicHtmlPage("https://partner.example/redirect", {
    fetchFn: fakeFetch,
    lookupFn: publicLookup,
  });
  assert.equal(page.ok, false);
  assert.match(page.reason, /Redirect target rejected/);
  assert.deepEqual(fetchedUrls, ["https://partner.example/redirect"]);

  // Redirect loop bounded to maxRedirects.
  const loopFetch = (async () =>
    new Response(null, {
      status: 302,
      headers: { location: "https://partner.example/loop" },
    })) as unknown as typeof fetch;
  const looped = await fetchPublicHtmlPage("https://partner.example/loop", {
    fetchFn: loopFetch,
    lookupFn: publicLookup,
    maxRedirects: 2,
  });
  assert.equal(looped.ok, false);
  assert.match(looped.reason, /Exceeded max redirects/);
});

test("route/target identity matching and backlink bucket classification", async () => {
  assert.equal(
    matchesTargetUrl("https://example.org/?utm_source=partner", "https://example.org/"),
    true,
  );
  assert.equal(
    matchesTargetUrl("https://prod.example.org/blog/post.html", "https://example.org/blog/post.html"),
    false,
  );
  assert.equal(
    matchesTargetUrl("https://example.org/blog/other.html", "https://example.org/"),
    false,
  );
  assert.equal(
    matchesTargetUrl("https://example.org/blog/post.html", "https://example.org/blog/post.html"),
    true,
  );

  const followCheck = classifyBacklinkCheck(
    {
      ok: true,
      httpStatus: 200,
      finalUrl: "https://partner.example/article",
      html: '<a href="https://example.org/blog/post.html" rel="noopener">Guide</a>',
      reason: "HTTP 200",
    },
    "https://example.org/blog/post.html",
    "2026-11-26T12:00:00.000Z",
  );
  assert.equal(followCheck.bucket, "added_follow");
  assert.equal(followCheck.matchedHref, "https://example.org/blog/post.html");
  assert.deepEqual(followCheck.matchedRel, ["noopener"]);

  const qualifiedCheck = classifyBacklinkCheck(
    {
      ok: true,
      httpStatus: 200,
      finalUrl: "https://partner.example/article",
      html: '<a href="https://example.org/blog/post.html" rel="nofollow noopener">Guide</a>',
      reason: "HTTP 200",
    },
    "https://example.org/blog/post.html",
    "2026-11-26T12:00:00.000Z",
  );
  assert.equal(qualifiedCheck.bucket, "added_qualified");
  assert.deepEqual(qualifiedCheck.matchedRel, ["nofollow", "noopener"]);

  const absentCheck = classifyBacklinkCheck(
    {
      ok: true,
      httpStatus: 200,
      finalUrl: "https://partner.example/article",
      html: '<a href="https://example.org/different-page">Other</a>',
      reason: "HTTP 200",
    },
    "https://example.org/",
    "2026-11-26T12:00:00.000Z",
  );
  assert.equal(absentCheck.bucket, "absent");
  assert.equal(absentCheck.matchedHref, null);

  const unavailableCheck = classifyBacklinkCheck(
    {
      ok: false,
      httpStatus: 403,
      finalUrl: "https://partner.example/blocked",
      html: "",
      reason: "HTTP 403",
    },
    "https://example.org/",
    "2026-11-26T12:00:00.000Z",
  );
  assert.equal(unavailableCheck.bucket, "unavailable");
  assert.equal(unavailableCheck.httpStatus, 403);

  // Deduplicated source fetch across two targets on the same page.
  const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
  let fetchCount = 0;
  const mockFetch = (async () => {
    fetchCount++;
    return new Response(
      '<html><body><a href="https://example.org/a">A</a><a href="https://example.org/b" rel="ugc">B</a></body></html>',
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }) as unknown as typeof fetch;
  const audited = await auditBacklinkPairs(
    [
      { id: "p1", sourceUrl: "https://partner.example/list", targetUrl: "https://example.org/a" },
      { id: "p2", sourceUrl: "https://partner.example/list", targetUrl: "https://example.org/b" },
    ],
    { fetchFn: mockFetch, lookupFn: publicLookup, now: () => "2026-11-26T12:00:00.000Z" },
  );
  assert.equal(fetchCount, 1);
  assert.equal(audited.get("p1")?.bucket, "added_follow");
  assert.equal(audited.get("p2")?.bucket, "added_qualified");
});

test("page-level robots meta and X-Robots-Tag classify plain anchors accurately", async () => {
  const plainAnchorHtml = '<a href="https://www.evidentlyai.com/">Evidently</a>';

  // Fixture 1: HTML robots meta nofollow (+ noindex) on a plain anchor must NOT be added_follow.
  const metaNofollow = classifyBacklinkCheck(
    {
      ok: true,
      httpStatus: 200,
      finalUrl: "https://staging.example.org/blog/post.html",
      html: `<html><head><meta name="robots" content="noindex, nofollow"></head><body>${plainAnchorHtml}</body></html>`,
      reason: "HTTP 200",
    },
    "https://www.evidentlyai.com/",
    "2026-11-26T12:00:00.000Z",
  );
  assert.equal(metaNofollow.bucket, "added_qualified");
  assert.equal(metaNofollow.matchedHref, "https://www.evidentlyai.com/");
  assert.deepEqual(metaNofollow.matchedRel, []);
  assert.equal(metaNofollow.pageNofollow, true);
  assert.equal(metaNofollow.pageNoindex, true);
  assert.deepEqual(metaNofollow.pageRobotsDirectives, ["meta:noindex", "meta:nofollow"]);
  assert.match(metaNofollow.reason, /page robots meta nofollow/);
  assert.match(metaNofollow.reason, /page noindex/);

  // Fixture 2: HTTP X-Robots-Tag nofollow on a plain anchor (propagated via fetchPublicHtmlPage + auditBacklinkPairs).
  const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
  const headerFetch = (async () =>
    new Response(`<html><body>${plainAnchorHtml}</body></html>`, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-robots-tag": "noindex, nofollow",
      },
    })) as unknown as typeof fetch;
  const headerAudited = await auditBacklinkPairs(
    [
      {
        id: "hdr-1",
        sourceUrl: "https://staging.example.org/header-nofollow",
        targetUrl: "https://www.evidentlyai.com/",
      },
    ],
    { fetchFn: headerFetch, lookupFn: publicLookup, now: () => "2026-11-26T12:00:00.000Z" },
  );
  const headerCheck = headerAudited.get("hdr-1")!;
  assert.equal(headerCheck.bucket, "added_qualified");
  assert.equal(headerCheck.matchedHref, "https://www.evidentlyai.com/");
  assert.deepEqual(headerCheck.matchedRel, []);
  assert.equal(headerCheck.pageNofollow, true);
  assert.equal(headerCheck.pageNoindex, true);
  assert.deepEqual(headerCheck.pageRobotsDirectives, [
    "x-robots-tag:noindex",
    "x-robots-tag:nofollow",
  ]);
  assert.match(headerCheck.reason, /page X-Robots-Tag nofollow/);
  assert.match(headerCheck.reason, /page noindex/);

  // Fixture 3: noindex-only (meta and X-Robots-Tag) is an indexing flag only, NOT nofollow.
  const metaNoindexOnly = classifyBacklinkCheck(
    {
      ok: true,
      httpStatus: 200,
      finalUrl: "https://partner.example/noindex-only",
      html: `<html><head><meta name="robots" content="noindex"></head><body>${plainAnchorHtml}</body></html>`,
      reason: "HTTP 200",
    },
    "https://www.evidentlyai.com/",
    "2026-11-26T12:00:00.000Z",
  );
  assert.equal(metaNoindexOnly.bucket, "added_follow");
  assert.equal(metaNoindexOnly.pageNofollow, false);
  assert.equal(metaNoindexOnly.pageNoindex, true);
  assert.deepEqual(metaNoindexOnly.pageRobotsDirectives, ["meta:noindex"]);
  assert.match(metaNoindexOnly.reason, /follow; page noindex/);

  const headerNoindexOnly = classifyBacklinkCheck(
    {
      ok: true,
      httpStatus: 200,
      finalUrl: "https://partner.example/header-noindex-only",
      html: `<html><body>${plainAnchorHtml}</body></html>`,
      xRobotsTag: "noindex",
      reason: "HTTP 200",
    },
    "https://www.evidentlyai.com/",
    "2026-11-26T12:00:00.000Z",
  );
  assert.equal(headerNoindexOnly.bucket, "added_follow");
  assert.equal(headerNoindexOnly.pageNofollow, false);
  assert.equal(headerNoindexOnly.pageNoindex, true);
  assert.deepEqual(headerNoindexOnly.pageRobotsDirectives, ["x-robots-tag:noindex"]);
  assert.match(headerNoindexOnly.reason, /follow; page noindex/);

  // Other-bot-scoped X-Robots-Tag must not mark the page nofollow for general crawlers.
  const otherBotCheck = classifyBacklinkCheck(
    {
      ok: true,
      httpStatus: 200,
      finalUrl: "https://partner.example/otherbot",
      html: `<html><body>${plainAnchorHtml}</body></html>`,
      xRobotsTag: "otherbot: noindex, nofollow",
      reason: "HTTP 200",
    },
    "https://www.evidentlyai.com/",
    "2026-11-26T12:00:00.000Z",
  );
  assert.equal(otherBotCheck.bucket, "added_follow");
  assert.equal(otherBotCheck.pageNofollow, false);
  assert.equal(otherBotCheck.pageNoindex, false);
});

test("Ahrefs adapter stays unavailable without credentials and parses official v3 response when configured", async () => {
  const prev = process.env.AHREFS_API_TOKEN;
  delete process.env.AHREFS_API_TOKEN;
  try {
    const unconfigured = await fetchAhrefsDomainRating("example.org");
    assert.equal(unconfigured.status, "unavailable");
    assert.equal(unconfigured.value, undefined);

    const okRes = await fetchAhrefsDomainRating("example.org", {
      token: "test-token",
      date: "2026-11-26",
      fetchFn: (async () =>
        new Response(JSON.stringify({ domain_rating: { domain_rating: 62 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    assert.equal(okRes.status, "ok");
    assert.equal(okRes.value, 62);
    assert.equal(okRes.provider, "ahrefs");
    assert.equal(okRes.metricVersion, "v3");

    const errRes = await fetchAhrefsDomainRating("example.org", {
      token: "test-token",
      date: "2026-11-26",
      fetchFn: (async () => new Response("Forbidden", { status: 403 })) as unknown as typeof fetch,
    });
    assert.equal(errRes.status, "unavailable");
    assert.equal(errRes.value, undefined);
  } finally {
    if (prev !== undefined) process.env.AHREFS_API_TOKEN = prev;
  }
});

describe("Marketing sites, authority separation and backlink registry API contract", () => {
  let doc: DynamoDBDocumentClient;
  before(async () => {
    doc = await getClient(await startLocal());
    await createTables(doc);
  });
  after(stopLocal);

  test("manages tracked sites, enforces provider separation, and deduplicates/groups backlinks", async () => {
    // 1. Add tracked site & verify unavailable authority is NOT encoded as 0.
    const addSite = await handleMarketingRoutes(
      "/api/marketing/sites",
      "POST",
      makeEvent("POST", "/api/marketing/sites", {
        domain: "Example.ORG",
        label: "Primary site",
      }),
      doc,
    );
    assert.equal(addSite.statusCode, 201);
    const createdSite = JSON.parse(addSite.body);
    assert.equal(createdSite.domain, "example.org");

    const listBefore = await handleMarketingRoutes(
      "/api/marketing/sites",
      "GET",
      makeEvent("GET", "/api/marketing/sites"),
      doc,
    );
    assert.equal(listBefore.statusCode, 200);
    const beforeBody = JSON.parse(listBefore.body);
    assert.equal(beforeBody.items.length, 1);
    assert.deepEqual(beforeBody.items[0].authority, []);

    // 2. Reject mixing non-Ahrefs provider on domain_rating.
    const mixed = await handleMarketingRoutes(
      "/api/marketing/metrics",
      "POST",
      makeEvent("POST", "/api/marketing/metrics", {
        metricKey: "domain_rating",
        scope: "domain:example.org",
        source: "manual",
        period: "2026-11-26",
        value: 83,
        provider: "seranking",
      }),
      doc,
    );
    assert.equal(mixed.statusCode, 400);

    // 3. Push verified Ahrefs DR + separate SE Ranking DA snapshot.
    const pushDr = await handleMarketingRoutes(
      "/api/marketing/metrics",
      "POST",
      makeEvent("POST", "/api/marketing/metrics", {
        metricKey: "domain_rating",
        scope: "domain:example.org",
        source: "ahrefs-free",
        period: "2026-11-26",
        value: 57,
        observedAt: "2026-11-26T10:00:00Z",
        evidenceUrl: "https://ahrefs.com/website-authority-checker/?input=example.org",
        provider: "ahrefs",
        metricVersion: "unexposed",
        details: { backlinksDisplay: "8.5K", backlinksDofollowPct: 59 },
      }),
      doc,
    );
    assert.equal(pushDr.statusCode, 200);

    const pushSe = await handleMarketingRoutes(
      "/api/marketing/metrics",
      "POST",
      makeEvent("POST", "/api/marketing/metrics", {
        metricKey: "seranking_da",
        scope: "domain:example.org",
        source: "treg-seranking",
        period: "2026-11-26",
        value: 83,
        observedAt: "2026-11-26T10:00:00Z",
        provider: "seranking",
      }),
      doc,
    );
    assert.equal(pushSe.statusCode, 200);

    // Refresh without Ahrefs credentials stays unavailable and never writes 0.
    const refresh = await handleMarketingRoutes(
      "/api/marketing/sites/example.org/refresh-authority",
      "POST",
      makeEvent("POST", "/api/marketing/sites/example.org/refresh-authority", {}),
      doc,
    );
    assert.equal(refresh.statusCode, 200);
    assert.equal(JSON.parse(refresh.body).status, "unavailable");

    const listAfter = await handleMarketingRoutes(
      "/api/marketing/sites",
      "GET",
      makeEvent("GET", "/api/marketing/sites"),
      doc,
    );
    const siteAfter = JSON.parse(listAfter.body).items[0];
    assert.equal(siteAfter.authority.length, 2);
    const drSeries = siteAfter.authority.find((s: any) => s.metricKey === "domain_rating");
    const seSeries = siteAfter.authority.find((s: any) => s.metricKey === "seranking_da");
    assert.equal(drSeries.latest.value, 57);
    assert.equal(drSeries.metricVersion, "unexposed");
    assert.equal(seSeries.latest.value, 83);

    // 4. Register backlink pairs with deduplication by (sourceUrl, targetUrl).
    const seedRes = await handleMarketingRoutes(
      "/api/marketing/backlinks",
      "POST",
      makeEvent("POST", "/api/marketing/backlinks", {
        items: [
          {
            sourceUrl: "https://partner.example/post",
            targetUrl: "https://example.org/guide-a",
            outreachState: "alexey_sent",
            owner: "alexey",
          },
          {
            sourceUrl: "https://partner.example/post",
            targetUrl: "https://example.org/guide-a",
            outreachState: "alexey_sent",
            owner: "alexey",
          },
          {
            sourceUrl: "https://partner.example/post",
            targetUrl: "https://example.org/guide-b",
            outreachState: "orin_sent",
            owner: "orin",
          },
        ],
      }),
      doc,
    );
    assert.equal(seedRes.statusCode, 200);
    const seedBody = JSON.parse(seedRes.body);
    assert.equal(seedBody.inserted, 2);
    assert.equal(seedBody.items.length, 2);

    // Record check results and verify separate bucket sorting.
    const [pairA, pairB] = seedBody.items;
    const recordChecks = await handleMarketingRoutes(
      "/api/marketing/backlinks/checks",
      "POST",
      makeEvent("POST", "/api/marketing/backlinks/checks", {
        checks: [
          {
            id: pairA.id,
            checkedAt: "2026-11-26T12:00:00.000Z",
            bucket: "added_follow",
            httpStatus: 200,
            finalUrl: pairA.sourceUrl,
            matchedHref: pairA.targetUrl,
            matchedRel: [],
            matchCount: 1,
            reason: "Link present (follow)",
          },
          {
            id: pairB.id,
            checkedAt: "2026-11-26T12:00:00.000Z",
            bucket: "absent",
            httpStatus: 200,
            finalUrl: pairB.sourceUrl,
            matchedHref: null,
            matchedRel: [],
            matchCount: 0,
            reason: "Target link not found on page",
          },
        ],
      }),
      doc,
    );
    assert.equal(recordChecks.statusCode, 200);
    const checkedBody = JSON.parse(recordChecks.body);
    assert.equal(checkedBody.summary.added_follow, 1);
    assert.equal(checkedBody.summary.absent, 1);
    assert.equal(checkedBody.groups.added_follow[0].owner, "alexey");
  });
});
