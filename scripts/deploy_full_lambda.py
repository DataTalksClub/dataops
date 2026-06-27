#!/usr/bin/env python3
"""Build and deploy the full docs Lambda app without requiring SAM or zip."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parents[1]
LAMBDA_DIR = ROOT / "lambda-functions"
DEFAULT_STACK = "dataops-v1"
DEFAULT_REGION = "eu-west-1"
DEFAULT_BRANCH = "main"


def run(cmd: list[str], *, cwd: Path = ROOT, print_output: bool = True) -> str:
    print("+", " ".join(cmd), flush=True)
    proc = subprocess.run(cmd, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if print_output and proc.stdout:
        print(proc.stdout, end="")
    if proc.returncode != 0:
        if not print_output and proc.stdout:
            print(proc.stdout, end="")
        raise SystemExit(proc.returncode)
    return proc.stdout


def aws_json(args: list[str], *, region: str, print_output: bool = True) -> object:
    out = run(["aws", *args, "--region", region, "--output", "json"], print_output=print_output)
    return json.loads(out or "{}")


def stack_output(stack: str, key: str, *, region: str) -> str:
    data = aws_json(["cloudformation", "describe-stacks", "--stack-name", stack], region=region)
    for output in data["Stacks"][0].get("Outputs", []):
        if output.get("OutputKey") == key:
            return output.get("OutputValue", "")
    return ""


def function_name(stack: str, *, region: str) -> str:
    data = aws_json(
        [
            "cloudformation",
            "describe-stack-resources",
            "--stack-name",
            stack,
            "--logical-resource-id",
            "DocsFullAppFunction",
        ],
        region=region,
    )
    resources = data.get("StackResources") or []
    if not resources:
        raise SystemExit(f"Could not find DocsFullAppFunction in stack {stack}")
    return resources[0]["PhysicalResourceId"]


def sam_bucket(*, region: str) -> str:
    return stack_output("aws-sam-cli-managed-default", "SourceBucket", region=region)


def build_artifact(artifact_dir: Path) -> None:
    if artifact_dir.exists():
        shutil.rmtree(artifact_dir)
    artifact_dir.mkdir(parents=True)
    env = os.environ.copy()
    env["ARTIFACTS_DIR"] = str(artifact_dir)
    print("+ make -C lambda-functions build-DocsFullAppFunction", flush=True)
    proc = subprocess.run(
        ["make", "-C", str(LAMBDA_DIR), "build-DocsFullAppFunction"],
        cwd=ROOT,
        env=env,
        text=True,
    )
    if proc.returncode != 0:
        raise SystemExit(proc.returncode)


def zip_dir(source: Path, target: Path) -> None:
    if target.exists():
        target.unlink()
    with ZipFile(target, "w", ZIP_DEFLATED) as zf:
        for path in source.rglob("*"):
            if path.is_file():
                zf.write(path, path.relative_to(source).as_posix())


def update_github_branch(fn: str, branch: str, *, region: str, tmp_path: Path) -> None:
    config = aws_json(
        ["lambda", "get-function-configuration", "--function-name", fn],
        region=region,
        print_output=False,
    )
    env = dict(config.get("Environment", {}).get("Variables", {}))
    if env.get("GITHUB_BRANCH") == branch:
        return

    env["GITHUB_BRANCH"] = branch
    env_file = tmp_path / "lambda-env.json"
    env_file.write_text(json.dumps({"Variables": env}), encoding="utf-8")
    aws_json(
        [
            "lambda",
            "update-function-configuration",
            "--function-name",
            fn,
            "--environment",
            f"file://{env_file}",
        ],
        region=region,
        print_output=False,
    )
    run(["aws", "lambda", "wait", "function-updated", "--function-name", fn, "--region", region])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stack", default=DEFAULT_STACK)
    parser.add_argument("--region", default=DEFAULT_REGION)
    parser.add_argument("--bucket", default="")
    parser.add_argument("--github-branch", default=DEFAULT_BRANCH)
    args = parser.parse_args()

    fn = function_name(args.stack, region=args.region)
    bucket = args.bucket or sam_bucket(region=args.region)
    if not bucket:
        raise SystemExit("No S3 bucket found. Pass --bucket or bootstrap SAM first.")

    with tempfile.TemporaryDirectory(prefix="dtc-full-app-") as tmp:
        tmp_path = Path(tmp)
        artifact_dir = tmp_path / "artifact"
        zip_path = tmp_path / "full-app.zip"
        build_artifact(artifact_dir)
        zip_dir(artifact_dir, zip_path)
        digest = hashlib.sha256(zip_path.read_bytes()).hexdigest()[:16]
        key = f"dataops/full-app/{digest}.zip"
        print(f"Built {zip_path} ({zip_path.stat().st_size} bytes)")
        run(["aws", "s3", "cp", str(zip_path), f"s3://{bucket}/{key}", "--region", args.region])
        aws_json(
            [
                "lambda",
                "update-function-code",
                "--function-name",
                fn,
                "--s3-bucket",
                bucket,
                "--s3-key",
                key,
            ],
            region=args.region,
            print_output=False,
        )
        run(["aws", "lambda", "wait", "function-updated", "--function-name", fn, "--region", args.region])
        update_github_branch(fn, args.github_branch, region=args.region, tmp_path=tmp_path)

    url = stack_output(args.stack, "DocsFullAppUrl", region=args.region)
    print(f"Deployed {fn}")
    if url:
        print(url)


if __name__ == "__main__":
    main()
