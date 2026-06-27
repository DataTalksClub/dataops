# DataTasks

A unified task management app for community managers and small teams. Combines Trello-like project templates with a spreadsheet-like task list view.

## Tech Stack

- **Backend**: AWS Lambda (TypeScript/Node.js)
- **Database**: DynamoDB
- **Frontend**: SPA with vanilla JavaScript
- **Deployment**: Fully serverless

## Local Development

### Prerequisites

- Node.js 18+
- npm

### Setup

```bash
npm install
```

### Run the dev server

```bash
npm run dev
```

This starts a local HTTP server on `http://localhost:3000` with an in-process DynamoDB (dynalite). No Docker or external database needed.

### Seed default templates

```bash
npm run seed
```

## Scripts

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
  db/          — DynamoDB data layer (client, setup, tasks, projects, templates, recurring)
  routes/      — Route handlers (projects, templates, recurring, telegram, email)
  public/      — Frontend JS (vanilla, served as static files)
  pages/       — HTML templates
  router.ts    — Request routing
  handler.ts   — Lambda entry point
  types.ts     — Shared TypeScript interfaces
scripts/       — Dev server, seed, migration scripts
tests/         — Unit tests (node:test)
e2e/           — Playwright E2E tests
```

## Docs

- [Product Specification](docs/specs.md)
- [Development Process](docs/PROCESS.md)
