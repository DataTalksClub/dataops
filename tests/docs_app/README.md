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
