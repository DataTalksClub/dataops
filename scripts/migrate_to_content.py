#!/usr/bin/env python3
"""One-shot migration: docs/operations + docs/maven + docs/prompts → content/,
assets/images → content/images. Rewrites image links and cross-doc .md refs.

Run from repo root:
    python3 scripts/migrate_to_content.py --apply

Default (no --apply) is a dry run.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path


REPO = Path(__file__).resolve().parent.parent

# (source-relative-to-repo, dest-relative-to-repo)
# Order matters: more-specific moves come first so they take precedence
# over the broader docs/operations rule below.
DOC_MOVES: list[tuple[str, str]] = [
    ("docs/operations/content", "content/media"),
    ("docs/operations", "content"),
    ("docs/maven", "content/maven"),
    ("docs/prompts", "content/prompts"),
]
IMAGE_MOVE = ("assets/images", "content/images")

# md file → new md file (built lazily)
MD_PATH_RE = re.compile(r"\]\(([^)]+\.md)(#[^)]*)?\)")
IMG_PATH_RE = re.compile(r"\]\(([^)]+\.(?:png|jpg|jpeg|gif|webp|svg))\)", re.IGNORECASE)


def git_mv(src: Path, dst: Path, apply: bool) -> None:
    rel_src = src.relative_to(REPO)
    rel_dst = dst.relative_to(REPO)
    if not apply:
        print(f"mv  {rel_src} -> {rel_dst}")
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "mv", str(rel_src), str(rel_dst)], cwd=REPO, check=True)


def plan_moves() -> dict[Path, Path]:
    """Return absolute src->dst map for every file affected.

    Order-sensitive: earlier (more-specific) entries win, so an explicit
    rule like docs/operations/content -> content/media takes precedence
    over docs/operations -> content for files inside that subtree.
    """
    plan: dict[Path, Path] = {}
    for src_rel, dst_rel in DOC_MOVES:
        src = REPO / src_rel
        if not src.exists():
            continue
        for f in src.rglob("*"):
            if f.is_dir():
                continue
            if f in plan:  # already claimed by a more-specific rule
                continue
            rel = f.relative_to(src)
            plan[f] = REPO / dst_rel / rel
    img_src = REPO / IMAGE_MOVE[0]
    if img_src.exists():
        for f in img_src.rglob("*"):
            if f.is_dir():
                continue
            rel = f.relative_to(img_src)
            plan[f] = REPO / IMAGE_MOVE[1] / rel
    return plan


def rewrite_link(link_target: str, src_abs: Path, plan: dict[Path, Path]) -> str:
    """Rewrite a markdown link target so that, after the move, the source file
    (now at plan[src_abs]) still resolves to the correct target file (now at
    plan[target_abs] if the target was also moved, else unchanged)."""
    if link_target.startswith(("http://", "https://", "#", "mailto:")):
        return link_target
    # Strip fragment
    frag = ""
    target = link_target
    if "#" in target:
        target, _, frag_part = target.partition("#")
        frag = "#" + frag_part
    try:
        target_abs = (src_abs.parent / target).resolve()
    except Exception:
        return link_target
    target_after = plan.get(target_abs, target_abs)
    src_after = plan.get(src_abs, src_abs)
    try:
        new_rel = target_after.relative_to(REPO).as_posix()
        src_dir = src_after.parent.relative_to(REPO).as_posix()
    except ValueError:
        return link_target
    # Compute relative path from src_after.parent to target_after
    new_link = _rel_path(src_after.parent, target_after)
    return new_link + frag


def _rel_path(from_dir: Path, to_file: Path) -> str:
    from_parts = from_dir.parts
    to_parts = to_file.parts
    # Find common prefix
    i = 0
    while i < len(from_parts) and i < len(to_parts) and from_parts[i] == to_parts[i]:
        i += 1
    up = [".."] * (len(from_parts) - i)
    down = list(to_parts[i:])
    parts = up + down
    return "/".join(parts) if parts else "."


def rewrite_file(path_abs: Path, plan: dict[Path, Path]) -> str | None:
    """Return rewritten text if it changed, else None."""
    text = path_abs.read_text(encoding="utf-8", errors="replace")
    original = text

    def md_sub(m: re.Match) -> str:
        new_target = rewrite_link(m.group(1) + (m.group(2) or ""), path_abs, plan)
        return f"]({new_target})"

    def img_sub(m: re.Match) -> str:
        new_target = rewrite_link(m.group(1), path_abs, plan)
        return f"]({new_target})"

    text = MD_PATH_RE.sub(md_sub, text)
    text = IMG_PATH_RE.sub(img_sub, text)
    return text if text != original else None


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="Perform changes (default is dry-run).")
    args = ap.parse_args(argv)

    plan = plan_moves()
    print(f"files to move: {len(plan)}")

    # Rewrite link targets in every markdown file (sources that move OR
    # static docs that may link to moved files).
    candidates: set[Path] = set()
    for src in plan:
        if src.suffix == ".md":
            candidates.add(src)
    for f in REPO.rglob("*.md"):
        if any(part in {".venv", "node_modules", ".git"} for part in f.parts):
            continue
        candidates.add(f)

    rewritten = 0
    for f in sorted(candidates):
        new = rewrite_file(f, plan)
        if new is None:
            continue
        rewritten += 1
        if args.apply:
            f.write_text(new, encoding="utf-8")
    print(f"files with rewritten links: {rewritten}")

    # Now move files. Sort: docs first (they're md, faster), then images.
    # Use git mv to preserve history.
    moves = sorted(plan.items())
    for src, dst in moves:
        if not args.apply:
            print(f"mv  {src.relative_to(REPO)} -> {dst.relative_to(REPO)}")
        else:
            dst.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(["git", "mv", str(src.relative_to(REPO)), str(dst.relative_to(REPO))], cwd=REPO, check=True)

    # Clean up now-empty source directories
    if args.apply:
        for src_rel, _ in DOC_MOVES + [IMAGE_MOVE]:
            src = REPO / src_rel
            if src.exists():
                _prune_empty(src)
        # also assets/ at top level if it's now empty
        assets = REPO / "assets"
        if assets.exists():
            _prune_empty(assets)

    return 0


def _prune_empty(d: Path) -> None:
    if not d.exists():
        return
    for child in sorted(d.iterdir(), reverse=True):
        if child.is_dir():
            _prune_empty(child)
    if d.is_dir() and not any(d.iterdir()):
        d.rmdir()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
