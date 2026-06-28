# DataOps Work Engine

DataOps work-engine module for DataTalks.Club operations tasks, workflow
bundles, recurring work, notifications, files, artifacts, and assistant jobs.

This directory is an internal DataOps runtime surface. Operators should
experience it through the unified DataOps operations workspace, not as a
separate task product.

## Tech Stack

- **Backend**: AWS Lambda (TypeScript/Node.js)
- **Database**: DynamoDB execution tables owned by the DataOps stack
- **Frontend**: SPA with vanilla JavaScript for local/module workflows
- **Deployment**: serverless, normally brokered by the DataOps portal

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
with `work-engine/` as the current Node package, and the root `package-lock.json`
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

From the repository root, `npm run seed:work-engine` runs both default user and
template seeders.

## Repository-root commands

Use these from the DataOps repo root after `npm ci`:

| Command | Description |
|---------|-------------|
| `npm run dev:work-engine` | Start work-engine dev server with hot reload |
| `npm run test:work-engine` | Run work-engine unit tests |
| `npm run test:e2e:work-engine` | Run Playwright E2E tests |
| `npm run typecheck:work-engine` | Type-check source, tests, and scripts |
| `npm run build:work-engine` | Compile TypeScript and copy static assets |
| `npm run seed:work-engine` | Seed default local users and templates |
| `npm run export:templates:work-engine` | Export seed templates to content files |
| `npm run validate:export:work-engine -- <export-dir>` | Validate a portable execution export |
| `npm run dry-run:import:work-engine -- <export-dir>` | Validate an import without writing data |
| `npm run clean:work-engine` | Remove `work-engine/dist/` |

## Scripts

These package-local commands still work from inside `work-engine/` after the
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

## Build

```bash
npm run build
```

Compiles TypeScript to `dist/` (CommonJS) and copies `src/public/` and `src/pages/` static assets. The production Lambda handler entry point is `dist/handler.handler`.

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
