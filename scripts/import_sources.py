#!/usr/bin/env python3
"""Safely check or apply source-system imports into DataOps.

Examples:

  Check every configured source without writing files:
    python scripts/import_sources.py all --check

  Apply one source with an explicit local override:
    python scripts/import_sources.py datatasks --apply --datatasks-source ../datatasks

  Emit a machine-readable dry-run report for tests or automation:
    python scripts/import_sources.py podcast-assistant --format json
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]

SOURCE_CHOICES = ("all", "dtc-operations", "datatasks", "podcast-assistant")

COMMON_EXCLUSION_LABELS = (
    ".git directories",
    ".github directories where excluded by source policy",
    "virtualenvs such as .venv, venv, and env",
    "node_modules",
    "Python, pytest, mypy, ruff, and generic caches",
    "build outputs such as dist, build, .aws-sam, coverage, and htmlcov",
    ".env and .env.* files except .env.example",
    "local .tmp runtime state",
    "reports, test-results, playwright-report, uploads, archives, and zip/tar exports",
    "local runtime data such as .data, logs, pid, sqlite, and db files",
    "symbolic links",
)

COMMON_EXCLUDED_NAMES = {
    ".git",
    ".github",
    ".venv",
    "venv",
    "env",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".cache",
    ".tmp",
    "tmp",
    ".aws-sam",
    "dist",
    "build",
    "coverage",
    ".coverage",
    "htmlcov",
    "reports",
    "test-results",
    "playwright-report",
    "uploads",
    "upload",
    "archives",
    "archive",
    ".data",
    "logs",
}

COMMON_EXCLUDED_SUFFIXES = (
    ".pyc",
    ".pyo",
    ".log",
    ".pid",
    ".sqlite",
    ".sqlite3",
    ".db",
    ".zip",
    ".tar",
    ".tgz",
    ".gz",
)


@dataclass(frozen=True)
class PathGroup:
    source: str
    destination: str
    kind: str


@dataclass(frozen=True)
class SourceConfig:
    source_id: str
    name: str
    default_source: str
    destination_root: str
    repository_url: str | None
    local_identity: str | None
    requires_git_commit: bool
    path_groups: tuple[PathGroup, ...]
    exclusions: tuple[str, ...]
    protected_destinations: tuple[str, ...] = ()
    extra_excluded_names: tuple[str, ...] = ()
    extra_excluded_paths: tuple[str, ...] = ()
    keep_paths: tuple[str, ...] = ()


SOURCE_CONFIGS: dict[str, SourceConfig] = {
    "dtc-operations": SourceConfig(
        source_id="dtc-operations",
        name="DTC Operations",
        default_source="../dtc-operations",
        destination_root=".",
        repository_url="git@github.com:DataTalksClub/dtc-operations.git",
        local_identity=None,
        requires_git_commit=True,
        path_groups=(
            PathGroup("content", "content", "directory"),
            PathGroup("docs", "docs", "directory"),
            PathGroup("frontend", "frontend", "directory"),
            PathGroup("lambda-functions", "lambda-functions", "directory"),
            PathGroup("scripts", "scripts", "directory"),
            PathGroup("templates", "templates", "directory"),
            PathGroup("tests", "tests", "directory"),
            PathGroup("README.md", "README.md", "file"),
            PathGroup("compose.yaml", "compose.yaml", "file"),
            PathGroup("package.json", "package.json", "file"),
            PathGroup("pyproject.toml", "pyproject.toml", "file"),
            PathGroup("uv.lock", "uv.lock", "file"),
        ),
        exclusions=COMMON_EXCLUSION_LABELS
        + (
            "DataOps import tooling under scripts/import_sources.py",
            "DataOps import-source tests under tests/test_import_sources.py",
        ),
        protected_destinations=("scripts/import_sources.py", "tests/test_import_sources.py"),
    ),
    "datatasks": SourceConfig(
        source_id="datatasks",
        name="DataTasks",
        default_source="../datatasks",
        destination_root="work-engine",
        repository_url="git@github.com:alexeygrigorev/datatasks.git",
        local_identity=None,
        requires_git_commit=True,
        path_groups=(
            PathGroup("docs", "work-engine/docs", "directory"),
            PathGroup("e2e", "work-engine/e2e", "directory"),
            PathGroup("scripts", "work-engine/scripts", "directory"),
            PathGroup("src", "work-engine/src", "directory"),
            PathGroup("tests", "work-engine/tests", "directory"),
            PathGroup("Dockerfile.lambda", "work-engine/Dockerfile.lambda", "file"),
            PathGroup("Makefile", "work-engine/Makefile", "file"),
            PathGroup("README.md", "work-engine/README.md", "file"),
            PathGroup("docker-compose.yml", "work-engine/docker-compose.yml", "file"),
            PathGroup("package.json", "work-engine/package.json", "file"),
            PathGroup("package-lock.json", "work-engine/package-lock.json", "file"),
            PathGroup("playwright.config.js", "work-engine/playwright.config.js", "file"),
            PathGroup("tsconfig.json", "work-engine/tsconfig.json", "file"),
            PathGroup("tsconfig.scripts.json", "work-engine/tsconfig.scripts.json", "file"),
            PathGroup("tsconfig.tests.json", "work-engine/tsconfig.tests.json", "file"),
        ),
        exclusions=COMMON_EXCLUSION_LABELS
        + (
            ".claude local agent configuration",
            "DataTasks local .data state",
        ),
        extra_excluded_names=(".claude",),
    ),
    "podcast-assistant": SourceConfig(
        source_id="podcast-assistant",
        name="Podcast Assistant",
        default_source="../podcast-assistant",
        destination_root="assistants/podcast",
        repository_url=None,
        local_identity="local Podcast Assistant directory supplied alongside the DataOps migration workspace",
        requires_git_commit=False,
        path_groups=(
            PathGroup("data", "assistants/podcast/data", "directory"),
            PathGroup("documents", "assistants/podcast/documents", "directory"),
            PathGroup("inbox", "assistants/podcast/inbox", "directory"),
            PathGroup("knowledge_base", "assistants/podcast/knowledge_base", "directory"),
            PathGroup("podcast_examples", "assistants/podcast/podcast_examples", "directory"),
            PathGroup("process", "assistants/podcast/process", "directory"),
            PathGroup("scripts", "assistants/podcast/scripts", "directory"),
            PathGroup("templates", "assistants/podcast/templates", "directory"),
            PathGroup("tests", "assistants/podcast/tests", "directory"),
            PathGroup("tests_integration", "assistants/podcast/tests_integration", "directory"),
            PathGroup(".env.example", "assistants/podcast/.env.example", "file"),
            PathGroup("README.md", "assistants/podcast/README.md", "file"),
            PathGroup("main.py", "assistants/podcast/main.py", "file"),
            PathGroup("process_request.py", "assistants/podcast/process_request.py", "file"),
            PathGroup("message_queue.py", "assistants/podcast/message_queue.py", "file"),
            PathGroup("progress_tracker.py", "assistants/podcast/progress_tracker.py", "file"),
            PathGroup("session_retrier.py", "assistants/podcast/session_retrier.py", "file"),
            PathGroup("heru_runner.py", "assistants/podcast/heru_runner.py", "file"),
            PathGroup("pyproject.toml", "assistants/podcast/pyproject.toml", "file"),
            PathGroup("uv.lock", "assistants/podcast/uv.lock", "file"),
        ),
        exclusions=COMMON_EXCLUSION_LABELS
        + (
            "Heru run logs under heru_runs/",
            "generated/private assistant inbox files under inbox/raw/ and inbox/used/",
            "generated/private assistant output directories",
            "generated podcast documents under documents/ except .gitkeep placeholders",
        ),
        extra_excluded_names=("heru_runs", "output", "outputs"),
        extra_excluded_paths=("inbox/raw", "inbox/used", "documents"),
        keep_paths=("documents/.gitkeep", "inbox/.gitkeep", "inbox/raw/.gitkeep", "inbox/used/.gitkeep"),
    ),
}


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Check or apply safe imports from DataOps source systems.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "source",
        choices=SOURCE_CHOICES,
        help="Source system to import. Use 'all' to process every source.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Copy planned file changes into the target checkout. Without this flag the tool is dry-run only.",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Run in explicit dry-run/check mode. This is also the default when --apply is omitted.",
    )
    parser.add_argument(
        "--target-root",
        type=Path,
        default=REPO_ROOT,
        help="DataOps checkout root to write or check. Defaults to this repository.",
    )
    parser.add_argument(
        "--dtc-operations-source",
        type=Path,
        default=None,
        help="Override the DTC Operations source path.",
    )
    parser.add_argument(
        "--datatasks-source",
        type=Path,
        default=None,
        help="Override the DataTasks source path.",
    )
    parser.add_argument(
        "--podcast-assistant-source",
        type=Path,
        default=None,
        help="Override the Podcast Assistant source path.",
    )
    parser.add_argument(
        "--format",
        choices=("text", "json"),
        default="text",
        help="Report output format.",
    )
    args = parser.parse_args(argv)
    if args.apply and args.check:
        parser.error("--apply and --check are mutually exclusive")
    return args


def selected_sources(source: str) -> list[str]:
    if source == "all":
        return ["dtc-operations", "datatasks", "podcast-assistant"]
    return [source]


def resolve_source_path(args: argparse.Namespace, config: SourceConfig) -> Path:
    override = getattr(args, f"{config.source_id.replace('-', '_')}_source")
    path = override if override is not None else Path(config.default_source)
    if not path.is_absolute():
        path = args.target_root / path
    return path.resolve()


def is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def normalize_relative(path: Path) -> str:
    return path.as_posix().strip("/")


def matches_excluded_path(relative_path: str, config: SourceConfig) -> bool:
    if relative_path in config.keep_paths:
        return False
    for excluded in config.extra_excluded_paths:
        excluded = excluded.strip("/")
        if relative_path == excluded or relative_path.startswith(f"{excluded}/"):
            return True
    return False


def should_exclude(path: Path, source_root: Path, config: SourceConfig) -> bool:
    if path.is_symlink():
        return True
    relative_path = normalize_relative(path.relative_to(source_root))
    name = path.name
    if relative_path in config.keep_paths:
        return False
    if name in COMMON_EXCLUDED_NAMES or name in config.extra_excluded_names:
        return True
    if name != ".env.example" and (name == ".env" or name.startswith(".env.")):
        return True
    if matches_excluded_path(relative_path, config):
        return True
    if any(name.endswith(suffix) for suffix in COMMON_EXCLUDED_SUFFIXES):
        return True
    if fnmatch.fnmatch(name, "*.tar.*"):
        return True
    return False


def has_kept_descendant(path: Path, source_root: Path, config: SourceConfig) -> bool:
    relative_path = normalize_relative(path.relative_to(source_root))
    return any(keep_path.startswith(f"{relative_path}/") for keep_path in config.keep_paths)


def should_prune_directory(path: Path, source_root: Path, config: SourceConfig) -> bool:
    return should_exclude(path, source_root, config) and not has_kept_descendant(path, source_root, config)


def iter_group_files(source_root: Path, group: PathGroup, config: SourceConfig) -> tuple[list[Path], str | None]:
    group_source = source_root / group.source
    if not group_source.exists():
        return [], group.source
    if group.kind == "file":
        if should_exclude(group_source, source_root, config):
            return [], group.source
        if group_source.is_file():
            return [group_source], None
        return [], group.source
    if group_source.is_symlink():
        return [], group.source

    files: list[Path] = []
    for root, dirnames, filenames in os.walk(group_source, topdown=True):
        root_path = Path(root)
        dirnames[:] = sorted(
            dirname
            for dirname in dirnames
            if not should_prune_directory(root_path / dirname, source_root, config)
        )
        for filename in sorted(filenames):
            path = root_path / filename
            if not should_exclude(path, source_root, config) and path.is_file():
                files.append(path)
    return files, None


def destination_for(source_file: Path, source_root: Path, group: PathGroup, target_root: Path) -> Path:
    group_source = source_root / group.source
    if group.kind == "file":
        return target_root / group.destination
    return target_root / group.destination / source_file.relative_to(group_source)


def file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def plan_change(source_file: Path, destination: Path) -> dict[str, str] | None:
    if not destination.exists():
        action = "copy"
        reason = "missing"
    elif not destination.is_file():
        action = "update"
        reason = "destination is not a regular file"
    elif file_digest(source_file) != file_digest(destination):
        action = "update"
        reason = "content differs"
    else:
        return None
    return {
        "action": action,
        "reason": reason,
        "source": str(source_file),
        "destination": str(destination),
    }


def collect_source_state(source_path: Path, config: SourceConfig) -> dict[str, Any]:
    git_dir = source_path / ".git"
    if git_dir.exists():
        result = subprocess.run(
            ["git", "-C", str(source_path), "rev-parse", "HEAD"],
            check=False,
            text=True,
            capture_output=True,
        )
        if result.returncode == 0:
            return {
                "kind": "git",
                "git_present": True,
                "commit": result.stdout.strip(),
                "command": f"git -C {source_path} rev-parse HEAD",
                "status": "passed",
            }
        return {
            "kind": "git",
            "git_present": True,
            "commit": None,
            "command": f"git -C {source_path} rev-parse HEAD",
            "status": "failed",
            "stderr": result.stderr.strip(),
        }

    state = {
        "kind": "non_git_local",
        "git_present": False,
        "commit": None,
        "identity": config.local_identity or f"non-Git local {config.name} directory",
        "status": "failed" if config.requires_git_commit else "verified",
        "checks": [
            f"test -d {source_path}",
            f"test ! -d {source_path / '.git'}",
        ],
    }
    if config.requires_git_commit:
        state["error"] = f"{config.name} must be Git-backed and provide a commit hash"
    return state


def source_state_errors(source_id: str, source_state: dict[str, Any]) -> list[str]:
    commit = source_state.get("commit")
    if source_state.get("status") != "passed" and source_state.get("kind") == "git":
        return [f"{source_id} Git commit could not be collected"]
    if source_state.get("status") == "failed":
        return [f"{source_id}: {source_state.get('error') or 'source-state validation failed'}"]
    if source_state.get("kind") == "git" and not commit:
        return [f"{source_id} Git commit could not be collected"]
    return []


def build_plan(source_path: Path, target_root: Path, config: SourceConfig) -> dict[str, Any]:
    copied_path_groups: list[str] = []
    missing_path_groups: list[str] = []
    planned_changes: list[dict[str, str]] = []
    protected_skips: list[str] = []
    target_root = target_root.resolve()
    source_state = collect_source_state(source_path, config)
    validation_errors = source_state_errors(config.source_id, source_state)

    for group in config.path_groups:
        source_files, missing_group = iter_group_files(source_path, group, config)
        if missing_group is not None:
            missing_path_groups.append(missing_group)
            continue
        copied_path_groups.append(group.destination)
        for source_file in source_files:
            destination = destination_for(source_file, source_path, group, target_root).resolve()
            relative_destination = normalize_relative(destination.relative_to(target_root))
            if relative_destination in config.protected_destinations:
                protected_skips.append(relative_destination)
                continue
            if not is_relative_to(destination, target_root):
                raise RuntimeError(f"planned destination escapes target root: {destination}")
            change = plan_change(source_file, destination)
            if change is not None:
                change["destination"] = relative_destination
                change["source"] = normalize_relative(source_file.relative_to(source_path))
                planned_changes.append(change)

    return {
        "id": config.source_id,
        "name": config.name,
        "source_path": str(source_path),
        "repository_url": config.repository_url,
        "local_identity": config.local_identity,
        "destination_root": config.destination_root,
        "source_state": source_state,
        "copied_path_groups": sorted(set(copied_path_groups)),
        "missing_path_groups": missing_path_groups,
        "exclusions": list(config.exclusions),
        "protected_skips": sorted(set(protected_skips)),
        "planned_changes": planned_changes,
        "in_sync": len(planned_changes) == 0,
        "validation_errors": validation_errors,
        "validation_status": "failed"
        if validation_errors
        else "in_sync"
        if len(planned_changes) == 0
        else "changes_planned",
    }


def apply_plan(source_path: Path, target_root: Path, plan: dict[str, Any]) -> None:
    target_root = target_root.resolve()
    for change in plan["planned_changes"]:
        source_file = (source_path / change["source"]).resolve()
        destination = (target_root / change["destination"]).resolve()
        if not is_relative_to(source_file, source_path):
            raise RuntimeError(f"planned source escapes source root: {source_file}")
        if not is_relative_to(destination, target_root):
            raise RuntimeError(f"planned destination escapes target root: {destination}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_file, destination)


def build_report(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Path]]:
    target_root = args.target_root.resolve()
    chosen = selected_sources(args.source)
    source_paths = {
        source_id: resolve_source_path(args, SOURCE_CONFIGS[source_id])
        for source_id in chosen
    }
    missing_sources = [
        {"id": source_id, "path": str(path)}
        for source_id, path in source_paths.items()
        if not path.is_dir()
    ]
    mode = "apply" if args.apply else "check"
    if missing_sources:
        return {
            "mode": mode,
            "target_root": str(target_root),
            "ok": False,
            "errors": [
                f"missing source for {missing['id']}: {missing['path']}"
                for missing in missing_sources
            ],
            "sources": [],
            "summary": {
                "source_count": len(chosen),
                "planned_change_count": 0,
                "in_sync": False,
            },
        }, source_paths

    reports = [
        build_plan(source_paths[source_id], target_root, SOURCE_CONFIGS[source_id])
        for source_id in chosen
    ]
    validation_errors = [
        error
        for source_report in reports
        for error in source_report["validation_errors"]
    ]
    report = {
        "mode": mode,
        "target_root": str(target_root),
        "ok": not validation_errors,
        "errors": validation_errors,
        "sources": reports,
        "summary": {
            "source_count": len(reports),
            "planned_change_count": sum(len(item["planned_changes"]) for item in reports),
            "in_sync": not validation_errors and all(item["in_sync"] for item in reports),
        },
    }
    return report, source_paths


def render_text(report: dict[str, Any]) -> str:
    lines = [
        f"Mode: {report['mode']}",
        f"Target root: {report['target_root']}",
    ]
    if not report["ok"]:
        lines.append("Status: failed")
        lines.extend(f"Error: {error}" for error in report["errors"])
        if not report["sources"]:
            return "\n".join(lines)
    else:
        lines.append(f"Status: {'in sync' if report['summary']['in_sync'] else 'changes planned'}")

    lines.append(f"Planned changes: {report['summary']['planned_change_count']}")
    for source in report["sources"]:
        state = source["source_state"]
        if state["kind"] == "git":
            state_text = f"git commit {state.get('commit') or 'unavailable'}"
        else:
            state_text = "non-Git local source; no commit available"
        lines.extend(
            [
                "",
                f"Source: {source['name']} ({source['id']})",
                f"  Path: {source['source_path']}",
                f"  State: {state_text}",
                f"  Validation: {source['validation_status']}",
                f"  Destination root: {source['destination_root']}",
                f"  In sync: {source['in_sync']}",
                "  Copied path groups:",
            ]
        )
        lines.extend(f"    - {group}" for group in source["copied_path_groups"])
        if source["missing_path_groups"]:
            lines.append("  Missing source path groups:")
            lines.extend(f"    - {group}" for group in source["missing_path_groups"])
        lines.append("  Exclusions:")
        lines.extend(f"    - {exclusion}" for exclusion in source["exclusions"])
        if source["protected_skips"]:
            lines.append("  Protected DataOps paths skipped:")
            lines.extend(f"    - {path}" for path in source["protected_skips"])
        lines.append("  Planned changes:")
        if source["planned_changes"]:
            for change in source["planned_changes"]:
                lines.append(f"    - {change['action']} {change['destination']} ({change['reason']})")
        else:
            lines.append("    - none")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    report, source_paths = build_report(args)

    if report["ok"] and args.apply:
        for source_report in report["sources"]:
            apply_plan(source_paths[source_report["id"]], args.target_root.resolve(), source_report)

    if args.format == "json":
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print(render_text(report))

    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
