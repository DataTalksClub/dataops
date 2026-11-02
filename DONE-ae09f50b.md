# DONE evidence — intake ae09f50b (per-issue newsletter page /newsletter/:issueId)

The feature was implemented and deployed by earlier work of this intake
(commit `09c9bb18` "Add per-issue newsletter page at /newsletter/<issueId>",
2026-10-27, ancestor of origin/main and of the deployed prod head); this file
records the 2026-11-02 re-verification that every acceptance criterion holds
on current main, plus the one test gap found and closed today.

- AC1 route + cold load: `/newsletter/:issueId` is a first-class route
  (`frontend/src/core/workspace.js`, `WORKSPACE_ROUTE_DEFINITIONS`, `09c9bb18`).
  Extensionless deep links serve the one app shell
  (`backend/src/docs/portal.ts` `serveFrontend` fallback), so a cold load or
  refresh resolves the page. Tests: `frontend/test/routing.test.mjs`
  ("addresses each newsletter issue at /newsletter/<issueId>…"), and a new
  browser cold-load test `backend/e2e/demo-deep-links.spec.js`
  ("a cold load of /newsletter/<issueId> opens the issue details, and unknown
  ids stay friendly", commit `382f288c`) — real browser, direct address,
  refresh, 4/4 pass locally.
- AC2 content: the page (`frontend/src/surfaces/planning-newsletter-issue.js`)
  shows date (+ publication time), issue number, kind badge, sponsors (each
  linked to `/sponsors/companies/<id>` when the slot recorded an organization,
  plain name otherwise, per-slot document link), doc links (campaign URL +
  issue links), stats with an explicit empty state, the issue's Card chip
  (stage + open/total tasks, links to `/cards?cardId=…`), and a link to
  `/newsletter-issues/<id>/preview`. It uses the existing
  `GET /api/newsletter-issues/<id>` (no new backend endpoint needed; the route
  exists in `backend/src/routes/newsletterIssues.ts`). Tests:
  `frontend/test/planning-surface.test.mjs` ("the issue page shows one issue's
  details with company, doc, stats, and card links", "…honest empty states…").
  Live: the API returns the full view for a real issue (Weekly #258).
- AC3 list linking: every planner row links to `/newsletter/<issueId>` —
  upcoming rows (`newsletterIssueMarkup`) and past rows (`pastIssueMarkup`)
  both wrap the issue title in `.newsletter-issue-link`. Test:
  "links every planner row to the issue's own page, past and upcoming".
- AC4 unknown/invalid id: a 404 from the API renders the friendly
  "Newsletter issue not found" state with a link back to `/newsletter`; other
  failures render an honest retry state; malformed/unknown paths normalize to
  the work queue instead of crashing; no raw error JSON. Tests:
  planning-surface "an unknown issue id shows a friendly not-found state…",
  "a failed issue load says so and links back…"; backend 404 after delete
  (`backend/tests/newsletter-issues.test.ts`); E2E cold-load unknown id
  (new test). Live: unknown id → API 404 `{"error":"Not found"}`, page stays
  the app shell.
- AC5 auth unchanged: `/api/newsletter-issues` sits behind the shared portal
  session middleware (`backend/src/router.ts`); the single-issue GET is not
  auth-exempt and the exemption table test
  (`backend/tests/api-authorization.test.ts`) pins the prefix. No new public
  endpoints. Live: anonymous page request → 302 to `/login` (normal sign-in
  flow); anonymous API request → 401.
- AC6 tests: frontend suite 920 tests / 0 failures locally on this checkout
  (includes all newsletter issue-page tests). Backend suite 2047 tests /
  2042 pass locally; the 4 local failures are this Windows checkout's missing
  tools (`jq`, `/bin/sh` for the knowledge-memory RSS test) — the same suites
  run green in CI (Validate CLI + the deploy job's check on `5e6720d7`).
  Backend Playwright E2E: the newsletter surface is green locally
  (`canonical-route-parity` + `demo-deep-links` 22/22, the Newsletter
  capability-behavior test passes in isolation, new cold-load test 4/4). The
  CI Browser E2E workflow has been red since 11:14 UTC today across heads
  from other intakes (last green `b5944e5d` 10:58 UTC); this intake's feature
  commit is from 2026-10-27 with green E2E runs after it, so today's redness
  is not attributable to this work.
- AC7 delivery: worktree on fresh origin/main, rebased onto latest main and
  pushed as `HEAD:main` (no PR). Deploys run through the normal pipeline
  (Deploy DataOps V1 Lambda run 41443058308 for `5e6720d7` — both jobs green;
  this intake's code was already live since that deploy). No AWS CLI/profile
  use, no approvals, no deletions, no prod test data, no messages.
- AC8 live proof (2026-11-02, against the deploy of `5e6720d7`):
  - URL format: `https://ops.dtcdev.click/newsletter/<issueId>`
  - Working example:
    `https://ops.dtcdev.click/newsletter/0f141c08a91094cd2a2950398b36390392fbf43b0a2ee21dede8cdff44a23271`
    (Weekly #258, Friday 2026-01-05, status sent; primary sponsor Snowflake
    linked to company `0a7dc5d3…`, secondary slot open; stats: 135,613 sent /
    40,380 opens (29.78%) / 1,319 clicks (3.27%) recorded 2026-10-17; Card
    `5ceb1ae0…` done, 0/16 tasks open).
  - The details above come from the live authenticated API the page renders
    from; the page URL serves HTTP 200 to cookie-authenticated sessions
    (same handler verified by the browser cold-load E2E locally) and 302 to
    `/login` for anonymous browsers.
  - Unknown id `00000000-0000-0000-0000-000000000000`: API 404, page keeps
    the app shell and shows the friendly not-found state.
  - Tooling limit on this desktop: no browser automation host is available
    and completing portal sign-in needs a human Google session, so the
    authenticated rendered-DOM screenshot on prod remains for the operator;
    the exact URL and the full evidence chain above are in
    `~/tmp/agent-reports/newsletter-issue-page-2026-11-02.md`.

Scope: in
