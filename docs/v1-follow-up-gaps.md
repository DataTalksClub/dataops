---
title: "V1 Follow-Up Gaps"
summary: "Known gaps from the V1 completion audit that undermine the run-daily-operations-end-to-end claim."
doc_type: reference
tags:
  - v1
  - followup
  - gaps
systems: []
related_docs:
  - docs/v1-handoff-2026-06-27.md
  - docs/v1-runtime-architecture.md
  - docs/operations-manager-platform-jtbd.md
---

# V1 Follow-Up Gaps

Audit date: 2026-06-27. The core daily loop works in code and passes
tests, but these gaps must be closed before V1 is truly production-ready.

## Would break in production

### 1. File uploads don't persist

The work-engine file handler writes to the local filesystem (`saveFile` in
`storage.ts`). Lambda `/tmp` is ephemeral and wiped between invocations.
Required-file proof uploaded through the portal would silently disappear.

Fix: implement S3-backed storage before relying on file proof in
production. The architecture doc already specifies this
(`docs/v1-runtime-architecture.md`, File And Artifact Storage).

### 2. Production work-engine data state is unknown

Deploy succeeded and the auth gate works, but we never confirmed the
work-engine Lambda has `WORK_ENGINE_FUNCTION_NAME` and
`WORK_ENGINE_PORTAL_SECRET` configured, or that DynamoDB has any data.

Fix: verify the broker returns real data with an authenticated request,
and seed or migrate initial operational data.

### 3. No data migration from existing sources

Issues #41 (Trello) and #42 (spreadsheet) are still `needs grooming`.
The real operations work lives in Trello cards and a spreadsheet. Without
importing that, the workspace has no actual work to show.

Fix: groom and execute the Trello and spreadsheet import issues.

## JTBD spec requires, portal doesn't have

### 4. No task list view

The spec requires a screen for inspecting tasks across time with
date-range, status, and assignee filters. The portal only has the
dashboard. The work-engine standalone app has this, but the portal
doesn't expose it.

### 5. No recurring config management

The spec requires a screen to enable/disable recurring configs and see
schedules. The work-engine has the API; the portal doesn't expose it.

### 6. Template cards don't start workflows

The template cards on the dashboard still open git docs, not the
start-workflow flow. Only the quick-create dropdown starts workflows.

### 7. Assistant integration is superficial

A manual URL-paste field for Links & Artifacts was added. The
podcast-assistant isn't wired in. No automated flow from assistant
output to workflow artifact.

## Weak but functional

### 8. Audit history is unstructured

Follow-up actions append to the comment field as timestamped text lines,
not a structured event log. The architecture doc lists `audit_events` as
a future entity.

### 9. No scheduled cron trigger

The cron runner exists but there's no EventBridge rule or similar to
trigger it automatically. Recurring task generation requires a manual
`POST /api/cron/run`.

### 10. No full E2E test through the production path

Verified pieces with mocked Playwright routes but never ran a full
browser-to-broker-to-work-engine test against live servers. The
Playwright smoke suite (#45) is still open.

### 11. PROCESS.md gates not fully followed

Several implementation slices were merged directly to main without full
PM grooming, tester review, and PM acceptance gates.

## Recommended order

1. Verify production broker and data state (gap 2).
2. Implement S3 file storage (gap 1).
3. Groom and execute data migration (gap 3).
4. Add task list view (gap 4).
5. Add recurring config management (gap 5).
6. Wire template cards to start workflows (gap 6).
7. Set up EventBridge for cron (gap 9).
8. Add Playwright E2E suite (gap 10).
9. Wire assistant integration (gap 7).
10. Structured audit events (gap 8).
