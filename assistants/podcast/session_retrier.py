"""Automatic retry support for interrupted Heru sessions."""

from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path
from typing import Callable, Optional

from heru_runner import HeruRunner


class SessionRetrier:
    """Runs the processing command and retries resumable Heru sessions."""

    MAX_RETRIES = 3

    def __init__(self, repo_path: Path, logs_dir: Path, *, engine_name: str, model: str | None = None):
        self.repo_path = repo_path
        self.logs_dir = logs_dir
        self.engine_name = engine_name
        self.model = model

    def get_commit_hash(self) -> str | None:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=self.repo_path,
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode != 0:
            return None
        return result.stdout.strip()

    def is_git_repo(self) -> bool:
        result = subprocess.run(
            ["git", "rev-parse", "--is-inside-work-tree"],
            cwd=self.repo_path,
            capture_output=True,
            text=True,
            timeout=5,
        )
        return result.returncode == 0 and result.stdout.strip() == "true"

    def inbox_raw_files(self) -> list[str]:
        raw_dir = self.repo_path / "inbox" / "raw"
        if not raw_dir.exists():
            return []
        return [p.name for p in raw_dir.iterdir() if p.is_file() and not p.name.startswith(".")]

    def get_session_id(self) -> Optional[str]:
        session_file = self.repo_path / ".tmp" / "heru_session_id.txt"
        if not session_file.exists():
            return None
        try:
            value = session_file.read_text(encoding="utf-8").strip()
        except OSError:
            return None
        return value or None

    async def run_with_auto_retry(
        self,
        chat_id: int,
        bot,
        on_progress: Callable[[str], None],
        session_id: Optional[str] = None,
    ) -> tuple[bool, Optional[str], Optional[str]]:
        commit_before = self.get_commit_hash()
        raw_before = self.inbox_raw_files()
        print(f"[SessionRetrier] Engine: {self.engine_name}", flush=True)
        print(f"[SessionRetrier] Commit before: {commit_before}", flush=True)
        print(f"[SessionRetrier] Inbox files before: {len(raw_before)}", flush=True)

        runner = HeruRunner(
            self.repo_path,
            self.logs_dir,
            engine_name=self.engine_name,
            session_id=session_id,
            model=self.model,
        )

        returncode, stdout, stderr = await asyncio.to_thread(
            runner.run_process_command,
            on_progress=on_progress,
        )

        if returncode == 0:
            return self._success_result(commit_before, raw_before)

        print(f"[SessionRetrier] Session failed with exit code {returncode}; trying resume", flush=True)
        return await self._retry_loop(chat_id, bot, on_progress, commit_before, returncode, raw_before)

    def _success_result(
        self,
        commit_before: str | None,
        raw_before: list[str],
    ) -> tuple[bool, Optional[str], Optional[str]]:
        commit_after = self.get_commit_hash()
        print(f"[SessionRetrier] Commit after: {commit_after}", flush=True)

        if commit_before and commit_after and commit_after != commit_before:
            return True, commit_after, None

        if raw_before:
            remaining = self.inbox_raw_files()
            if remaining:
                return False, None, (
                    "Session exited successfully but made no commit and left "
                    f"{len(remaining)} of {len(raw_before)} inbox files unprocessed. "
                    "Check the latest run log in heru_runs/."
                )

        return True, None, None

    async def _retry_loop(
        self,
        chat_id: int,
        bot,
        on_progress: Callable[[str], None],
        commit_before: str | None,
        last_returncode: int,
        raw_before: list[str],
    ) -> tuple[bool, Optional[str], Optional[str]]:
        for attempt in range(1, self.MAX_RETRIES + 1):
            session_id = self.get_session_id()
            if not session_id:
                return False, None, f"Session failed with exit code {last_returncode} and no Heru session ID was saved"

            print(f"[SessionRetrier] Resume attempt {attempt}/{self.MAX_RETRIES}", flush=True)
            await bot.send_message(
                chat_id=chat_id,
                text=f"Session failed. Resuming with {self.engine_name}... ({attempt}/{self.MAX_RETRIES})",
                parse_mode=None,
            )

            runner = HeruRunner(
                self.repo_path,
                self.logs_dir,
                engine_name=self.engine_name,
                session_id=session_id,
                continuation_prompt="Please continue with the podcast document processing task.",
                model=self.model,
            )

            returncode, stdout, stderr = await asyncio.to_thread(
                runner.run_process_command,
                on_progress=on_progress,
            )

            if returncode == 0:
                success, commit, error = self._success_result(commit_before, raw_before)
                if success:
                    return success, commit, error
                return False, None, (
                    f"Session resumed but did not finish cleanly after {attempt} retries. {error}"
                )

            last_returncode = returncode

        return False, None, f"Session failed {self.MAX_RETRIES + 1} times; last exit code: {last_returncode}"
