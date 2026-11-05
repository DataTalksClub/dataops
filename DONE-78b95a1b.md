# DONE evidence — intake 78b95a1b (F10: dedicated DataOps MCP in this repo; no Dapier/AISL/agent tools; pocketshell-mcp archived)

Verification task on `origin/main` `ebf0fb18`, checked 2026-11-05. Verdict:
**done** — the dedicated DataOps MCP exists, is live in prod and is purely
DataOps-scoped; the old MCP repos are archived. One stale doc comment is
corrected in this PR; one auth-contract contradiction is documented below as a
remaining gap for the 151a4c6c owner (not changed here: the strict audience
binding is deliberate and tested there).

## (a) The dedicated DataOps MCP (inventory)

- Package `mcp/` — four dependency-free modules: `src/tools.mjs` (tool
  definitions + route allowlist), `src/proxy.mjs` (MCP Streamable HTTP,
  stateless JSON-RPC on `POST /mcp`), `src/auth.mjs` (shared-issuer JWT
  verification), `src/lambda.mjs` (Lambda Function URL adapter over the same
  proxy), plus `src/standalone.mjs` (local/self-hosted entry).
- Tools: exactly three — `dataops_read` (GET passthrough), `dataops_write`
  (POST/PUT/PATCH/DELETE passthrough), `dataops_guide` (static orientation).
  `mcp/test/mcp.test.mjs` asserts the tool list is exactly these three.
- Coverage: routes are allowlisted to `/api`, `/docs`, `/search`, `/knowledge`
  (auth/token routes, traversal, control chars and external URLs refused by
  `validateRoute`). This is a superset of the 24 commands pocketshell-mcp
  exposed: `POCKETSHELL_PARITY` in `src/tools.mjs` and `mcp/COVERAGE.md` map
  all 24 to their portal API families, and the test "covers every legacy
  command family" asserts all 24 validate. The CLI's full `/api/*` surface
  (tasks, cards, templates, calendar, bookkeeping, sponsor-crm, docs, kb,
  users, team, resources, notifications, files, events, podcast, offers,
  finance, …) passes the same allowlist; `/api/auth/*` and `/api/tokens` are
  excluded by design.
- Auth: RFC 9728 protected resource of the shared issuer
  `https://oauth.dtcdev.click`. Only RS256 access tokens minted by that issuer
  are accepted, verified locally against the issuer JWKS (kid-miss forces
  refresh), `iss`/`exp`/`nbf` checked and RFC 8707 audience bound to this
  origin's `/mcp` resource. Opaque portal tokens are rejected; the caller's
  JWT is forwarded unchanged; the server never mints, stores or logs
  credentials (`mcp/src/auth.mjs`, `mcp/README.md` "Auth (the shared issuer)").
- Deployment: dedicated `McpFunction` Lambda (`infra/template.full.yaml`,
  Function URL with `AuthType: NONE`, `DATAOPS_URL` + `OAUTH_ISSUER_URL` env),
  retained 30-day log group, `McpUrl` stack output; `mcp/Makefile`
  `build-McpFunction` packages the four modules; the deploy workflow reads
  `McpUrl` and smoke-tests `/health` plus an expected 401 on `tools/list`
  (`.github/workflows/deploy-dataops-v1.yml`, "Smoke test dedicated DataOps
  MCP"). Activated in `4540a5be` ("mcp: activate dedicated DataOps MCP Lambda
  runtime (F10, intake 78b95a1b)"), which removed the interim in-process
  `backend/src/mcp.ts` handler atomically.
- Live prod (read-only checks, 2026-11-05, Lambda Function URL host):
  - `GET /health` → `{"status":"ok","service":"dataops-mcp","upstream":"…"}`
    (upstream is the portal backend Function URL).
  - `GET /.well-known/oauth-protected-resource/mcp` → RFC 9728 metadata,
    `authorization_servers:["https://oauth.dtcdev.click"]`, and the bare
    `/.well-known/oauth-protected-resource` path also serves it.
  - `POST /mcp` unauthenticated → 401; the RFC 6750 challenge is present but
    Lambda Function URLs remap it to `x-amzn-Remapped-www-authenticate`
    (AWS runtime behaviour, not a code bug).

## (b) Scope: no Dapier/AISL/other-agent tools

- The only occurrences of "Dapier", "AISL" or "pocketshell" under `mcp/` are
  historical documentation: the README's provenance paragraph,
  `COVERAGE.md`, and the `POCKETSHELL_PARITY` map name. No tool definition,
  namespace, dispatch branch or manifest for another agent exists — the
  handler dispatches only `dataops_read`/`dataops_write`/`dataops_guide`.
- The Dapier code elsewhere in the repo (`backend/src/calendar/dapierBroker.ts`)
  is a portal product feature (owner-calendar Google free/busy via the Dapier
  calendar broker), not MCP tooling, and is not exposed through the MCP.
- On the retired surface, pocketshell-mcp's own final commits removed the
  Dapier and AISL namespaces (`48c1636`, "F10 AC6, intake 78b95a1b") and
  retired the repo README (`7f6e791`, "F10 AC7") — see `DONE-f14453ac.md`.

## (c) Old MCP repos archived

`gh repo view --json isArchived` on 2026-11-05:

- `DataTalksClub/operational-mcp` → `"isArchived": true`
- `PocketShell-io/pocketshell-mcp` → `"isArchived": true` (owner-archived
  2026-10-25; push rejected as read-only, per `DONE-f14453ac.md`)

## Gap analysis outcome

Tool surface: complete and scoped — nothing to add or remove. The PR carries
only a documentation correction: `mcp/src/tools.mjs`'s header comment still
referenced the removed interim in-Lambda handler `backend/src/mcp.ts`
(deleted in `4540a5be`); it now points at the dedicated Lambda adapter
`mcp/src/lambda.mjs`.

### Remaining gap 1 (owner decision, follow-up on 151a4c6c): README consumer contract vs audience binding

- `mcp/README.md` states: "`DATAOPS_TOKEN` is the shared-issuer access token
  (`dataops login` mints and refreshes it; **the same JWT works for the
  portal API and this MCP resource**)" and shows a Codex config with
  `bearer_token_env_var = "DATAOPS_TOKEN"`.
- Verified live 2026-11-05: `dataops login` mints tokens with
  `aud: "https://ops.dtcdev.click"` (the CLI requests
  `resource=https://ops.dtcdev.click` — `cli/src/commands/auth.mjs`
  `API_RESOURCE`). The MCP requires its own `/mcp` resource in `aud`
  (`authenticateRequest` → `invalid_target`; deliberately asserted by the
  `wrong_aud` test case in `mcp/test/mcp.test.mjs`). Same token:
  `dataops whoami` (portal) succeeds; `POST /mcp` returns 401.
- So the env-var consumer path documented in the README does not work against
  the MCP as deployed; today only tokens audience-bound to the MCP resource
  work (minted by OAuth-aware clients following the RFC 9728 challenge, or
  directly at the issuer with `resource=<McpUrl>`). The portal accepts both
  token shapes (`backend/src/auth/sharedIssuer.ts` default audiences =
  API + MCP resources), so forwarding works for either.
- Fix options: (1) MCP also accepts the portal API resource audience — makes
  the README true and is security-neutral because the proxy only ever
  forwards to that portal; or (2) keep the strict binding and correct the
  README plus document how to mint an MCP-bound token. Left to the 151a4c6c
  owner because the strict audience binding is an explicit, tested contract
  there ("foreign audiences fail closed").

### Remaining gap 2 (minor)

`https://mcp.ops.dtcdev.click` is registered as an allowed audience
(`sharedIssuer.ts`) and used in MCP tests, but does not resolve in DNS today;
`https://ops.dtcdev.click/mcp` returns 302 (the portal backend has had no
`/mcp` handler since `4540a5be`). The live endpoint is the `McpUrl` Lambda
Function URL, which is what the deploy workflow advertises.

## Verification on this tree (2026-11-05)

`node --test mcp/test/*.test.mjs` → 20/20 pass (`npm run test:mcp` target).
Prod checks were read-only: health, well-known metadata, challenge shape,
unauthenticated 401, CLI `whoami`, and one rejected `tools/list` attempt with
the CLI token. No secrets, tokens or token-store paths are committed.
