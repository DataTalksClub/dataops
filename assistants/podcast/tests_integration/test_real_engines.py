from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from heru import get_engine

from heru_runner import HeruRunner


INTEGRATION_ENV = "PODCAST_ASSISTANT_INTEGRATION_ENGINES"
TIMEOUT_ENV = "PODCAST_ASSISTANT_INTEGRATION_TIMEOUT_SECONDS"
ENGINE_NAMES = ("codex", "claude")
DEFAULT_TIMEOUT_SECONDS = 60


pytestmark = pytest.mark.integration


def enabled_engines() -> set[str]:
    raw = os.environ.get(INTEGRATION_ENV, "")
    if not raw.strip():
        return set()
    enabled = {item.strip().lower() for item in raw.split(",") if item.strip()}
    return set(ENGINE_NAMES) if enabled & {"all", "*"} else enabled


def require_real_engine(engine_name: str) -> None:
    enabled = enabled_engines()
    if not enabled:
        pytest.skip(f"{INTEGRATION_ENV} is unset; real engine tests are opt-in")
    if engine_name not in enabled:
        pytest.skip(f"{engine_name} is not enabled in {INTEGRATION_ENV}={','.join(sorted(enabled))}")

    engine = get_engine(engine_name)
    if not engine.is_available():
        pytest.skip(f"{engine_name} binary is not available on PATH")


def integration_timeout_seconds() -> int:
    raw = os.environ.get(TIMEOUT_ENV, str(DEFAULT_TIMEOUT_SECONDS)).strip()
    try:
        value = int(raw)
    except ValueError:
        pytest.fail(f"{TIMEOUT_ENV} must be an integer, got {raw!r}")
    if value <= 0:
        pytest.fail(f"{TIMEOUT_ENV} must be positive, got {value}")
    return value


def smoke_token(engine_name: str) -> str:
    return f"PODCAST_ASSISTANT_REAL_{engine_name.upper()}"


def parse_jsonl(stdout: str) -> list[dict]:
    events = []
    for line in stdout.splitlines():
        if not line.strip():
            continue
        events.append(json.loads(line))
    return events


def event_text(events: list[dict]) -> str:
    return "\n".join(str(event.get("content") or "") for event in events)


def assert_successful_runner_smoke(engine_name: str, tmp_path: Path) -> None:
    require_real_engine(engine_name)
    token = smoke_token(engine_name)
    runner = HeruRunner(
        tmp_path,
        tmp_path / "heru_runs",
        engine_name=engine_name,
        activity_timeout=integration_timeout_seconds(),
    )
    progress_messages: list[str] = []

    returncode, stdout, stderr = runner.run_custom_prompt(
        f"Reply with exactly this text and nothing else: {token}",
        on_progress=progress_messages.append,
    )

    assert returncode == 0, f"stderr:\n{stderr}\nstdout:\n{stdout}"
    events = parse_jsonl(stdout)
    assert events, "Expected Heru unified JSONL events"
    assert {event.get("engine") for event in events} == {engine_name}
    assert any(event.get("kind") == "message" for event in events), stdout
    assert token in event_text(events), stdout
    assert (tmp_path / "heru_runs").exists()
    assert list((tmp_path / "heru_runs").glob(f"run_*_{engine_name}.jsonl"))
    assert not (tmp_path / ".tmp" / "heru_session_id.txt").exists()


def test_real_codex_runner_smoke(tmp_path: Path) -> None:
    assert_successful_runner_smoke("codex", tmp_path)


def test_real_claude_runner_smoke(tmp_path: Path) -> None:
    assert_successful_runner_smoke("claude", tmp_path)
