# DONE evidence — intake 151a4c6c (DataOps + Hub MCP: RFC 9728 metadata, shared-issuer JWT only, CLI/service-token cutover, no dual-accept)

Landed on `intake-151a4c6c` (fast-forward of `main` at `7da2b424`) in five
commits: `6d8bdf4` (mcp), `7e4e27b` (mcp bundle), `360647d5` (api), `fe2e0931`
(cli), `cbb7e1ce` (docs). The shared issuer is the deployed DTC OAuth server
(`https://oauth.dtcdev.click`, repo `DataTalksClub/auth`, clients
`dtc-cli` / `dtc-mcp-public`, service clients `dataops-invoice-reader` →
`invoice:read` and `dataops-automation-service` → `dataops:read,dataops:write`,
audiences registered for hub MCP + DataOps MCP + the portal API).

- AC1 RFC 9728 metadata: `mcp/src/auth.mjs` serves
  `/.well-known/oauth-protected-resource` and the `/mcp` path form with
  `resource` = this origin's `/mcp`, `authorization_servers=[oauth.dtcdev.click]`,
  scopes and `bearer_methods_supported:["header"]`; unauthenticated calls get
  the RFC 6750 challenge with `resource_metadata` so MCP clients run the OAuth
  flow themselves. Tests: `mcp/test/mcp.test.mjs` ("advertises … on both
  well-known paths", "metadata and challenge shapes follow RFC 9728/6750").
- AC2 shared-issuer JWT only, no dual-accept: every `POST /mcp` verifies RS256
  against the issuer JWKS (kid-miss forces refresh), plus `iss`, `exp/nbf`
  (30 s skew) and RFC 8707 audience binding to this resource. Opaque portal
  tokens, foreign issuers/audiences and unsigned tokens all get 401 + challenge;
  the old upstream `/api/me` validation round-trip is deleted (`mcp/src/auth.mjs`,
  `proxy.mjs`; tests assert `/api/me` is never called and rejected tokens never
  reach upstream). Audience arrays containing the resource are accepted.
- AC3 portal API cutover: `backend/src/auth/sharedIssuer.ts` verifies the same
  JWTs against the portal's registered audiences (API + the three DataOps MCP
  resources) and maps humans by verified email; `client_credentials` service
  principals are scoped by the issuer catalog — invoice-reader keeps the
  invoice/finance read family, `dataops-automation-service` serves
  CRM/tasks/offers with `dataops:read/write` (`backend/src/auth/invoiceReader.ts`).
  Removed entirely: API-token store and device-grant routes
  (`backend/src/routes/cliAuth.ts`, `backend/src/db/cliAuth.ts`),
  `/api/tokens`, the `/device` approval page and frontend surface
  (`device.html`, `device-page.js`, `cli-sessions.js`,
  `surfaces/operations/device.js`, `styles/device.css` + wiring/manifests),
  the `dops_svc_` digest credential, and the
  `InvoiceReaderTokenSha256` infra/CI parameter (now `OauthIssuerUrl`).
  Disabled accounts refuse their JWTs by email mapping
  (`tests/user-lifecycle.test.ts`); garbage/expired/mis-issued/foreign-audience
  tokens fail closed (`tests/invoice-reader-auth.test.ts`).
- AC4 CLI cutover: `dataops login` runs the issuer's device grant
  (`dtc-cli`, resource-bound to the portal) through the shared
  `DataTalksClub/auth` loop, stores the access/refresh pair, refreshes
  proactively and on 401 with single-use rotating refresh tokens
  (`cli/src/commands/auth.mjs`, `cli/src/api.mjs`), `logout` revokes the
  refresh family at the issuer, service login mints per-run
  `client_credentials` tokens from an issuer client. `dataops tokens
  list/revoke` are removed with the store they drove. Tests: issuer-loop
  fixture in `cli/test/fixtures/dtc-auth`, login/deny/refresh in
  `cli/test/cli.test.mjs`, end-to-end service client in
  `cli/test/service-login.test.mjs`.
- AC5 deployment: the MCP Lambda bundles `auth.mjs` (`mcp/Makefile`), both the
  portal and MCP functions receive `OAUTH_ISSUER_URL`, and the deploy workflow
  passes `OauthIssuerUrl` (`infra/template.full.yaml`,
  `.github/workflows/deploy-dataops-v1.yml`); docs updated
  (`mcp/README.md`, `cli/README.md`, `cli/skill/SKILL.md`).

Verification on this tree (2026-11-02): `npm run test:mcp` 20/20;
`npm --prefix backend run typecheck` clean; CLI suite 475/476 and frontend
904/905 (both single failures pre-existing on main, baselined on a pristine
`7da2b424` worktree); CLI auth suites
`cli.test.mjs`+`service-login.test.mjs`+`work.test.mjs` 82/82; backend
full parity run 2058/2065 with all six remaining failures pre-existing,
environment-bound or timing-flaky (see below).

Pre-existing failures, unrelated to this intake (verified on a pristine
`7da2b424` worktree): `tests/vies-tax-pack-preflight.test.ts` (snapshot 409 vs
201, introduced by the finance statement-scoping change on main);
`tests/deployment-seed-contract.test.ts` ×3 (sandbox lacks `jq`);
`frontend-architecture.test.mjs` "uses the core HTML escaper in harnesses"
(`bookkeeping-reporting.test.mjs` from the same finance commit). Environment-bound on this Windows sandbox:
`tests/knowledge-backup.test.ts` (spawns `/bin/sh`),
`scripts/sam-build-artifact.test.mjs` ×1 (symlink EPERM), and
`tests/api-request-telemetry.test.ts` ×1 in the fully parallel aggregate only
(it passes solo and in two-file concurrent runs; its only diff here is the
retired `/api/tokens` family rows).

Deployment note: pushing `main` triggers the normal DataOps CI/CD (Lambda
deploy with OIDC). The DataOps MCP Function URL is unchanged, so registered
issuer audiences stay valid; the invoice-reader consumer (dapier) and Hub MCP
must present issuer tokens from their own cutover — this repo no longer
accepts the old `dops_svc_` digest.
