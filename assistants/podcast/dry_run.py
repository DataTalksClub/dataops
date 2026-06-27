"""Deterministic Podcast Assistant dry-run boundary for DataOps job payloads."""

from __future__ import annotations

import hashlib
import json
from typing import Any


def podcast_job_dry_run_metadata(job_payload: dict[str, Any]) -> dict[str, Any]:
    """Return stable output metadata without Telegram, Heru, Codex, or Claude."""
    job_id = str(job_payload.get("id") or job_payload.get("assistant_job_id") or "")
    title = str(job_payload.get("title") or "Podcast assistant job")
    input_refs = job_payload.get("inputRefs") or job_payload.get("input_refs") or []
    if not isinstance(input_refs, list):
        input_refs = []

    normalized = {
        "assistant_job_id": job_id,
        "assistant_type": "podcast",
        "input_ref_count": len(input_refs),
        "output_kind": "podcast-prep-draft",
        "runner": "podcast-dry-run",
        "title": title,
    }
    checksum = hashlib.sha256(json.dumps(normalized, sort_keys=True).encode("utf-8")).hexdigest()
    normalized["checksum"] = f"sha256:{checksum}"
    return normalized
