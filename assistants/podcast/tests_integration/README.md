# Real Engine Integration Tests

These tests launch real Codex and Claude CLIs through this project's `HeruRunner`.
They are intentionally outside `tests/` so the default suite stays deterministic and does
not consume agent quota.

Run both engines:

```bash
PODCAST_ASSISTANT_INTEGRATION_ENGINES=codex,claude uv run pytest tests_integration -q
```

Run one engine:

```bash
PODCAST_ASSISTANT_INTEGRATION_ENGINES=codex uv run pytest tests_integration/test_real_engines.py -q
```

Use `all` to enable all integration engines defined by this suite:

```bash
PODCAST_ASSISTANT_INTEGRATION_ENGINES=all uv run pytest tests_integration -q
```

Optional timeout override:

```bash
PODCAST_ASSISTANT_INTEGRATION_TIMEOUT_SECONDS=90 \
PODCAST_ASSISTANT_INTEGRATION_ENGINES=claude \
uv run pytest tests_integration/test_real_engines.py -q
```

Skip behavior:

- If `PODCAST_ASSISTANT_INTEGRATION_ENGINES` is unset, tests skip.
- If an engine is not listed, its tests skip.
- If the underlying CLI is not on `PATH`, that engine's tests skip.
