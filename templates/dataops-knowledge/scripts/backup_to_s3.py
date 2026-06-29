#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


def main() -> int:
    parser = argparse.ArgumentParser(description="Back up the private DataOps knowledge repository to S3.")
    parser.add_argument("--bucket", default=os.environ.get("DATAOPS_KNOWLEDGE_BACKUP_BUCKET", ""))
    parser.add_argument("--prefix", default=os.environ.get("DATAOPS_KNOWLEDGE_BACKUP_PREFIX", "dataops-knowledge"))
    parser.add_argument("--repo-root", default=Path.cwd(), type=Path)
    parser.add_argument("--force", action="store_true", help="Upload even when the latest S3 manifest has this commit.")
    parser.add_argument("--dry-run", action="store_true", help="Build local artifacts but do not call aws s3 cp.")
    args = parser.parse_args()

    if not args.bucket and not args.dry_run:
        raise SystemExit("--bucket or DATAOPS_KNOWLEDGE_BACKUP_BUCKET is required")

    repo_root = args.repo_root.resolve()
    prefix = args.prefix.strip("/")
    commit_sha = git(repo_root, "rev-parse", "HEAD")
    branch = current_branch(repo_root)
    latest_manifest = read_latest_manifest(args.bucket, prefix, dry_run=args.dry_run)
    latest_commit = str(latest_manifest.get("commit_sha", "")).strip() if latest_manifest else ""

    if latest_commit == commit_sha and not args.force:
        print(f"Latest S3 backup already contains commit {commit_sha}; skipping upload.")
        return 0

    generated_at = dt.datetime.now(dt.UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    date_path = generated_at[:10].replace("-", "/")
    short_sha = commit_sha[:12]
    backup_root = f"{prefix}/daily/{date_path}/{short_sha}" if prefix else f"daily/{date_path}/{short_sha}"

    with tempfile.TemporaryDirectory(prefix="dataops-knowledge-backup-") as tmp_dir_raw:
        tmp_dir = Path(tmp_dir_raw)
        zip_path = tmp_dir / f"dataops-knowledge-{short_sha}.zip"
        bundle_path = tmp_dir / f"dataops-knowledge-{short_sha}.bundle"
        manifest_path = tmp_dir / "manifest.json"
        checksums_path = tmp_dir / "checksums.sha256"

        git(repo_root, "archive", "--format=zip", f"--output={zip_path}", "HEAD")
        git(repo_root, "bundle", "create", str(bundle_path), "--all")

        checksums = {
            zip_path.name: sha256_file(zip_path),
            bundle_path.name: sha256_file(bundle_path),
        }
        checksums_path.write_text(format_checksums(checksums), encoding="utf-8")
        checksums_checksum = sha256_file(checksums_path)

        manifest = {
            "schema_version": 1,
            "repository": os.environ.get("GITHUB_REPOSITORY", "DataTalksClub/dataops-knowledge"),
            "commit_sha": commit_sha,
            "branch": branch,
            "generated_at": generated_at,
            "backup_type": "git-archive-plus-bundle",
            "s3_bucket": args.bucket,
            "s3_prefix": prefix,
            "objects": [
                object_record(zip_path, f"{backup_root}/{zip_path.name}", checksums[zip_path.name]),
                object_record(bundle_path, f"{backup_root}/{bundle_path.name}", checksums[bundle_path.name]),
                object_record(checksums_path, f"{backup_root}/checksums.sha256", checksums_checksum),
            ],
        }
        manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")

        if args.dry_run:
            print(json.dumps(manifest, indent=2, sort_keys=True))
            return 0

        upload(args.bucket, f"{backup_root}/{zip_path.name}", zip_path)
        upload(args.bucket, f"{backup_root}/{bundle_path.name}", bundle_path)
        upload(args.bucket, f"{backup_root}/checksums.sha256", checksums_path)
        upload(args.bucket, f"{backup_root}/manifest.json", manifest_path)
        upload(args.bucket, latest_key(prefix, "manifest.json"), manifest_path)
        upload(args.bucket, latest_key(prefix, "checksums.sha256"), checksums_path)

    print(f"Uploaded S3 backup for commit {commit_sha} to s3://{args.bucket}/{backup_root}/")
    return 0


def git(repo_root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=repo_root,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return result.stdout.strip()


def current_branch(repo_root: Path) -> str:
    branch = git(repo_root, "rev-parse", "--abbrev-ref", "HEAD")
    if branch != "HEAD":
        return branch
    return os.environ.get("GITHUB_REF_NAME", "detached")


def read_latest_manifest(bucket: str, prefix: str, *, dry_run: bool) -> dict[str, Any]:
    if dry_run or not bucket:
        return {}

    if shutil.which("aws") is None:
        raise SystemExit("aws CLI is required for S3 backup uploads")

    with tempfile.TemporaryDirectory(prefix="dataops-knowledge-latest-") as tmp_dir_raw:
        manifest_path = Path(tmp_dir_raw) / "manifest.json"
        result = subprocess.run(
            ["aws", "s3", "cp", f"s3://{bucket}/{latest_key(prefix, 'manifest.json')}", str(manifest_path)],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if result.returncode != 0:
            missing_markers = ("404", "not found", "nosuchkey", "does not exist")
            error_text = f"{result.stdout}\n{result.stderr}".lower()
            if not any(marker in error_text for marker in missing_markers):
                raise SystemExit(f"Failed to read latest S3 manifest:\n{result.stderr}")
            print("No latest S3 manifest found; creating first backup.")
            return {}
        return json.loads(manifest_path.read_text(encoding="utf-8"))


def upload(bucket: str, key: str, path: Path) -> None:
    if shutil.which("aws") is None:
        raise SystemExit("aws CLI is required for S3 backup uploads")
    subprocess.run(
        [
            "aws",
            "s3",
            "cp",
            str(path),
            f"s3://{bucket}/{key}",
            "--only-show-errors",
            "--sse",
            "AES256",
        ],
        check=True,
    )


def latest_key(prefix: str, filename: str) -> str:
    return f"{prefix}/latest/{filename}" if prefix else f"latest/{filename}"


def object_record(path: Path, key: str, checksum: str) -> dict[str, Any]:
    return {
        "name": path.name,
        "s3_key": key,
        "size_bytes": path.stat().st_size,
        "sha256": checksum,
    }


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file_handle:
        for chunk in iter(lambda: file_handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def format_checksums(checksums: dict[str, str]) -> str:
    return "".join(f"{checksum}  {name}\n" for name, checksum in sorted(checksums.items()))


if __name__ == "__main__":
    sys.exit(main())
