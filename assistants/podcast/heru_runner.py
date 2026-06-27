"""Heru runner with real-time unified event streaming."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

DEFAULT_ACTIVITY_TIMEOUT = 300
DEFAULT_ENGINE = "codex"


def _get_engine(engine_name: str):
    try:
        from heru import get_engine
    except ImportError as exc:
        raise RuntimeError(
            "Heru is required for live podcast assistant processing. "
            "Install Heru in the assistant environment before running /process or process_request.py."
        ) from exc
    return get_engine(engine_name)


def _safe_print(message: str) -> None:
    try:
        print(message, flush=True)
    except (UnicodeEncodeError, ValueError):
        print(message.encode("ascii", errors="replace").decode("ascii"), flush=True)


class HeruEvent:
    """Small wrapper around Heru unified JSONL events."""

    def __init__(self, event_data: dict):
        self.data = event_data
        self.kind = event_data.get("kind", "")
        self.engine = event_data.get("engine", "")

    @property
    def is_status(self) -> bool:
        return self.kind == "status"

    @property
    def is_message(self) -> bool:
        return self.kind == "message"

    @property
    def is_tool_call(self) -> bool:
        return self.kind == "tool_call"

    @property
    def is_tool_result(self) -> bool:
        return self.kind == "tool_result"

    @property
    def is_error(self) -> bool:
        return self.kind == "error"

    @property
    def continuation_id(self) -> str | None:
        value = self.data.get("continuation_id")
        return value if isinstance(value, str) and value else None


class HeruProgressFormatter:
    """Formats Heru unified events into human-readable progress messages."""

    @staticmethod
    def parse_jsonish(value: object) -> object:
        if not isinstance(value, str):
            return value
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value

    @staticmethod
    def format_tool_call(tool_name: str | None, tool_input: object) -> Optional[str]:
        if not tool_name:
            return None

        parsed_input = HeruProgressFormatter.parse_jsonish(tool_input)
        tool_args = parsed_input if isinstance(parsed_input, dict) else {}

        if tool_name in ("Read", "read"):
            return None
        if tool_name in ("TodoWrite", "todo_write"):
            todos = tool_args.get("todos", [])
            if not isinstance(todos, list) or not todos:
                return None
            completed = sum(1 for item in todos if isinstance(item, dict) and item.get("status") == "completed")
            in_progress = next(
                (
                    item.get("content", "")
                    for item in todos
                    if isinstance(item, dict) and item.get("status") == "in_progress"
                ),
                "",
            )
            suffix = f": {in_progress}" if in_progress else ""
            return f"Tasks [{completed}/{len(todos)}]{suffix}"
        if tool_name in ("Task", "Agent", "task", "agent"):
            description = tool_args.get("description") or tool_args.get("prompt") or ""
            return f"Agent: {str(description)[:120]}" if description else "Agent started"
        if tool_name in ("Write", "write"):
            file_path = tool_args.get("file_path") or tool_args.get("path") or "?"
            return f"Writing: `{Path(str(file_path)).name}`"
        if tool_name in ("Edit", "edit", "apply_patch"):
            file_path = tool_args.get("file_path") or tool_args.get("path") or "?"
            return f"Editing: `{Path(str(file_path)).name}`"
        if tool_name in ("Bash", "bash", "exec_command"):
            command = tool_args.get("command") or tool_args.get("cmd") or ""
            return f"Running: `{str(command)[:80]}`"
        if tool_name in ("Glob", "glob"):
            pattern = tool_args.get("pattern", "?")
            return f"Finding: {pattern}"
        if tool_name in ("Grep", "grep", "rg"):
            pattern = tool_args.get("pattern") or tool_args.get("query") or "?"
            path = tool_args.get("path") or tool_args.get("cwd") or "."
            return f"Searching: `{pattern}` in `{path}`"

        return f"Tool: {tool_name}"

    @staticmethod
    def format_tool_result(tool_output: object) -> Optional[str]:
        parsed_output = HeruProgressFormatter.parse_jsonish(tool_output)
        if isinstance(parsed_output, dict):
            if parsed_output.get("filePath") or parsed_output.get("file_path"):
                file_path = parsed_output.get("filePath") or parsed_output.get("file_path")
                num_lines = parsed_output.get("numLines") or parsed_output.get("num_lines")
                suffix = f" ({num_lines} lines)" if num_lines else ""
                return f"Read: `{Path(str(file_path)).name}`{suffix}"
            if parsed_output.get("numFiles") or parsed_output.get("filenames"):
                count = parsed_output.get("numFiles") or len(parsed_output.get("filenames", []))
                return f"Found: {count} files"
            if parsed_output.get("durationMs"):
                return f"Done in {parsed_output.get('durationMs')}ms"
        return None

    @staticmethod
    def format_message(content: str) -> str:
        return f"Message: {content[:200]}"

    @staticmethod
    def format_event(event: HeruEvent) -> Optional[str]:
        if event.is_tool_call:
            return HeruProgressFormatter.format_tool_call(
                event.data.get("tool_name"),
                event.data.get("tool_input"),
            )
        if event.is_tool_result:
            return HeruProgressFormatter.format_tool_result(event.data.get("tool_output"))
        if event.is_error:
            error = event.data.get("error") or event.data.get("content") or "Unknown error"
            return f"Error: {error}"
        if event.is_status:
            content = event.data.get("content")
            return f"Status: {content}" if content else None
        return None


class HeruRunner:
    """Runs a Heru engine and streams unified events in real time."""

    SESSION_FILE = ".tmp/heru_session_id.txt"

    def __init__(
        self,
        repo_path: Path,
        logs_dir: Path,
        *,
        engine_name: str = DEFAULT_ENGINE,
        session_id: Optional[str] = None,
        continuation_prompt: Optional[str] = None,
        activity_timeout: int = DEFAULT_ACTIVITY_TIMEOUT,
        model: Optional[str] = None,
    ):
        self.repo_path = repo_path
        self.logs_dir = logs_dir
        self.engine_name = engine_name
        self.resume_session_id = session_id
        self.continuation_prompt = continuation_prompt
        self.activity_timeout = activity_timeout
        self.model = model
        self.formatter = HeruProgressFormatter()
        self.session_id: Optional[str] = None

    def _session_file_path(self) -> Path:
        session_file = self.repo_path / self.SESSION_FILE
        session_file.parent.mkdir(parents=True, exist_ok=True)
        return session_file

    def _load_resume_session_id(self) -> str | None:
        if self.resume_session_id:
            return self.resume_session_id
        session_file = self._session_file_path()
        if not session_file.exists():
            return None
        try:
            value = session_file.read_text(encoding="utf-8").strip()
        except OSError:
            return None
        return value or None

    def _save_session_id(self, continuation_id: str) -> None:
        self.session_id = continuation_id
        try:
            self._session_file_path().write_text(continuation_id, encoding="utf-8")
        except OSError:
            pass

    def _clear_session_id(self) -> None:
        session_file = self._session_file_path()
        if session_file.exists():
            try:
                session_file.unlink()
            except OSError:
                pass

    def _run_command(
        self,
        prompt: str,
        on_event: Optional[Callable[[HeruEvent], None]] = None,
        on_progress: Optional[Callable[[str], None]] = None,
    ) -> tuple[int, str, str]:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        log_file = self.logs_dir / f"run_{timestamp}_{self.engine_name}.jsonl"
        self.logs_dir.mkdir(parents=True, exist_ok=True)

        resume_session_id = self._load_resume_session_id()
        effective_prompt = self.continuation_prompt if resume_session_id and self.continuation_prompt else prompt

        _safe_print(f"[HeruRunner] Engine: {self.engine_name}")
        _safe_print(f"[HeruRunner] Running: {effective_prompt[:80]}")
        _safe_print(f"[HeruRunner] Log: {log_file}")

        engine = _get_engine(self.engine_name)
        processed_chars = 0
        pending_text = ""

        def process_line(line: str) -> None:
            stripped = line.strip()
            if not stripped:
                return
            try:
                event = HeruEvent(json.loads(stripped))
            except json.JSONDecodeError:
                return

            if event.continuation_id:
                self._save_session_id(event.continuation_id)

            if on_event:
                on_event(event)

            progress = self.formatter.format_event(event)
            if progress:
                _safe_print(f"[{self.engine_name}] {progress}")
                if on_progress:
                    try:
                        on_progress(progress)
                    except Exception as exc:
                        _safe_print(f"[HeruRunner] Failed to send progress: {exc}")

        def handle_update(result) -> None:
            nonlocal processed_chars, pending_text
            new_text = result.stdout[processed_chars:]
            processed_chars = len(result.stdout)
            if not new_text:
                return

            pending_text += new_text
            parts = pending_text.splitlines(keepends=True)
            if parts and not (parts[-1].endswith("\n") or parts[-1].endswith("\r")):
                pending_text = parts[-1]
                complete_lines = parts[:-1]
            else:
                pending_text = ""
                complete_lines = parts

            for line in complete_lines:
                stripped = line.strip()
                if not stripped:
                    continue
                process_line(stripped)

        result = engine.run_live(
            effective_prompt,
            self.repo_path,
            model=self.model,
            resume_session_id=resume_session_id,
            on_started=lambda pid: _safe_print(f"[HeruRunner] PID: {pid}"),
            on_update=handle_update,
            inactivity_timeout_seconds=self.activity_timeout,
            emit_unified=True,
        )

        if pending_text.strip():
            process_line(pending_text)

        log_file.write_text(result.stdout, encoding="utf-8")
        _safe_print(f"[HeruRunner] Return code: {result.exit_code}")

        if result.exit_code == 0:
            self._clear_session_id()

        return result.exit_code, result.stdout, result.stderr

    def run_process_command(self, on_progress: Optional[Callable[[str], None]] = None) -> tuple[int, str, str]:
        prompt = "Read and execute the instructions in process/podcast.md."
        return self._run_command(prompt, on_progress=on_progress)

    def run_custom_prompt(self, prompt: str, on_progress: Optional[Callable[[str], None]] = None) -> tuple[int, str, str]:
        return self._run_command(prompt, on_progress=on_progress)
