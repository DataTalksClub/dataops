# Docs App Tests

Lightweight tests for docs app behavior that should run in CI without AWS
credentials, Docker, or the frontend dev server.

Run them from the repo root:

```bash
python3 -m pytest tests/docs_app
```

The frontend tests execute selected pure helpers from `frontend/src/app.js`
with Node.js. They cover direct document/folder URL behavior and internal
markdown/wiki links without launching a browser.

The backend tests use temporary content trees and cover document metadata,
path normalization, and structured SOP parsing.

Run the optional browser-backed local portal flow with Playwright:

```bash
uv run --project lambda-functions --extra search --with pytest --with playwright \
  python -m pytest tests/docs_app/test_playwright_local_docs_flow.py
```

That test starts the local Lambda API against a temporary `content/` tree,
serves the real frontend, and verifies search, document load, local edit/save,
reload, and content asset handling without GitHub or AWS credentials.
