import base64
import json
import os
import shutil
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


CONTENT_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}


class GitHubError(RuntimeError):
    pass


class GitHubStore:
    def __init__(self, root: Path):
        self.root = root
        self.content_root = root / "content"
        self.owner = os.environ.get("GITHUB_OWNER", "DataTalksClub")
        self.repo = os.environ.get("GITHUB_REPO", "dataops")
        self.branch = os.environ.get("GITHUB_BRANCH", "main")
        self.token = github_token()
        self._tree: dict[str, dict[str, Any]] | None = None
        self._synced = False

    @property
    def github_url(self) -> str:
        return f"https://github.com/{self.owner}/{self.repo}"

    def reset(self) -> None:
        self._tree = None
        self._synced = False
        if self.root.exists():
            shutil.rmtree(self.root)

    def sync_markdown(self) -> None:
        if self._synced:
            return
        self.root.mkdir(parents=True, exist_ok=True)
        self.content_root.mkdir(parents=True, exist_ok=True)
        self.download_markdown_tarball()
        self._synced = True

    def download_markdown_tarball(self) -> None:
        url = f"https://api.github.com/repos/{self.owner}/{self.repo}/tarball/{quote_path(self.branch)}"
        headers = {
            "accept": "application/vnd.github+json",
            "authorization": f"Bearer {self.token}",
            "user-agent": "dataops-lambda",
            "x-github-api-version": "2022-11-28",
        }
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                with tempfile.NamedTemporaryFile(dir="/tmp", suffix=".tar.gz", delete=False) as tmp:
                    shutil.copyfileobj(resp, tmp)
                    tmp_path = Path(tmp.name)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            raise GitHubError(f"GitHub tarball download failed: HTTP {exc.code}: {detail}") from exc

        try:
            with tarfile.open(tmp_path, "r:gz") as archive:
                for member in archive:
                    if not member.isfile():
                        continue
                    parts = member.name.split("/", 1)
                    if len(parts) != 2:
                        continue
                    repo_path = parts[1]
                    if not should_hydrate_tarball_path(repo_path):
                        continue
                    extracted = archive.extractfile(member)
                    if extracted is None:
                        continue
                    self._write_repo_file(repo_path, extracted.read())
        finally:
            tmp_path.unlink(missing_ok=True)

    def ensure_file(self, repo_path: str) -> Path:
        repo_path = normalize_repo_path(repo_path)
        local = self.local_path(repo_path)
        if local.exists():
            return local
        entry = self.tree().get(repo_path)
        if not entry or entry.get("type") != "blob":
            raise FileNotFoundError(repo_path)
        self._write_repo_file(repo_path, self.blob_bytes(entry["sha"]))
        return local

    def local_path(self, repo_path: str) -> Path:
        repo_path = normalize_repo_path(repo_path)
        target = (self.root / repo_path).resolve()
        if self.root not in target.parents and target != self.root:
            raise ValueError("Path escapes GitHub cache root")
        return target

    def put_local_file(self, repo_path: str, message: str) -> None:
        repo_path = normalize_repo_path(repo_path)
        local = self.local_path(repo_path)
        content = local.read_bytes()
        current_sha = self.current_sha(repo_path)
        body: dict[str, Any] = {
            "message": message,
            "content": base64.b64encode(content).decode("ascii"),
            "branch": self.branch,
        }
        if current_sha:
            body["sha"] = current_sha
        self.request("PUT", f"/repos/{self.owner}/{self.repo}/contents/{quote_path(repo_path)}", body)
        self.refresh_tree()

    def delete_repo_file(self, repo_path: str, message: str) -> None:
        repo_path = normalize_repo_path(repo_path)
        current_sha = self.current_sha(repo_path)
        if not current_sha:
            return
        body = {"message": message, "sha": current_sha, "branch": self.branch}
        self.request("DELETE", f"/repos/{self.owner}/{self.repo}/contents/{quote_path(repo_path)}", body)
        self.refresh_tree()

    def current_sha(self, repo_path: str) -> str:
        entry = self.tree().get(normalize_repo_path(repo_path))
        if not entry or entry.get("type") != "blob":
            return ""
        return str(entry.get("sha") or "")

    def tree(self) -> dict[str, dict[str, Any]]:
        if self._tree is None:
            data = self.request("GET", f"/repos/{self.owner}/{self.repo}/git/trees/{quote_path(self.branch)}?recursive=1")
            self._tree = {
                item["path"]: item
                for item in data.get("tree", [])
                if isinstance(item, dict) and isinstance(item.get("path"), str)
            }
        return self._tree

    def refresh_tree(self) -> None:
        self._tree = None

    def blob_bytes(self, sha: str) -> bytes:
        data = self.request("GET", f"/repos/{self.owner}/{self.repo}/git/blobs/{sha}")
        content = str(data.get("content") or "")
        return base64.b64decode(content)

    def commits_for_path(self, repo_path: str) -> list[dict[str, str]]:
        repo_path = normalize_repo_path(repo_path)
        query = urllib.parse.urlencode({"sha": self.branch, "path": repo_path, "per_page": "10"})
        data = self.request("GET", f"/repos/{self.owner}/{self.repo}/commits?{query}")
        commits = []
        if not isinstance(data, list):
            return commits
        for item in data:
            commit = item.get("commit", {}) if isinstance(item, dict) else {}
            author = commit.get("author", {}) if isinstance(commit, dict) else {}
            commits.append(
                {
                    "sha": str(item.get("sha", ""))[:7],
                    "date": str(author.get("date", ""))[:10],
                    "author": str(author.get("name", "")),
                    "subject": str(commit.get("message", "")).splitlines()[0],
                }
            )
        return commits

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        if not self.token:
            raise GitHubError("GITHUB_TOKEN is not configured")
        url = f"https://api.github.com{path}"
        data = None
        headers = {
            "accept": "application/vnd.github+json",
            "authorization": f"Bearer {self.token}",
            "user-agent": "dataops-lambda",
            "x-github-api-version": "2022-11-28",
        }
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["content-type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            raise GitHubError(f"GitHub {method} {path} failed: HTTP {exc.code}: {detail}") from exc
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def _write_repo_file(self, repo_path: str, content: bytes) -> None:
        local = self.local_path(repo_path)
        local.parent.mkdir(parents=True, exist_ok=True)
        local.write_bytes(content)


def normalize_repo_path(path: str) -> str:
    clean = path.strip().replace("\\", "/").lstrip("/")
    if not clean or ".." in clean.split("/"):
        raise ValueError("Invalid repository path")
    return clean


def should_hydrate_tarball_path(path: str) -> bool:
    try:
        repo_path = normalize_repo_path(path)
    except ValueError:
        return False
    if not repo_path.startswith("content/"):
        return False
    if repo_path.endswith(".md"):
        return True
    return repo_path.startswith("content/images/") and Path(repo_path).suffix.lower() in CONTENT_IMAGE_EXTENSIONS


def quote_path(path: str) -> str:
    return urllib.parse.quote(path, safe="/")


_SECRET_CACHE: dict[str, str] = {}
_GITHUB_TOKEN_CACHE: str | None = None


def github_token() -> str:
    global _GITHUB_TOKEN_CACHE
    if _GITHUB_TOKEN_CACHE is not None:
        return _GITHUB_TOKEN_CACHE

    token = os.environ.get("GITHUB_TOKEN", "")
    secret_name = os.environ.get("GITHUB_TOKEN_SECRET_NAME", "")
    if token or not secret_name:
        _GITHUB_TOKEN_CACHE = token
        return token

    secret = secret_string(secret_name)
    _GITHUB_TOKEN_CACHE = secret
    return secret


def secret_string(secret_name: str) -> str:
    if secret_name in _SECRET_CACHE:
        return _SECRET_CACHE[secret_name]

    try:
        import boto3  # type: ignore[import-not-found]

        data = boto3.client("secretsmanager").get_secret_value(SecretId=secret_name)
    except Exception as exc:
        raise GitHubError(f"Could not load secret {secret_name}: {exc}") from exc

    secret = data.get("SecretString") or ""
    if not secret and data.get("SecretBinary"):
        secret = base64.b64decode(data["SecretBinary"]).decode("utf-8")
    _SECRET_CACHE[secret_name] = secret
    return secret
