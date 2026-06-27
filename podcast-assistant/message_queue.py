"""Message queue for sending Telegram updates in batches."""

from __future__ import annotations

import asyncio


def _safe_print(message: str) -> None:
    try:
        print(message, flush=True)
    except (UnicodeEncodeError, ValueError):
        print(message.encode("ascii", errors="replace").decode("ascii"), flush=True)


class MessageQueue:
    """Collects messages and sends them periodically to avoid Telegram rate limits."""

    def __init__(self, chat_id: int, bot, send_interval: float = 5.0):
        self.chat_id = chat_id
        self.bot = bot
        self._messages: list[str] = []
        self._lock = asyncio.Lock()
        self._task = None
        self._stop_event = asyncio.Event()
        self._last_send_time = None
        self._send_interval = send_interval
        self._total_sent = 0

    async def start(self) -> None:
        if self._task is None or self._task.done():
            self._stop_event.clear()
            self._task = asyncio.create_task(self._worker())

    async def stop(self) -> None:
        self._stop_event.set()
        if self._task and not self._task.done():
            try:
                await asyncio.wait_for(self._task, timeout=30.0)
            except asyncio.TimeoutError:
                _safe_print("[MessageQueue] Worker timeout")

    def put_sync(self, message: str) -> None:
        self._messages.append(message)

    async def put(self, message: str) -> None:
        async with self._lock:
            self._messages.append(message)

    async def _worker(self) -> None:
        loop = asyncio.get_event_loop()
        self._last_send_time = loop.time()
        _safe_print(f"[MessageQueue] Started, interval: {self._send_interval}s")

        while not self._stop_event.is_set():
            current_time = loop.time()
            wait_time = max(0, self._send_interval - (current_time - self._last_send_time))
            if wait_time:
                await asyncio.sleep(min(wait_time, 0.5))
                continue
            await self._send_batch()

        await self._send_batch()
        _safe_print(f"[MessageQueue] Stopped. Total sent: {self._total_sent}")

    async def _send_batch(self) -> None:
        async with self._lock:
            batch = list(self._messages)
            self._messages.clear()

        if not batch:
            await asyncio.sleep(0.1)
            return

        combined = "\n".join(batch)
        if len(combined) > 4000:
            combined = combined[:4000] + "\n... (truncated)"

        await self.bot.send_message(chat_id=self.chat_id, text=combined, parse_mode=None)
        self._total_sent += len(batch)
        self._last_send_time = asyncio.get_event_loop().time()
        _safe_print(f"[MessageQueue] Sent batch of {len(batch)} messages")
