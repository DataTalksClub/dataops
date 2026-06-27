#!/usr/bin/env python
"""Import actual podcast transcript questions from datatalksclub.github.io."""

from __future__ import annotations

import argparse
import csv
import json
import re
import subprocess
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path

import yaml

try:
    from build_podcast_knowledge_base import classify_question, slugify
except ModuleNotFoundError:
    from scripts.build_podcast_knowledge_base import classify_question, slugify


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_REPO_DIR = REPO_ROOT / ".tmp" / "datatalksclub.github.io"
DEFAULT_PODCAST_DIR = DEFAULT_REPO_DIR / "_podcast"
DATA_DIR = REPO_ROOT / "data"
KB_DIR = REPO_ROOT / "knowledge_base"
SOURCE_URL = "https://github.com/DataTalksClub/datatalksclub.github.io/tree/main/_podcast"
GIT_URL = "https://github.com/DataTalksClub/datatalksclub.github.io.git"


@dataclass
class ActualQuestion:
    episode_id: str
    source_file: str
    source_url: str
    title: str
    season: int | None
    episode: int | None
    guest_ids: str
    time: str
    seconds: int | None
    question_order: int
    question_category: str
    question_text: str
    context_header: str


@dataclass
class ActualEpisode:
    episode_id: str
    source_file: str
    source_url: str
    title: str
    short: str | None
    season: int | None
    episode: int | None
    guest_ids: list[str]
    question_count: int
    categories: list[str]


def ensure_sparse_checkout(repo_dir: Path) -> None:
    if (repo_dir / "_podcast").exists():
        return
    repo_dir.parent.mkdir(parents=True, exist_ok=True)
    if repo_dir.exists():
        raise SystemExit(f"{repo_dir} exists but does not contain _podcast")
    subprocess.run(
        ["git", "clone", "--depth", "1", "--filter=blob:none", "--sparse", GIT_URL, str(repo_dir)],
        check=True,
        cwd=REPO_ROOT,
    )
    subprocess.run(
        ["git", "-C", str(repo_dir), "sparse-checkout", "set", "_podcast"],
        check=True,
        cwd=REPO_ROOT,
    )


def repo_commit(repo_dir: Path) -> str | None:
    result = subprocess.run(
        ["git", "-C", str(repo_dir), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def load_frontmatter(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---"):
        return {}
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}
    payload = yaml.safe_load(parts[1]) or {}
    return payload if isinstance(payload, dict) else {}


def clean_question(line: str) -> str:
    line = re.sub(r"\[[^\]]+\]", "", line)
    line = re.sub(r"\([^)]*chuckles[^)]*\)", "", line, flags=re.I)
    line = re.sub(r"\s+", " ", line).strip()
    return line.strip("\"' ")


def is_actual_question(line: str) -> bool:
    if "?" not in line:
        return False
    lowered = line.lower()
    if lowered.startswith(("thanks", "thank you")) and lowered.count("?") == 0:
        return False
    return len(line) >= 8


def extract_questions(path: Path, payload: dict) -> list[ActualQuestion]:
    transcript = payload.get("transcript") or []
    if not isinstance(transcript, list):
        return []

    title = str(payload.get("title") or path.stem.replace("-", " ").title())
    episode_id = slugify(f"{payload.get('season', 's')}-{payload.get('episode', path.stem)}-{path.stem}")
    source_file = f"_podcast/{path.name}"
    source_url = f"{SOURCE_URL}/{path.name}"
    guests = payload.get("guests") or []
    if not isinstance(guests, list):
        guests = [str(guests)]

    questions: list[ActualQuestion] = []
    current_header = ""
    for item in transcript:
        if not isinstance(item, dict):
            continue
        if item.get("header"):
            current_header = str(item.get("header") or "")
            continue
        if item.get("who") != "Alexey":
            continue
        line = clean_question(str(item.get("line") or ""))
        if not is_actual_question(line):
            continue
        questions.append(
            ActualQuestion(
                episode_id=episode_id,
                source_file=source_file,
                source_url=source_url,
                title=title,
                season=payload.get("season") if isinstance(payload.get("season"), int) else None,
                episode=payload.get("episode") if isinstance(payload.get("episode"), int) else None,
                guest_ids=", ".join(str(guest) for guest in guests),
                time=str(item.get("time") or ""),
                seconds=item.get("sec") if isinstance(item.get("sec"), int) else None,
                question_order=len(questions) + 1,
                question_category=classify_question(line),
                question_text=line,
                context_header=current_header,
            )
        )
    return questions


def build_episode_records(files: list[Path], questions_by_episode: dict[str, list[ActualQuestion]]) -> list[ActualEpisode]:
    episodes = []
    for path in files:
        payload = load_frontmatter(path)
        title = str(payload.get("title") or path.stem.replace("-", " ").title())
        episode_id = slugify(f"{payload.get('season', 's')}-{payload.get('episode', path.stem)}-{path.stem}")
        source_file = f"_podcast/{path.name}"
        source_url = f"{SOURCE_URL}/{path.name}"
        questions = questions_by_episode.get(episode_id, [])
        guests = payload.get("guests") or []
        if not isinstance(guests, list):
            guests = [str(guests)]
        categories = sorted(Counter(question.question_category for question in questions))
        episodes.append(
            ActualEpisode(
                episode_id=episode_id,
                source_file=source_file,
                source_url=source_url,
                title=title,
                short=payload.get("short") if isinstance(payload.get("short"), str) else None,
                season=payload.get("season") if isinstance(payload.get("season"), int) else None,
                episode=payload.get("episode") if isinstance(payload.get("episode"), int) else None,
                guest_ids=[str(guest) for guest in guests],
                question_count=len(questions),
                categories=categories,
            )
        )
    return episodes


def write_outputs(repo_dir: Path, files: list[Path], questions: list[ActualQuestion]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (KB_DIR / "clusters").mkdir(parents=True, exist_ok=True)

    questions_by_episode: dict[str, list[ActualQuestion]] = defaultdict(list)
    for question in questions:
        questions_by_episode[question.episode_id].append(question)

    episodes = build_episode_records(files, questions_by_episode)

    with (DATA_DIR / "actual_podcast_questions.csv").open("w", encoding="utf-8", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=list(asdict(questions[0]).keys()) if questions else [])
        if questions:
            writer.writeheader()
            for question in questions:
                writer.writerow(asdict(question))

    with (DATA_DIR / "actual_podcast_questions.jsonl").open("w", encoding="utf-8") as file:
        for question in questions:
            file.write(json.dumps(asdict(question), ensure_ascii=False) + "\n")

    (DATA_DIR / "actual_podcast_episodes.json").write_text(
        json.dumps([asdict(episode) for episode in episodes], indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    analysis = render_analysis(repo_dir, episodes, questions)
    (KB_DIR / "actual_questions_analysis.md").write_text(analysis, encoding="utf-8")


def render_analysis(repo_dir: Path, episodes: list[ActualEpisode], questions: list[ActualQuestion]) -> str:
    category_counts = Counter(question.question_category for question in questions)
    starter_counts = Counter((question.question_text.split() or [""])[0].lower().strip(",.?!") for question in questions)
    header_counts = Counter(question.context_header for question in questions if question.context_header)
    season_counts = Counter(question.season for question in questions if question.season is not None)
    commit = repo_commit(repo_dir)

    lines = [
        "# Actual Podcast Questions Analysis",
        "",
        f"Source: {SOURCE_URL}",
        f"Source commit: `{commit or 'unknown'}`",
        "",
        f"Parsed podcast files: {len(episodes)}",
        f"Extracted actual Alexey questions: {len(questions)}",
        "",
        "## Category Counts",
        "",
    ]
    for category, count in category_counts.most_common():
        lines.append(f"- {category}: {count}")
    lines.extend(["", "## Common Question Starters", ""])
    for starter, count in starter_counts.most_common(20):
        if starter:
            lines.append(f"- {starter}: {count}")
    lines.extend(["", "## Common Transcript Sections", ""])
    for header, count in header_counts.most_common(20):
        lines.append(f"- {header}: {count}")
    lines.extend(["", "## Questions By Season", ""])
    for season, count in sorted(season_counts.items()):
        lines.append(f"- Season {season}: {count}")

    lines.extend(["", "## Representative Actual Questions", ""])
    for category in ("background", "current_focus", "technical_deep_dive", "business_impact", "organizational_reality", "practical_advice", "future_outlook"):
        examples = [question for question in questions if question.question_category == category][:8]
        if not examples:
            continue
        lines.extend([f"### {category}", ""])
        for question in examples:
            lines.append(f"- {question.question_text} ({question.title})")
        lines.append("")

    lines.extend([
        "## Incorporation Notes",
        "",
        "- These are transcript questions actually asked by Alexey, not draft prep questions.",
        "- They are often shorter, more reactive, and more conversational than prep-doc questions.",
        "- They frequently follow up on what the guest just said, so context headers are preserved.",
        "- Use this bank to calibrate phrasing and rhythm; use prep docs for planned arcs and topic coverage.",
    ])
    return "\n".join(lines).rstrip() + "\n"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-dir", type=Path, default=DEFAULT_REPO_DIR, help="Local datatalksclub.github.io checkout.")
    parser.add_argument("--podcast-dir", type=Path, default=None, help="Directory with _podcast markdown files.")
    parser.add_argument("--no-clone", action="store_true", help="Do not clone if the source checkout is missing.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.no_clone:
        ensure_sparse_checkout(args.repo_dir)
    podcast_dir = args.podcast_dir or args.repo_dir / "_podcast"
    files = sorted(path for path in podcast_dir.glob("*.md") if path.name != "_template.md")
    if not files:
        raise SystemExit(f"No podcast markdown files found in {podcast_dir}")
    questions = []
    for path in files:
        questions.extend(extract_questions(path, load_frontmatter(path)))
    write_outputs(args.repo_dir, files, questions)
    print(f"Parsed {len(files)} podcast files")
    print(f"Extracted {len(questions)} actual questions")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
