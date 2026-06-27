"""Progress tracker for displaying Heru operations in Telegram."""

from __future__ import annotations

import asyncio
import re
from collections import defaultdict


def _safe_print(message: str) -> None:
    try:
        print(message, flush=True)
    except (UnicodeEncodeError, ValueError):
        print(message.encode("ascii", errors="replace").decode("ascii"), flush=True)


class ProgressTracker:
    """Tracks Heru progress in a single editable Telegram message."""

    MAX_VISIBLE = 7

    def __init__(self, bot, chat_id: int):
        self.bot = bot
        self.chat_id = chat_id
        self.message_id = None
        self.commands: list[tuple[str, str]] = []
        self.counters = defaultdict(int)
        self._dedup_cache = {}
        self._loop: asyncio.AbstractEventLoop | None = None

    async def start(self) -> bool:
        self._loop = asyncio.get_event_loop()
        message = await self.bot.send_message(
            chat_id=self.chat_id,
            text="Processing...",
            parse_mode=None,
        )
        if message:
            self.message_id = message.message_id
            _safe_print("[ProgressTracker] Started")
        return self.message_id is not None

    async def finish(self) -> None:
        if self.message_id:
            await self._update_message(done=True)
            _safe_print(f"[ProgressTracker] Finished ({len(self.commands)} commands)")

    def add_message(self, message: str) -> None:
        marker, text, category = self._parse_message(message)
        if self._loop is not None:
            asyncio.run_coroutine_threadsafe(
                self.add_command(marker, text, category),
                self._loop,
            )

    async def add_command(self, marker: str, text: str, category: str | None = None) -> None:
        if category:
            self.counters[category] += 1

        if category in ("read", "edit", "write"):
            match = re.search(r"`([^`]+\.\w+)`", text)
            if match:
                key = (category, match.group(1))
                if key in self._dedup_cache:
                    return
                self._dedup_cache[key] = True
        else:
            self._dedup_cache.clear()

        self.commands.append((marker, text))
        await self._update_message()

    def _parse_message(self, message: str) -> tuple[str, str, str | None]:
        patterns = [
            (r"Read: (.*)", "[read]", "read"),
            (r"Finding: (.*)", "[find]", "found"),
            (r"Found: (.*)", "[find]", "found"),
            (r"Editing: (.*)", "[edit]", "edit"),
            (r"Writing: (.*)", "[write]", "write"),
            (r"Running: (.*)", "[run]", None),
            (r"Agent: (.*)", "[agent]", "agent"),
            (r"Tasks (.*)", "[tasks]", "tasks"),
            (r"Error: (.*)", "[error]", "error"),
            (r"Status: (.*)", "[status]", None),
        ]
        for pattern, marker, category in patterns:
            match = re.match(pattern, message)
            if match:
                return marker, match.group(1), category
        return "[info]", message, None

    def _format_message(self, done: bool = False) -> str:
        status = "Done" if done else "Processing..."
        total = len(self.commands)
        visible = self.commands[-self.MAX_VISIBLE:]
        hidden = total - len(visible)

        counter_lines = []
        if self.counters.get("read", 0) > 1:
            counter_lines.append(f"[read] {self.counters['read']} files")
        if self.counters.get("edit", 0) > 1:
            counter_lines.append(f"[edit] {self.counters['edit']} files")
        if self.counters.get("write", 0) > 1:
            counter_lines.append(f"[write] {self.counters['write']} files")
        if self.counters.get("agent", 0) > 0:
            counter_lines.append(f"[agent] {self.counters['agent']} agents")

        lines = [status]
        if counter_lines:
            lines.extend(["", *counter_lines])
        if hidden:
            lines.extend(["", f"({hidden} earlier commands hidden)"])
        if visible:
            lines.append("")
            lines.extend(f"{marker} {text}" for marker, text in visible)
        return "\n".join(lines)

    async def _update_message(self, done: bool = False) -> None:
        if not self.message_id:
            return

        formatted = self._format_message(done)
        if len(formatted) > 4000:
            formatted = formatted[:4000] + "\n... (truncated)"

        try:
            await self.bot.edit_message_text(
                chat_id=self.chat_id,
                message_id=self.message_id,
                text=formatted,
                parse_mode=None,
            )
        except Exception as exc:
            _safe_print(f"[ProgressTracker] Edit error: {exc}")
