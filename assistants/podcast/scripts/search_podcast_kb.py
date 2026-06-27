#!/usr/bin/env python
"""Search the generated podcast knowledge base."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"


def load_episodes(path: Path) -> list[dict]:
    if not path.exists():
        raise SystemExit(f"Missing {path}. Run scripts/build_podcast_knowledge_base.py first.")
    return json.loads(path.read_text(encoding="utf-8"))


def load_questions(path: Path) -> list[dict]:
    if not path.exists():
        raise SystemExit(f"Missing {path}. Run scripts/build_podcast_knowledge_base.py first.")
    with path.open("r", encoding="utf-8", newline="") as file:
        return list(csv.DictReader(file))


def score_text(query_terms: list[str], text: str) -> int:
    text_lower = text.lower()
    return sum(text_lower.count(term) for term in query_terms)


def search_episodes(query: str, limit: int) -> list[tuple[int, dict]]:
    query_terms = [term.lower() for term in query.split() if term.strip()]
    results = []
    for episode in load_episodes(DATA_DIR / "podcast_episodes.json"):
        haystack = "\n".join(
            [
                episode.get("guest_name") or "",
                episode.get("topic") or "",
                episode.get("bio") or "",
                " ".join(episode.get("themes") or []),
                episode.get("raw_text") or "",
            ]
        )
        score = score_text(query_terms, haystack)
        if score:
            results.append((score, episode))
    return sorted(results, key=lambda item: (-item[0], item[1]["guest_name"]))[:limit]


def search_questions(query: str, limit: int) -> list[tuple[int, dict]]:
    query_terms = [term.lower() for term in query.split() if term.strip()]
    results = []
    for question in load_questions(DATA_DIR / "podcast_questions.csv"):
        haystack = "\n".join(
            [
                question.get("guest_name") or "",
                question.get("topic") or "",
                question.get("question_category") or "",
                question.get("question_text") or "",
            ]
        )
        score = score_text(query_terms, haystack)
        if score:
            results.append((score, question))
    return sorted(results, key=lambda item: (-item[0], item[1]["guest_name"]))[:limit]


def search_actual_questions(query: str, limit: int) -> list[tuple[int, dict]]:
    path = DATA_DIR / "actual_podcast_questions.csv"
    if not path.exists():
        return []
    query_terms = [term.lower() for term in query.split() if term.strip()]
    results = []
    for question in load_questions(path):
        haystack = "\n".join(
            [
                question.get("title") or "",
                question.get("context_header") or "",
                question.get("question_category") or "",
                question.get("question_text") or "",
            ]
        )
        score = score_text(query_terms, haystack)
        if score:
            results.append((score, question))
    return sorted(results, key=lambda item: (-item[0], item[1]["title"], item[1]["question_order"]))[:limit]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("query", help="Search terms, for example 'ai agents evals' or 'career transition'.")
    parser.add_argument("--limit", type=int, default=10, help="Maximum results per section.")
    parser.add_argument("--questions-only", action="store_true", help="Only show matching questions.")
    parser.add_argument("--episodes-only", action="store_true", help="Only show matching episodes.")
    parser.add_argument("--actual-only", action="store_true", help="Only show actual transcript questions.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.limit <= 0:
        raise SystemExit("--limit must be positive")

    if not args.questions_only and not args.actual_only:
        print("# Episodes")
        for score, episode in search_episodes(args.query, args.limit):
            print(f"- [{score}] {episode['guest_name']} - {episode['topic']} ({episode['id']})")
        print()

    if not args.episodes_only and not args.actual_only:
        print("# Prep Questions")
        for score, question in search_questions(args.query, args.limit):
            print(
                f"- [{score}] {question['guest_name']} / {question['question_category']}: "
                f"{question['question_text']}"
            )
        print()

    if not args.episodes_only and not args.questions_only:
        print("# Actual Transcript Questions")
        for score, question in search_actual_questions(args.query, args.limit):
            print(
                f"- [{score}] {question['title']} / {question['question_category']}: "
                f"{question['question_text']}"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
