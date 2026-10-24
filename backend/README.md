# DataOps Backend

Single TypeScript backend for DataTalks.Club operations: tasks, workflow
cards, recurring work, notifications, files, artifacts, docs content API,
search, and portal/auth. There is no built-in assistant; external assistants
use the same work API as the UI.

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
npx playwright test e2e/canonical-route-parity.spec.js

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

## Build

```bash
npm run build
```

Compiles TypeScript to `dist/` (CommonJS) and copies `src/public/` and `src/pages/` static assets. The production Lambda handler entry point is `dist/handler.handler`.

## Project Structure

```
src/
  db/          - DynamoDB data layer
  identity/    - Verified actor resolution, safe team/work projections, owner filters
  routes/      - Route handlers for tasks, cards, templates, artifacts, intake, and files
  public/      - Frontend JS (vanilla, served as static files)
  pages/       - HTML templates
  router.ts    - Request routing
  handler.ts   - Lambda entry point
  types.ts     - Shared TypeScript interfaces
scripts/       - Dev server, seed, migration, and export scripts
tests/         - Unit tests (node:test)
e2e/           - Playwright E2E tests
```

## Identity, team visibility, and the work authorization boundary

Every interactive Task/Card/team request resolves one verified actor through
`src/identity/actor.ts`. Identity comes from the browser cookie session, a
bearer session, or an API token; a deleted, disabled, missing-role, or
unsupported-role actor is refused before any read or write. Interactive routes
never fall back to `system`, `portal-admin`, a requested owner, or an assignee.

- `GET /api/me` returns the signed-in identity (`disabled` always explicit, no
  password or session material). `/work/api/*` is the same surface.
- `GET /api/team-members` is the safe work directory: id, display name,
  supported role, and availability only. `GET /api/users` stays the
  account-management surface for the Admin/Users screen and is not used by
  routine work views.
- `GET /api/tasks` and `GET /api/cards` accept
  `owner=me|team|unassigned|<user-id>`, alone or combined with one existing
  filter. `me` comes from the verified actor, `team` means active members, and
  a concrete reference answers with an honest availability projection even when
  that teammate is disabled or no longer exists.
- Tasks keep `assigneeId` and add a safe `assignee` plus `historyActors`
  projection. Cards persist an optional administrative `ownerId` and add safe
  `owner` and `taskAssignees` projections.
- Ordinary Task execution (waiting, follow-up, response, completion, reopen,
  and general metadata) works on an own, teammate, or unassigned Task, keeps the
  assignee, and records the verified actor. Assignment, deletion, Task/Card
  membership changes outside a Card the operator owns, and direct Card
  administration are admin-only or owner-only and answer `403` with
  `work_admin_forbidden`; unsupported-role team reads answer `403` with
  `team_read_forbidden`.

## Docs

- [Imported source product specification](docs/specs.md)

### Agent and invoice reader service credential

Unattended invoice checks and agent CRM operations use a dedicated `dops_svc_` bearer credential.
The backend stores only its SHA256 verifier, supplied by
`InvoiceReaderTokenSha256` through CI's `INVOICE_READER_TOKEN_SHA256` secret.
An empty verifier disables service access; replacing it invalidates the previous
credential after deployment. This service holds `invoices:read`, `crm:read`, and
`crm:write` scopes: it permits invoice reads, CRM directory and record operations,
and CRM-associated task management. It cannot manage tokens, users, or unassociated
operations data.

The CLI supports `login --service-token-stdin --url <portal>` and verifies the
credential before saving its existing owner-only profile. `whoami` identifies the
service and its scopes (`invoices:read`, `crm:read`, `crm:write`). Service logout
removes the local copy; global revocation is performed by rotating or disabling
the deployment verifier.
