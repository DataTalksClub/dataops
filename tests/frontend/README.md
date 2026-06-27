# Frontend tests

Playwright-driven smoke tests for the block editor and API endpoints.
They exercise the JS patchers (step body, section body, group title,
prose, caption, frontmatter scalar/list, procedure re-emit) and the
HTTP endpoints, then assert that the patched markdown still passes
`sop_lint.py`.

## Running

The dev stack must be up:

```bash
docker compose up -d --build
```

Then run a test with Playwright (the host Python with the playwright
package installed):

```bash
/usr/bin/python3 tests/frontend/test_block_editing.py
```

Each test file is self-contained.
