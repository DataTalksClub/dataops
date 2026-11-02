# DONE evidence — intake 71cc1dc9 (newsletter performance metrics replace tracking spreadsheet)

The feature was implemented and landed on main by earlier work (859e2cbd, ca2eff3b,
ac6dc40b, a9d0c8dc, 3d4cd85f, ce8bd641, c35ca843 and the knowledge-repo template
migration). This session re-verified every acceptance criterion on current
origin/main (35d6f21c + eec18f6f), closed the last docs drift, and re-ran the
tests. No product code changes were needed.

- AC1 metric fields + DB migration: `NewsletterIssueStats` (sent, opens, clicks,
  uniqueClicks, openRate, clickRate) on the issue and per-slot `NewsletterSlotStats`
  (clicks, uniqueClicks, clickRate, linkedin impressions/clicks/reactions/ctr/postUrl,
  x impressions/clicks/reactions/ctr/postUrl) in `backend/src/db/newsletterIssues.ts`;
  API validation in `backend/src/routes/newsletterIssues.ts`. Migration: the
  `deliveries`→`sent` rename script (`ca2eff3b`) was applied in prod (41 newsletter
  issues migrated) and then deleted per the no-dead-code rule (`63a25a86`).
- AC2 CLI: `dataops newsletter metrics <issue-id> [primary|secondary]` with `--sent
  --opens --open-rate --clicks --unique-clicks --click-rate --linkedin-impressions
  --linkedin-clicks --linkedin-reactions --linkedin-ctr --linkedin-post --x-*
  --pull-mailchimp --clear`; `--help` documents it (`cli/src/commands/newsletter.mjs`);
  with no metric flags it prints the current values (read form). Test
  `cli/test/work.test.mjs` "newsletter metrics and sponsor report" passes.
- AC3 UI: `frontend/src/surfaces/planning-newsletter-slots.js` renders the Mailchimp
  line (sent, opens + rate, clicks + unique + CTR) and per-slot LinkedIn/X lines with
  post links in the issue view/dialog. `frontend/test/planning-surface.test.mjs`
  30/30 pass.
- AC4 sponsor report: `backend/src/newsletter/statsReport.ts` builds the report and
  prefilled email message per `template.newsletter.newsletter-performance`; served at
  `GET /api/newsletter-issues/:id/report` and `GET /api/newsletter-issues/report?sponsor=`;
  CLI `dataops newsletter report`.
- AC5 task rename + migration + auto-close: open-card migration applied in prod (41
  issues; script `ca2eff3b`, deleted after apply `63a25a86`). The live knowledge-repo
  template now emits `blocks/sponsor-performance.yaml`: collect-mailchimp-stats /
  collect-x-stats / collect-linkedin-stats / send-performance-to-sponsor, each collect
  task instructing `dataops newsletter metrics` as its operator action. Auto-close is
  wired in `backend/src/routes/newsletterIssues.ts` (`maybeCloseMetricsTask` records
  the stats summary as external-status proof; the retired `add-newsletter-performance`
  guard was removed in `c35ca843` once no open cards carried it). This session updated
  `backend/docs/templates/part-1-recurring-publication-templates.md` to list the live
  per-channel collect tasks instead of the retired single task (commit eec18f6f).
  Tests: `backend/tests/newsletter-issues.test.ts` auto-close + Mailchimp pull cases pass.
- AC6 Mailchimp auto-pull (bonus): implemented after the triage note —
  `backend/src/newsletter/mailchimpMetrics.ts`, `POST /api/newsletter-issues/:id/mailchimp-metrics`,
  CLI `--pull-mailchimp [--campaign] [--primary-url/--secondary-url] [--dry-run]`
  (`ce8bd641`, 2026-10-30); issues resolve by number (`299`/`#299`). Backend tests
  cover dry-run and live pull + auto-close; no separate follow-up intake needed.
- AC7 interim data: preserved in place ("leave them"). Orin's metrics comment on task
  #299 is untouched by any code path; issue 299's metrics were recorded in prod via
  `dataops newsletter metrics 299` in earlier sessions (referenced by triage). The
  LinkedIn metrics for issue 299 remain pending the external LinkedIn export
  (carried from triage; the X/LinkedIn fields and CLI flags exist for when it arrives).
- AC8 tests/CI/deploy: local on origin/main — backend newsletter-issues 20/20,
  CLI 460/461, frontend planning-surface 30/30. The remaining local failures are
  Windows-checkout environment artifacts, all outside this intake: 8 backend
  (CRLF byte-parsing of `infra/template.full.yaml` under core.autocrlf=true, missing
  `../aws-infra` sibling, missing `../dataops-knowledge` sibling in this worktree,
  `/bin/sh` memory-oracle spawn), 1 CLI (invoice-pdf chmod 0o666≠0o600 Windows
  semantics), 2 frontend (CRLF vs `\n` regex in architecture/coverage contract —
  same class ae09f50b fixed). CI on Linux is green: "Deploy DataOps V1 Lambda" run
  41443058308 success @ 5e6720d7 — that workflow runs frontend coverage, backend
  tests, MCP tests, and the transactions gate before deploying, so the full suite
  passed in CI; Validate CLI success @ b50cd86d; no backend changes after 5e6720d7,
  so prod runs the newsletter backend. Prod `https://ops.dtcdev.click/api/health`
  → `{"status":"ok"}`.

BLOCKER: AC8's interactive live proof — an authenticated `dataops newsletter metrics
299` read against prod plus a logged-in UI screenshot/HTML check — needs an
operator/Orin-scoped credential. Per this session's instructions the hub CLI and
credential lookup are not available on this desktop, and the triage credential is
invoice-reader only, so the check could not be independently re-read here.
