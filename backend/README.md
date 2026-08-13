# DataOps Backend

Single TypeScript backend for DataTalks.Club operations: tasks, workflow
cards, recurring work, notifications, files, artifacts, assistant jobs, docs
content API, search, and portal/auth.

This directory is an internal DataOps runtime surface. Operators should
experience it through the unified DataOps operations workspace, not as a
separate task product.

## Tech Stack

- **Backend**: AWS Lambda (TypeScript/Node.js)
- **Database**: DynamoDB execution tables owned by the DataOps stack
- **Frontend**: SPA with vanilla JavaScript for local/module workflows
- **Deployment**: single Lambda served from one Function URL

## Local Development

### Prerequisites

- Node.js 18+
- npm

### Setup

```bash
# from the DataOps repository root
npm ci
```

Run installs from the repository root. DataOps uses a top-level npm workspace
with `backend/` as the single Node package, and the root `package-lock.json`
is the only committed npm lockfile.

### Run the dev server

```bash
npm run dev
```

This starts a local HTTP server on `http://localhost:3000` with an in-process
DynamoDB (dynalite). No Docker or external database is needed.

### Seed default templates

```bash
npm run seed:users
npm run seed
```

From the repository root, `npm run seed:backend` runs both default user and
template seeders.

### Shared Telegram and assistant configuration

DataOps has one Telegram bot and one webhook:

```text
POST /api/webhook/telegram
```

The webhook routes ordinary messages and attachments to intake, `/podcast` to
the podcast assistant job flow, and `/social` to social drafting. Assistant
modules do not own separate Telegram tokens, polling processes, or webhooks.

Local development can use `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_WEBHOOK_SECRET`, and comma-separated
`TELEGRAM_ALLOWED_CHAT_IDS`. Production uses one out-of-band AWS Secrets
Manager JSON secret named by `TELEGRAM_INTEGRATION_SECRET_NAME`:

```json
{
  "botToken": "...",
  "webhookSecret": "...",
  "allowedChatIds": ["..."]
}
```

Do not commit real values. The webhook fails closed when its configuration is
missing, rejects a wrong Telegram secret header, and rejects chats outside the
allowlist.

The social drafting path is covered by local tests with mocked external
services. A direct local route call can still exercise the assistant without
Telegram:

```bash
curl -X POST http://localhost:3000/api/assistant-social-drafts/mock-telegram \
  -H 'Content-Type: application/json' \
  -d '{"text":"Draft Alexey social posts about the upcoming AI agents workshop"}'
```

Production-style external calls require managed credentials and account config:

| Variable | Purpose |
|----------|---------|
| `ZAI_API_KEY` | z.ai key for the Anthropic-compatible Messages API |
| `ZAI_MODEL` | Optional model override; defaults to `glm-5.2` |
| `ZAI_BASE_URL` | Optional z.ai base URL; defaults to `https://api.z.ai/api/anthropic` |
| `ZAI_MAX_TOKENS` | Optional max output tokens; defaults to `4096` |
| `TYPEFULLY_API_KEY` | Typefully API key for saved draft creation |
| `TYPEFULLY_SOCIAL_SET_ALEXEY` | Typefully social set id for Alexey / `Al_Grigor` |
| `TYPEFULLY_SOCIAL_SET_DATATALKSCLUB` | Typefully social set id for DataTalksClub |
| `TELEGRAM_INTEGRATION_SECRET_NAME` | Production shared Telegram JSON secret name |
| `TELEGRAM_WEBHOOK_SECRET` | Local-only webhook secret fallback |
| `TELEGRAM_BOT_TOKEN` | Local-only bot token fallback for replies |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Local-only comma-separated chat allowlist fallback |

The assistant route creates Typefully saved drafts only. It does not schedule or
publish posts. Automated tests use mocked z.ai and Typefully clients; real z.ai,
Typefully, and Telegram checks are human-gated.

### Conversational runtime boundary

The channel-independent conversational runtime is disabled by default. Its
production plugin registry is a static TypeScript list containing the narrow
`todo.propose_create` capability for linked admins and operators in private
Telegram chats. A request can make at most two model
calls: one `skill_load` call followed by one separate `skill_invoke` call.
Neither call can approve or execute domain work.

Rollout is owned by one strict immutable snapshot with exactly six controls:
Telegram ingress, execution leasing, the canonical plugin allowlist (`none`,
`todo`, `typefully`, or `todo,typefully`), Typefully external execution, voice,
and photo. All defaults are off. Plugin visibility, approval/dispatch
eligibility, result delivery, and media availability are derived from those
controls; retired independent flags are rejected. Disabled queued work remains
durable and unleased, while already dispatched work is not interrupted.

Ingress-off Telegram still authenticates the webhook, rejects raw updates over
256 KiB before JSON parsing, and may make one no-retry private maintenance or
group-redirect reply attempt with the configured Telegram API deadline capped
at five seconds. Timeout or network ambiguity is acknowledged safely with only
a fixed error code; it performs no conversational or domain write.
The legacy mutation handler is removed. `/todo`, `/social`, and `/podcast` are
static non-mutating guidance in every rollout state.

A shared proposal coordinator maps a loaded plugin action to its strict draft,
immutable proposal, preview, and approval controls. Channel adapters can supply
their own bounded context and per-request visible-plugin allowlist without
copying domain proposal logic. The todo adapter is the first registration; new
capabilities add an adapter and executor rather than another conversational
core.

The first model turn receives only the permission-filtered, public-safe catalog
and current request. Once it selects a plugin, core resolves the one matching
adapter and checks its build/schema identity and current permission. That
adapter performs source preflight before any plugin instructions, history, or
source context are loaded for the second turn. Its typed evidence and policy,
build, and schema digests are checked again and bound into the draft/proposal,
so a candidate cannot choose or substitute another adapter's schema or proof.

For todo, selected-plugin preflight classifies the normalized source request.
List separators or coordinated actions are rejected as multi-todo input. A
time, alarm, or notification creates a core-owned guard and requires the exact
`confirm date only` response; detached confirmation is rejected. The resulting
source-proof hash and confirmation state are stored in the draft and bound into
the immutable proposal. Candidate validation repeats the time/multi checks, so
a model cannot silently omit a time or collapse a batch.

Non-empty registries require a trusted build-artifact loader. Generated
metadata hashes the compiled plugin module and canonical manifest; startup
loads the compiled artifact independently and rejects missing, stale, or
tampered build/schema digests.

When the runtime is enabled, `ZAI_CONVERSATIONAL_API_KEY_SECRET_ARN` must name a
pre-created Secrets Manager JSON value with an `apiKey` field. The Lambda
receives only that ARN and resolves the value at runtime; do not place the key
in environment variables or deployment parameters. The default provider is the
z.ai Anthropic-compatible Messages endpoint with model `glm-5.2`.

## Repository-root commands

Use these from the DataOps repo root after `npm ci`:

| Command | Description |
|---------|-------------|
| `npm run dev:backend` | Start backend dev server with hot reload |
| `npm run test:backend` | Run backend unit tests |
| `npm run test:e2e:backend` | Run Playwright E2E tests |
| `npm run typecheck:backend` | Type-check source, tests, and scripts |
| `npm run build:backend` | Compile TypeScript and copy static assets |
| `npm run seed:backend` | Seed default local users and templates |
| `npm run validate:export:backend -- <export-dir>` | Validate a portable execution export |
| `npm run dry-run:import:backend -- <export-dir>` | Validate an import without writing data |
| `npm run restore:drill:backend -- --archive <file-or-s3-uri> --archive-checksum sha256:<hex>` | Verify an archive and generate restore evidence without writing production data |
| `npm run clean:backend` | Remove `backend/dist/` |

## Scripts

These package-local commands still work from inside `backend/` after the
root workspace install:

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with hot reload (tsx watch) |
| `npm start` | Start dev server (no watch) |
| `npm test` | Run all unit tests |
| `npm run test:e2e` | Run Playwright E2E tests |
| `npm run test:integration` | Run integration tests (Docker) |
| `npm run build` | Compile TypeScript to `dist/` and copy static assets |
| `npm run typecheck` | Type-check source, tests, and scripts |
| `npm run seed` | Seed default templates |
| `npm run seed:users` | Seed default local users |
| `npm run validate:export -- <export-dir>` | Validate a portable execution export |
| `npm run dry-run:import -- <export-dir>` | Validate an import without writing data |
| `npm run restore:drill -- --archive <file-or-s3-uri> --archive-checksum sha256:<hex>` | Verify and extract an archive, validate it, dry-run import it, and write restore evidence |
| `npm run clean` | Remove `dist/` directory |

## Testing

### Unit tests

```bash
npm test
```

Runs all unit tests in `tests/*.test.ts` using Node.js built-in test runner with tsx.

### E2E tests (Playwright)

```bash
# Install Playwright browser (first time only)
npx playwright install chromium

# Run all E2E tests
npm run test:e2e
```

The dev server starts automatically — no manual setup needed. Playwright is configured in `playwright.config.js` with `webServer` that auto-starts the local server.

#### Useful Playwright options

```bash
# Run a specific test file
npx playwright test e2e/api-tasks.spec.js

# Run tests matching a name
npx playwright test -g "creates a task"

# Verbose output
npx playwright test --reporter=list

# Run with visible browser
npx playwright test --headed

# Debug mode (step through)
npx playwright test --debug
```

### Integration tests (Docker)

```bash
npm run test:integration
```

Requires Docker. Runs the Lambda handler in a container against DynamoDB Local.

The transactional conversational-approval concurrency proof runs 25 full
approval calls against a fresh transaction-capable DynamoDB Local container:

```bash
npm run test:execution-transaction
```

The actor-owned todo proof runs two enabled proposal adapters through
selection/preflight/revision/approval, then runs the todo proposal, 25
concurrent approvals, deterministic task transaction, duplicate worker
delivery, lease/collision checks, and complete confirmed voice/corrected-photo
journeys against a fresh DynamoDB Local container:

```bash
npm run test:todo-transaction
```

## Build

```bash
npm run build
```

Compiles TypeScript to `dist/` (CommonJS) and copies `src/public/` and `src/pages/` static assets. The production Lambda handler entry point is `dist/handler.handler`.

## Conversational execution safety

Conversational approvals store only a SHA-256 hash of each opaque action token.
Approval atomically consumes the presentation, claims its immutable proposal,
and creates one deterministic queued execution attempt. Execution runs only in
the separate Stream/scheduled worker; the approval request never invokes an
executor.

The SAM stack owns the worker, filtered DynamoDB Stream event source, indexed
recovery schedule, an independent two-minute execution-worker health pulse,
and encrypted retained failure queue. The worker pulse performs only its fixed
heartbeat write and emits a zero-age metric after success; recovery and result
delivery emit their own zero-age metrics only after successful scheduled runs.
Only those three heartbeat alarms treat missing data as breaching, while
disabled schedules and their conditioned alarms remain inert. Lease duration,
deadline, pre-dispatch retry bound, recovery page size, and the 30-minute
presentation action lifetime are bounded stack parameters. The production
worker registers only capability-scoped executors. The test fake executor can
be enabled only when `NODE_ENV=test`; deployed functions cannot select it.
Uncertain effects are never blindly requeued: recovery follows the stored
provider-idempotency, correlation-lookup, or operator-reconciliation-only mode.

The todo executor writes one deterministic actor-owned task in a DynamoDB
transaction that condition-checks the current execution lease. It cannot
update, delete, list, or reassign tasks. A committed task is reconciled from its
deterministic ID after a lost response and is never deleted automatically.
The same transaction checks the enabled user role, exact permission revision,
exact active identity binding revision, and exact unexpired channel binding, so
revocation or rebinding between worker preflight and the effect cannot race a
task into existence.

Terminal execution state, its owner-private result payload, and a delivery
notification are finalized atomically. A separate scheduled dispatcher owns
the Telegram secret, rechecks the current identity and conversation bindings,
enabled user role, and sends the result once using Telegram's decimal
destination as a string. Ambiguous transport failures or a crash after the
delivery lease is claimed become `outcome_unknown` and are never blindly
resent. Result payloads and notifications expire after 30 days; portable
exports redact private result text, omit Telegram destinations, and make
undelivered notifications non-replayable.

## Project Structure

```
src/
  db/          - DynamoDB data layer
  routes/      - Route handlers for tasks, templates, assistants, intake, and files
  public/      - Frontend JS (vanilla, served as static files)
  pages/       - HTML templates
  router.ts    - Request routing
  handler.ts   - Lambda entry point
  types.ts     - Shared TypeScript interfaces
scripts/       - Dev server, seed, migration, and export scripts
tests/         - Unit tests (node:test)
e2e/           - Playwright E2E tests
```

## Docs

- [Imported source product specification](docs/specs.md)
- [Imported source development process](docs/PROCESS.md)
