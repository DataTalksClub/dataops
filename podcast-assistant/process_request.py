#!/usr/bin/env python
"""Run a one-off Heru request against this project."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from dotenv import load_dotenv

from heru_runner import DEFAULT_ENGINE, HeruRunner


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a Heru prompt in the podcast assistant repo.")
    parser.add_argument("prompt", nargs="+", help="Prompt text to send to the selected engine.")
    parser.add_argument("--engine", default=None, help="Heru engine name, for example codex or claude.")
    parser.add_argument("--model", default=None, help="Optional model override passed through Heru.")
    return parser.parse_args()


def main() -> int:
    load_dotenv()
    args = parse_args()
    prompt = " ".join(args.prompt)
    repo_path = Path.cwd()
    logs_dir = repo_path / "heru_runs"
    engine_name = args.engine or os.getenv("HERU_ENGINE") or DEFAULT_ENGINE

    runner = HeruRunner(repo_path, logs_dir, engine_name=engine_name, model=args.model)
    returncode, stdout, stderr = runner.run_custom_prompt(prompt, on_progress=None)

    if returncode == 0:
        print("\nSuccess")
    else:
        print(f"\nFailed with code {returncode}")
        if stderr:
            print(f"Stderr: {stderr}")
    return returncode


if __name__ == "__main__":
    raise SystemExit(main())
