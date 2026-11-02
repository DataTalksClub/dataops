# DONE evidence — intake a31a42d6 (CRM hard-delete endpoint + CLI)

The feature was implemented and deployed by earlier work; this file records the
2026-11-02 re-verification that every acceptance criterion holds on current main.
No product code changes were needed.

- AC1 hard-delete API: `DELETE /api/sponsor-crm/{organizations|contacts}/:id?hard=true`,
  admin/import-token authorized (`backend/src/routes/sponsorCrm.ts`, `backend/src/db/sponsorCrm.ts`,
  commits `8d1b554b`, `558a7926`, `80619836` — all ancestors of origin/main and of the
  deployed prod head `11646d14`). Live: GET after delete returns 404; records leave list/search totals.
- AC2 server-side guards: deals, linked contacts, notes/touches, `expectedVersion` → 409 with reason.
  Tests: `backend/tests/sponsor-crm-hard-delete.test.ts` (13 cases) and
  `backend/tests/sponsor-crm-hard-delete-race.test.ts` (7 cases, `80619836`).
  Live on prod: org delete with linked contact → exit 5 "Organization has linked contacts";
  `--expected-version 99` → exit 5 "Record was changed".
- AC3 cleanup of own history/index items: one version-conditional `TransactWriteItems`
  transaction deletes record + history + index entries (test "uses one version-conditional
  production transaction for record and cleanup"; dependency writers bump parent versions so
  nothing dangles; replay never recreates deleted indexes).
- AC4 CLI: `dataops crm company delete <id> --yes [--expected-version N]` and
  `dataops crm person delete <id> --yes [--expected-version N]`, exit 4 = not found,
  exit 5 = guard/version conflict; documented in `dataops crm --help` and `cli/skill/SKILL.md`
  (`cli/src/commands/crm.mjs`, commit `558a7926`).
- AC5 tests: backend hard-delete + race suites 20/20 pass and CLI crm suite 25/25 pass on
  origin/main (`78a95034`/`94a8b78e`), 2026-11-02.
- AC6 deploy + live smoke: Deploy DataOps V1 Lambda run 40911755653 succeeded (head `cdc574a8`
  contains `80619836`); fresh prod smoke 2026-11-02 on agent-created throwaway records
  (org `60d6b7d0…`, person `e651088e…`, prefix `zz-agent-smoke-a31a42d6-2f`): guards exit 5,
  deletes exit 0, show/re-delete exit 4, search totals empty afterwards.
- AC7 safety: only the two throwaway records were touched; no direct DB access, no AWS use,
  none of the 66 backfill records modified, no messages sent.
- AC8 report: `~/tmp/agent-reports/crm-hard-delete-endpoint-2026-10-24.md` (refreshed 2026-11-02).
