# DONE evidence — intake f14453ac (pocketshell-mcp CI red: npm audit body-parser/fast-uri on main 48c1636)

Resolution: **no fix lands — the repository is archived (read-only) and the red
run is permanently frozen**. This intake cannot be closed by a code change, and
the successor system carries no such vulnerability. Evidence below.

## The failure (verified)

- GitHub Actions "Test" run #18 on commit `48c1636` ("Remove Dapier and AISL
  namespaces (F10 AC6, intake 78b95a1b)"), Oct 25 2026 — the only red run in the
  repo. Failing step: `npm audit --omit=dev --audit-level=moderate`.
- Findings: `body-parser` 2.0.0-2.3.0 (high) — denial of service via trailing
  bytes after a compressed request body (GHSA-27r3-jxmh-p828), reached via
  `express@5.3.0`; `fast-uri` 3.0.0-3.1.8 (moderate) — scheme spoofing, path
  equivalence, host confusion and scheme injection in suffix references, reached
  via `@modelcontextprotocol/sdk@1.32.1 -> ajv@8.20.0`.
- Repo: `PocketShell-io/pocketshell-mcp` (the intake title's "operational-mcp"
  org is a munged reference; `48c1636` exists only in this repo). Cloned via
  the workspace SSH key as `alexeygrigorev`.

## Why no fix is possible or desirable

- The repo was archived by the owner on Oct 25 2026: push is rejected with
  "This repository was archived so it is read-only". The last main commit
  `7f6e791` (README: retired; F10 AC7, `[skip ci]`) documents the retirement;
  the MCP hub is no longer deployed and DataOps tools moved to this repo's
  `mcp/` package (per `mcp/README.md`).
- Successor verified clean: `mcp/package.json` declares no dependencies at all
  (three dependency-free modules), so the express/body-parser and
  MCP-SDK/ajv/fast-uri chains do not exist in dataops; no dataops CI workflow
  runs an `npm audit` gate.

## The verified-but-unlandable fix (preserved for an owner if ever wanted)

Prepared on a scratch clone (deleted after), patches in
`pocketshell-mcp-ci-fix-f14453ac.patch` (untracked):

1. Lockfile-only bump: body-parser 2.3.0 -> 2.4.0, fast-uri 3.1.8 -> 3.1.9
   (+ dev undici 8.12.3). Both fixed versions stay inside the existing express
   and `@modelcontextprotocol/sdk` ranges — reproducible with `npm audit fix`
   on the old lockfile. Audit gate passes (0 vulnerabilities).
2. README one-liner: `7f6e791` had pasted the deployed lambda-url into the
   public README, so `scripts/check-public.mjs` fails on main HEAD (hidden by
   that commit's `[skip ci]`); replace the concrete URL with the established
   "read the McpUrl from the application stack output" phrasing.

Verification: full CI sequence run locally — `build-dataops` and
`build-client` green (vendor bundles built from pinned upstream commits), audit
gate green, `check-public` green after the README fix, `npm test` failure set
byte-identical before and after the bump (8 Windows-only platform failures:
POSIX 0o600 modes, bwrap sandbox, Inspector TLS harnesses — all green on the
ubuntu CI runner). `git format-patch 7f6e791..69f8a2b` if the raw patch is
needed again.

Unarchiving and re-archiving the repo just to clear a frozen badge on a
retired service is deliberately not attempted: it maintains a dead surface for
no consumer.

## CORRECTION (2026-11-05, re-verification by the handoff drain)

Two statements above are wrong; the resolution conclusion changes:

1. **"`48c1636` exists only in this repo" is false.** The commit exists
   identically (same SHA) in `DataTalksClub/operational-mcp` — that repo IS the
   continuation referenced by the intake title; `PocketShell-io/pocketshell-mcp`
   is a same-history mirror of it. Both are archived.
2. **"No fix lands" is false.** The exact fix preserved above as a patch was
   landed ~40 minutes after the red run in `DataTalksClub/operational-mcp`:
   - `721a187` "Bump body-parser to 2.4.0 and fast-uri to 3.1.9 via npm audit
     fix" — lockfile-only (12+/12−), matching this file's patch point 1.
   - `de894ae` "README: drop literal DataOps endpoint URL so check-public
     passes" — matching patch point 2.
   - CI "Test" run `40243627919` on main HEAD `de894ae` (branch main) is
     **green**: https://github.com/DataTalksClub/operational-mcp/actions/runs/40243627919

Resolution: fixed on main of the continuing repo (`DataTalksClub/operational-mcp`)
the same evening; `PocketShell-io/pocketshell-mcp` remains a frozen archived
mirror and is not the record of continuation. Evidence verified via
`gh run view 40243627919` and the run log's advisory listing on 2026-11-05.

