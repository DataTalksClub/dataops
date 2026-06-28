from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
IMPORT_SCRIPT = REPO_ROOT / "scripts" / "import_sources.py"


def write_file(path: Path, text: str = "content\n") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def run_import(
    tmp_path: Path,
    *args: str,
    target_root: Path | None = None,
    dtc_source: Path | None = None,
    datatasks_source: Path | None = None,
    podcast_source: Path | None = None,
) -> subprocess.CompletedProcess[str]:
    command = [sys.executable, str(IMPORT_SCRIPT), *args]
    if target_root is not None:
        command.extend(["--target-root", str(target_root)])
    if dtc_source is not None:
        command.extend(["--dtc-operations-source", str(dtc_source)])
    if datatasks_source is not None:
        command.extend(["--datatasks-source", str(datatasks_source)])
    if podcast_source is not None:
        command.extend(["--podcast-assistant-source", str(podcast_source)])
    return subprocess.run(
        command,
        cwd=REPO_ROOT,
        check=False,
        text=True,
        capture_output=True,
        env={**os.environ, "PYTHONPATH": str(REPO_ROOT)},
    )


def init_git_repo(path: Path) -> str:
    subprocess.run(["git", "init"], cwd=path, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "tests@example.com"], cwd=path, check=True)
    subprocess.run(["git", "config", "user.name", "Tests"], cwd=path, check=True)
    subprocess.run(["git", "add", "."], cwd=path, check=True)
    subprocess.run(["git", "commit", "-m", "fixture"], cwd=path, check=True, capture_output=True, text=True)
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=path,
        check=True,
        text=True,
        capture_output=True,
    )
    return commit.stdout.strip()


def create_dtc_source(path: Path) -> str:
    write_file(path / "content" / "sops" / "example.md", "dtc content\n")
    write_file(path / "content" / "node_modules" / "package" / "index.js", "excluded\n")
    write_file(path / "content" / ".pytest_cache" / "v" / "cache.txt", "excluded\n")
    write_file(path / "content" / ".github" / "workflows" / "ci.yml", "excluded\n")
    write_file(path / "docs" / "architecture.md", "architecture\n")
    write_file(path / "docs" / "logs" / "run.log", "excluded\n")
    write_file(path / "frontend" / "app.js", "console.log('dtc')\n")
    write_file(path / "frontend" / "dist" / "bundle.js", "excluded\n")
    write_file(path / "lambda-functions" / "src" / "handler.py", "def handler(): pass\n")
    write_file(path / "lambda-functions" / ".aws-sam" / "template.yaml", "excluded\n")
    write_file(path / "scripts" / "source_tool.py", "print('source')\n")
    write_file(path / "scripts" / "import_sources.py", "print('must not overwrite')\n")
    write_file(path / "scripts" / ".env.local", "SECRET=1\n")
    write_file(path / "templates" / "template.md", "template\n")
    write_file(path / "tests" / "test_source.py", "def test_source(): pass\n")
    write_file(path / "tests" / "__pycache__" / "test_source.pyc", "excluded\n")
    write_file(path / "README.md", "# DTC Operations\n")
    write_file(path / "package.json", "{}\n")
    write_file(path / ".github" / "workflows" / "ci.yml", "excluded\n")
    write_file(path / "node_modules" / "package" / "index.js", "excluded\n")
    write_file(path / ".env", "SECRET=1\n")
    write_file(path / ".pytest_cache" / "README.md", "excluded\n")
    write_file(path / "reports" / "report.txt", "excluded\n")
    write_file(path / "archive.zip", "excluded\n")
    return init_git_repo(path)


def create_datatasks_source(path: Path) -> str:
    write_file(path / "src" / "index.ts", "export const value = 1;\n")
    write_file(path / "src" / "node_modules" / "pkg" / "index.js", "excluded\n")
    write_file(path / "src" / ".pytest_cache" / "v" / "cache.txt", "excluded\n")
    write_file(path / "src" / "build" / "bundle.js", "excluded\n")
    write_file(path / "src" / ".env.local", "SECRET=1\n")
    write_file(path / "tests" / "index.test.ts", "test('value', () => {});\n")
    write_file(path / "tests" / "coverage" / "index.html", "excluded\n")
    write_file(path / "docs" / "engine.md", "engine\n")
    write_file(path / "docs" / "archives" / "old.zip", "excluded\n")
    write_file(path / "package.json", '{"name":"datatasks"}\n')
    write_file(path / "package-lock.json", "{}\n")
    write_file(path / "tsconfig.json", "{}\n")
    write_file(path / ".claude" / "settings.json", "excluded\n")
    write_file(path / "node_modules" / "typescript" / "index.js", "excluded\n")
    write_file(path / "dist" / "index.js", "excluded\n")
    write_file(path / ".data" / "runtime.json", "excluded\n")
    write_file(path / "uploads" / "file.bin", "excluded\n")
    return init_git_repo(path)


def create_podcast_source(path: Path) -> None:
    write_file(path / "main.py", "print('podcast')\n")
    write_file(path / "README.md", "# Podcast Assistant\n")
    write_file(path / ".env.example", "TOKEN=\n")
    write_file(path / ".env", "TOKEN=secret\n")
    write_file(path / "data" / "episodes.yaml", "episodes: []\n")
    write_file(path / "data" / ".pytest_cache" / "v" / "cache.txt", "excluded\n")
    write_file(path / "knowledge_base" / "faq.md", "faq\n")
    write_file(path / "knowledge_base" / "node_modules" / "pkg" / "index.js", "excluded\n")
    write_file(path / "documents" / ".gitkeep", "")
    write_file(path / "documents" / "generated.md", "excluded\n")
    write_file(path / "inbox" / ".gitkeep", "")
    write_file(path / "inbox" / "raw" / ".gitkeep", "")
    write_file(path / "inbox" / "raw" / "private.txt", "excluded\n")
    write_file(path / "inbox" / "used" / "private.txt", "excluded\n")
    write_file(path / "heru_runs" / "run.log", "excluded\n")
    write_file(path / "outputs" / "answer.md", "excluded\n")
    write_file(path / ".tmp" / "runtime.json", "excluded\n")


def source_snapshot(path: Path) -> dict[str, str]:
    snapshot: dict[str, str] = {}
    for item in sorted(path.rglob("*")):
        if ".git" in item.relative_to(path).parts:
            continue
        if item.is_file():
            snapshot[item.relative_to(path).as_posix()] = item.read_text(encoding="utf-8")
    return snapshot


def parse_report(result: subprocess.CompletedProcess[str]) -> dict:
    assert result.returncode == 0, result.stderr + result.stdout
    return json.loads(result.stdout)


def planned_destinations(source_report: dict) -> set[str]:
    return {change["destination"] for change in source_report["planned_changes"]}


def test_dry_run_reports_planned_import_without_writing(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.mkdir()
    dtc = tmp_path / "dtc-operations"
    datatasks = tmp_path / "datatasks"
    podcast = tmp_path / "podcast-assistant"
    dtc_commit = create_dtc_source(dtc)
    datatasks_commit = create_datatasks_source(datatasks)
    create_podcast_source(podcast)

    result = run_import(
        tmp_path,
        "all",
        "--format",
        "json",
        target_root=target,
        dtc_source=dtc,
        datatasks_source=datatasks,
        podcast_source=podcast,
    )

    report = parse_report(result)
    assert report["mode"] == "check"
    assert report["summary"]["planned_change_count"] > 0
    assert report["summary"]["in_sync"] is False
    assert not (target / "content").exists()
    sources = {source["id"]: source for source in report["sources"]}
    assert sources["dtc-operations"]["source_state"]["commit"] == dtc_commit
    assert sources["datatasks"]["source_state"]["commit"] == datatasks_commit
    assert sources["podcast-assistant"]["source_state"]["kind"] == "non_git_local"
    assert "content" in sources["dtc-operations"]["copied_path_groups"]
    assert "work-engine/src" in sources["datatasks"]["copied_path_groups"]
    assert "assistants/podcast/inbox" in sources["podcast-assistant"]["copied_path_groups"]
    assert any(".env" in item for item in sources["podcast-assistant"]["exclusions"])
    assert "content/node_modules/package/index.js" not in planned_destinations(sources["dtc-operations"])
    assert "content/.pytest_cache/v/cache.txt" not in planned_destinations(sources["dtc-operations"])
    assert "content/.github/workflows/ci.yml" not in planned_destinations(sources["dtc-operations"])
    assert "work-engine/src/node_modules/pkg/index.js" not in planned_destinations(sources["datatasks"])
    assert "work-engine/src/.pytest_cache/v/cache.txt" not in planned_destinations(sources["datatasks"])
    assert "work-engine/src/build/bundle.js" not in planned_destinations(sources["datatasks"])
    assert "assistants/podcast/data/.pytest_cache/v/cache.txt" not in planned_destinations(
        sources["podcast-assistant"]
    )
    assert "assistants/podcast/knowledge_base/node_modules/pkg/index.js" not in planned_destinations(
        sources["podcast-assistant"]
    )


def test_apply_copies_only_allowed_files_and_preserves_sources(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.mkdir()
    dtc = tmp_path / "dtc-operations"
    datatasks = tmp_path / "datatasks"
    podcast = tmp_path / "podcast-assistant"
    create_dtc_source(dtc)
    create_datatasks_source(datatasks)
    create_podcast_source(podcast)
    before = {
        "dtc": source_snapshot(dtc),
        "datatasks": source_snapshot(datatasks),
        "podcast": source_snapshot(podcast),
    }

    result = run_import(
        tmp_path,
        "all",
        "--apply",
        "--format",
        "json",
        target_root=target,
        dtc_source=dtc,
        datatasks_source=datatasks,
        podcast_source=podcast,
    )

    report = parse_report(result)
    assert report["mode"] == "apply"
    assert (target / "content" / "sops" / "example.md").read_text(encoding="utf-8") == "dtc content\n"
    assert (target / "scripts" / "source_tool.py").exists()
    assert not (target / "scripts" / "import_sources.py").exists()
    assert not (target / ".github").exists()
    assert not (target / "node_modules").exists()
    assert not (target / "content" / "node_modules").exists()
    assert not (target / "content" / ".pytest_cache").exists()
    assert not (target / "content" / ".github").exists()
    assert not (target / "frontend" / "dist").exists()
    assert not (target / "lambda-functions" / ".aws-sam").exists()
    assert not (target / "scripts" / ".env.local").exists()
    assert not (target / "tests" / "__pycache__").exists()
    assert not (target / ".env").exists()
    assert not (target / "reports").exists()
    assert not (target / "archive.zip").exists()

    assert (target / "work-engine" / "src" / "index.ts").exists()
    assert (target / "work-engine" / "package.json").exists()
    assert not (target / "work-engine" / ".claude").exists()
    assert not (target / "work-engine" / "node_modules").exists()
    assert not (target / "work-engine" / "src" / "node_modules").exists()
    assert not (target / "work-engine" / "src" / ".pytest_cache").exists()
    assert not (target / "work-engine" / "src" / "build").exists()
    assert not (target / "work-engine" / "src" / ".env.local").exists()
    assert not (target / "work-engine" / "tests" / "coverage").exists()
    assert not (target / "work-engine" / "docs" / "archives").exists()
    assert not (target / "work-engine" / "dist").exists()
    assert not (target / "work-engine" / ".data").exists()
    assert not (target / "work-engine" / "uploads").exists()

    assert (target / "assistants" / "podcast" / "main.py").exists()
    assert (target / "assistants" / "podcast" / ".env.example").exists()
    assert (target / "assistants" / "podcast" / "documents" / ".gitkeep").exists()
    assert (target / "assistants" / "podcast" / "inbox" / "raw" / ".gitkeep").exists()
    assert not (target / "assistants" / "podcast" / ".env").exists()
    assert not (target / "assistants" / "podcast" / "data" / ".pytest_cache").exists()
    assert not (target / "assistants" / "podcast" / "knowledge_base" / "node_modules").exists()
    assert not (target / "assistants" / "podcast" / "documents" / "generated.md").exists()
    assert not (target / "assistants" / "podcast" / "inbox" / "raw" / "private.txt").exists()
    assert not (target / "assistants" / "podcast" / "heru_runs").exists()
    assert not (target / "assistants" / "podcast" / "outputs").exists()

    assert before == {
        "dtc": source_snapshot(dtc),
        "datatasks": source_snapshot(datatasks),
        "podcast": source_snapshot(podcast),
    }


def test_apply_updates_changed_target_and_second_check_is_in_sync(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.mkdir()
    datatasks = tmp_path / "datatasks"
    create_datatasks_source(datatasks)
    write_file(target / "work-engine" / "src" / "index.ts", "old\n")

    apply_result = run_import(
        tmp_path,
        "datatasks",
        "--apply",
        "--format",
        "json",
        target_root=target,
        datatasks_source=datatasks,
    )
    apply_report = parse_report(apply_result)

    assert any(change["action"] == "update" for change in apply_report["sources"][0]["planned_changes"])
    assert (target / "work-engine" / "src" / "index.ts").read_text(encoding="utf-8") == "export const value = 1;\n"

    check_result = run_import(
        tmp_path,
        "datatasks",
        "--format",
        "json",
        target_root=target,
        datatasks_source=datatasks,
    )
    check_report = parse_report(check_result)
    assert check_report["summary"]["in_sync"] is True
    assert check_report["summary"]["planned_change_count"] == 0


def test_missing_source_fails_without_partial_writes(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.mkdir()
    podcast = tmp_path / "podcast-assistant"
    create_podcast_source(podcast)

    result = run_import(
        tmp_path,
        "all",
        "--apply",
        "--format",
        "json",
        target_root=target,
        dtc_source=tmp_path / "missing-dtc",
        datatasks_source=tmp_path / "missing-datatasks",
        podcast_source=podcast,
    )

    assert result.returncode == 2
    report = json.loads(result.stdout)
    assert report["ok"] is False
    assert any("missing source for dtc-operations" in error for error in report["errors"])
    assert any("missing source for datatasks" in error for error in report["errors"])
    assert not any(target.iterdir())


def test_non_git_dtc_and_datatasks_fail_validation_but_podcast_non_git_is_allowed(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.mkdir()
    dtc = tmp_path / "dtc-operations"
    datatasks = tmp_path / "datatasks"
    podcast = tmp_path / "podcast-assistant"
    write_file(dtc / "content" / "sops" / "example.md", "dtc content\n")
    write_file(datatasks / "src" / "index.ts", "export const value = 1;\n")
    create_podcast_source(podcast)

    result = run_import(
        tmp_path,
        "all",
        "--apply",
        "--format",
        "json",
        target_root=target,
        dtc_source=dtc,
        datatasks_source=datatasks,
        podcast_source=podcast,
    )

    assert result.returncode == 2
    report = json.loads(result.stdout)
    sources = {source["id"]: source for source in report["sources"]}
    assert report["ok"] is False
    assert report["summary"]["in_sync"] is False
    assert any("dtc-operations" in error and "Git-backed" in error for error in report["errors"])
    assert any("datatasks" in error and "Git-backed" in error for error in report["errors"])
    assert sources["dtc-operations"]["validation_status"] == "failed"
    assert sources["dtc-operations"]["source_state"]["kind"] == "non_git_local"
    assert sources["dtc-operations"]["source_state"]["commit"] is None
    assert sources["datatasks"]["validation_status"] == "failed"
    assert sources["datatasks"]["source_state"]["kind"] == "non_git_local"
    assert sources["datatasks"]["source_state"]["commit"] is None
    assert sources["podcast-assistant"]["validation_status"] == "changes_planned"
    assert sources["podcast-assistant"]["source_state"]["kind"] == "non_git_local"
    assert sources["podcast-assistant"]["source_state"]["commit"] is None
    assert not any(target.iterdir())


def test_help_documents_safe_modes_and_examples() -> None:
    result = subprocess.run(
        [sys.executable, str(IMPORT_SCRIPT), "--help"],
        cwd=REPO_ROOT,
        check=False,
        text=True,
        capture_output=True,
    )

    assert result.returncode == 0
    assert "--apply" in result.stdout
    assert "--check" in result.stdout
    assert "Examples:" in result.stdout
    assert "dtc-operations" in result.stdout
    assert "datatasks" in result.stdout
    assert "podcast-assistant" in result.stdout
