# DataOps Backend

Single TypeScript backend for DataTalks.Club operations: tasks, workflow
bundles, recurring work, notifications, files, artifacts, assistant jobs, docs
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
production plugin registry is a static TypeScript list and is intentionally
empty until domain plugins are added. A request can make at most two model
calls: one `skill_load` call followed by one separate `skill_invoke` call.
Neither call can approve or execute domain work.

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
| `npm run export:templates:backend` | Export seed templates to content files |
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
| `npm run export:templates` | Export seed templates to content files |
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
recovery schedule, and encrypted retained failure queue. Lease duration,
deadline, pre-dispatch retry bound, recovery page size, and the 30-minute
presentation action lifetime are bounded stack parameters. The fake executor
is disabled in deployed functions by default and requires no provider secrets.
Uncertain effects are never blindly requeued: recovery follows the stored
provider-idempotency, correlation-lookup, or operator-reconciliation-only mode.

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
