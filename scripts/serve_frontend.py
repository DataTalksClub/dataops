#!/usr/bin/env python3
"""ASGI dev server for the static frontend.

Replaces the previous SimpleHTTPRequestHandler with a uvicorn-served ASGI
app. We get HTTP/1.1 keep-alive, gzip, and async I/O for the API proxy —
all the things that mattered when the page was being viewed across an SSH
or VS Code remote tunnel.

Routes:
  GET  /                  → frontend index with injected version label.
  GET  /src/...           → static files from FRONTEND_ROOT.
  GET  /content/...       → image and other content assets from CONTENT_ROOT.
  *    /docs|/search|/health[/...]
                          → proxied to API_UPSTREAM (the lambda backend).
"""
from __future__ import annotations

import asyncio
import gzip
import hashlib
import json
import mimetypes
import os
import shutil
from pathlib import Path

import httpx
import uvicorn


FRONTEND_ROOT = Path(os.environ.get("FRONTEND_ROOT", "/app/frontend"))
CONTENT_ROOT = Path(os.environ.get("CONTENT_ROOT", "/app/content"))
REPO_ROOT = Path(os.environ.get("REPO_ROOT", str(CONTENT_ROOT.parent))).resolve()
API_UPSTREAM = os.environ.get("API_UPSTREAM", "http://lambda-functions:8787").rstrip("/")
GIT_COMMIT = os.environ.get("DTC_GIT", "").strip()
VERSIONED_FILES = ("index.html", "src/app.js", "src/styles.css")
API_ROUTES = ("/docs", "/search", "/health", "/images", "/folders", "/lint", "/parse")
GIT_ROUTES = ("/git/status", "/git/commit", "/git/pull", "/git/log")
GZIP_TYPES = {
    "application/json",
    "text/html",
    "text/css",
    "application/javascript",
    "text/javascript",
    "text/plain",
    "image/svg+xml",
}
GZIP_MIN_BYTES = 512


def compute_version() -> str:
    digest = hashlib.md5()
    for relative in VERSIONED_FILES:
        path = FRONTEND_ROOT / relative
        if not path.exists():
            continue
        digest.update(path.read_bytes())
    short = digest.hexdigest()[:7]
    label = f"build {short}"
    if GIT_COMMIT:
        label = f"git {GIT_COMMIT} · {label}"
    return label


_upstream_client: httpx.AsyncClient | None = None


def _get_upstream_client() -> httpx.AsyncClient:
    global _upstream_client
    if _upstream_client is None:
        _upstream_client = httpx.AsyncClient(
            base_url=API_UPSTREAM,
            timeout=30.0,
            http2=False,
            limits=httpx.Limits(max_keepalive_connections=10, max_connections=20),
        )
    return _upstream_client


def _accepts_gzip(headers: list[tuple[bytes, bytes]]) -> bool:
    for k, v in headers:
        if k.lower() == b"accept-encoding" and b"gzip" in v.lower():
            return True
    return False


async def _send_response(
    send,
    status: int,
    body: bytes,
    content_type: str,
    accepts_gzip: bool,
    extra_headers: list[tuple[bytes, bytes]] | None = None,
) -> None:
    headers: list[tuple[bytes, bytes]] = [
        (b"cache-control", b"no-store"),
    ]
    if extra_headers:
        headers.extend(extra_headers)

    ctype_norm = content_type.split(";")[0].strip().lower()
    if (
        accepts_gzip
        and len(body) >= GZIP_MIN_BYTES
        and ctype_norm in GZIP_TYPES
    ):
        body = gzip.compress(body, compresslevel=5, mtime=0)
        headers.append((b"content-encoding", b"gzip"))
        headers.append((b"vary", b"accept-encoding"))

    headers.append((b"content-type", content_type.encode("latin-1", "ignore")))
    headers.append((b"content-length", str(len(body)).encode()))
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body, "more_body": False})


def _resolve_static(rel: str, root: Path) -> Path | None:
    if not rel:
        return None
    if rel.startswith("/"):
        return None
    parts = rel.split("/")
    if any(p == ".." for p in parts):
        return None
    target = (root / rel).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        return None
    if not target.is_file():
        return None
    return target


def _is_api_path(path: str) -> bool:
    for route in API_ROUTES:
        if path == route or path.startswith(route + "/") or path.startswith(route + "?"):
            return True
    return False


def _is_git_path(path: str) -> bool:
    for route in GIT_ROUTES:
        if path == route or path.startswith(route + "?"):
            return True
    return False


async def _run_git(args: list[str], cwd: Path) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        "git", *args,
        cwd=str(cwd),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    )
    stdout, stderr = await proc.communicate()
    return proc.returncode or 0, stdout.decode("utf-8", "replace"), stderr.decode("utf-8", "replace")


async def _git_status_payload() -> dict:
    if shutil.which("git") is None:
        return {"ok": False, "error": "git is not installed in the frontend container"}
    if not (REPO_ROOT / ".git").exists():
        return {"ok": False, "error": f"no .git directory at {REPO_ROOT}"}
    code, out, err = await _run_git(["status", "--porcelain"], REPO_ROOT)
    if code != 0:
        return {"ok": False, "error": err.strip() or "git status failed"}
    files = []
    for line in out.splitlines():
        if not line:
            continue
        status_code = line[:2]
        path = line[3:]
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        files.append({"status": status_code.strip() or "?", "path": path})
    branch_code, branch_out, _ = await _run_git(["rev-parse", "--abbrev-ref", "HEAD"], REPO_ROOT)
    branch = branch_out.strip() if branch_code == 0 else ""
    remote_code, remote_out, _ = await _run_git(["remote", "get-url", "origin"], REPO_ROOT)
    remote = remote_out.strip() if remote_code == 0 else ""
    github = _github_https_url(remote)
    return {"ok": True, "files": files, "count": len(files), "branch": branch, "remote": remote, "github": github}


def _github_https_url(remote: str) -> str:
    if not remote:
        return ""
    # git@github.com:owner/repo.git → https://github.com/owner/repo
    m = remote.strip()
    if m.startswith("git@github.com:"):
        rest = m[len("git@github.com:") :]
        rest = rest.removesuffix(".git")
        return f"https://github.com/{rest}"
    if m.startswith("https://github.com/"):
        return m.removesuffix(".git")
    return ""


async def _handle_git_status(send, accepts_gzip: bool) -> None:
    payload = await _git_status_payload()
    body = json.dumps(payload).encode("utf-8")
    await _send_response(send, 200 if payload.get("ok") else 503, body, "application/json", accepts_gzip)


async def _handle_git_pull(send, accepts_gzip: bool) -> None:
    if shutil.which("git") is None or not (REPO_ROOT / ".git").exists():
        await _send_response(send, 503, b'{"ok":false,"error":"git not available"}', "application/json", accepts_gzip)
        return
    code, out, err = await _run_git(["pull", "--ff-only"], REPO_ROOT)
    body = json.dumps({
        "ok": code == 0,
        "exit": code,
        "stdout": out.strip(),
        "stderr": err.strip(),
    }).encode("utf-8")
    await _send_response(send, 200 if code == 0 else 500, body, "application/json", accepts_gzip)


async def _handle_git_log(scope, send, accepts_gzip: bool) -> None:
    if shutil.which("git") is None or not (REPO_ROOT / ".git").exists():
        await _send_response(send, 503, b'{"ok":false,"error":"git not available"}', "application/json", accepts_gzip)
        return
    query = scope.get("query_string", b"").decode("ascii")
    params = {}
    for pair in query.split("&"):
        if "=" in pair:
            k, v = pair.split("=", 1)
            params[k] = v
    target = params.get("path", "").strip()
    if not target:
        await _send_response(send, 400, b'{"ok":false,"error":"missing path"}', "application/json", accepts_gzip)
        return
    # urldecode the path
    import urllib.parse
    target = urllib.parse.unquote(target)
    code, out, err = await _run_git(
        ["log", "-10", "--pretty=format:%h|%ad|%an|%s", "--date=short", "--", target],
        REPO_ROOT,
    )
    commits = []
    if code == 0:
        for line in out.strip().splitlines():
            parts = line.split("|", 3)
            if len(parts) == 4:
                commits.append({"sha": parts[0], "date": parts[1], "author": parts[2], "subject": parts[3]})
    body = json.dumps({"ok": code == 0, "commits": commits, "error": err.strip() if code != 0 else ""}).encode("utf-8")
    await _send_response(send, 200 if code == 0 else 500, body, "application/json", accepts_gzip)


async def _handle_git_commit(receive, send, accepts_gzip: bool) -> None:
    raw_body = await _read_request_body(receive)
    options: dict = {}
    if raw_body:
        try:
            options = json.loads(raw_body)
        except json.JSONDecodeError:
            await _send_response(send, 400, b'{"error":"invalid json body"}', "application/json", accepts_gzip)
            return

    status = await _git_status_payload()
    if not status.get("ok"):
        await _send_response(send, 503, json.dumps(status).encode("utf-8"), "application/json", accepts_gzip)
        return
    if not status.get("files"):
        body = json.dumps({"ok": True, "committed": False, "reason": "nothing to commit", "files": []}).encode("utf-8")
        await _send_response(send, 200, body, "application/json", accepts_gzip)
        return

    message = options.get("message") if isinstance(options.get("message"), str) else None
    push = bool(options.get("push", True))
    if not message or not message.strip():
        count = len(status["files"])
        message = f"Update {count} doc{'s' if count != 1 else ''}"

    steps: list[dict] = []

    async def run_step(label: str, args: list[str]) -> tuple[int, str, str]:
        code, out, err = await _run_git(args, REPO_ROOT)
        steps.append({"step": label, "exit": code, "stdout": out.strip(), "stderr": err.strip()})
        return code, out, err

    code, _, _ = await run_step("add", ["add", "-A"])
    if code != 0:
        body = json.dumps({"ok": False, "committed": False, "steps": steps}).encode("utf-8")
        await _send_response(send, 500, body, "application/json", accepts_gzip)
        return
    code, _, _ = await run_step("commit", ["commit", "-m", message])
    if code != 0:
        body = json.dumps({"ok": False, "committed": False, "steps": steps}).encode("utf-8")
        await _send_response(send, 500, body, "application/json", accepts_gzip)
        return
    pushed = False
    if push:
        code, _, _ = await run_step("push", ["push"])
        pushed = code == 0
        if not pushed:
            body = json.dumps({
                "ok": False,
                "committed": True,
                "pushed": False,
                "steps": steps,
                "message": message,
            }).encode("utf-8")
            await _send_response(send, 500, body, "application/json", accepts_gzip)
            return

    body = json.dumps({
        "ok": True,
        "committed": True,
        "pushed": pushed,
        "message": message,
        "steps": steps,
    }).encode("utf-8")
    await _send_response(send, 200, body, "application/json", accepts_gzip)


async def _read_request_body(receive) -> bytes:
    chunks: list[bytes] = []
    while True:
        message = await receive()
        if message["type"] == "http.request":
            chunks.append(message.get("body", b""))
            if not message.get("more_body"):
                break
        elif message["type"] == "http.disconnect":
            break
    return b"".join(chunks)


async def _proxy_api(scope, receive, send) -> None:
    method = scope["method"]
    path = scope["path"]
    query = scope.get("query_string", b"").decode("ascii")
    url = path + ("?" + query if query else "")

    forwarded: dict[str, str] = {}
    for k, v in scope.get("headers", []):
        key = k.decode("latin-1").lower()
        if key in {"content-type", "x-user-email", "accept"}:
            forwarded[key] = v.decode("latin-1")

    body = b""
    if method in {"POST", "PUT", "PATCH"}:
        body = await _read_request_body(receive)

    accepts_gzip = _accepts_gzip(scope.get("headers", []))

    client = _get_upstream_client()
    try:
        resp = await client.request(method, url, content=body or None, headers=forwarded)
    except httpx.HTTPError as exc:
        await _send_response(
            send,
            502,
            f'{{"error":"upstream unreachable","detail":"{exc}"}}'.encode("utf-8"),
            "application/json",
            accepts_gzip,
        )
        return

    ctype = resp.headers.get("content-type", "application/json")
    await _send_response(send, resp.status_code, resp.content, ctype, accepts_gzip)


async def _serve_index(send, accepts_gzip: bool) -> None:
    try:
        html = (FRONTEND_ROOT / "index.html").read_text(encoding="utf-8")
    except OSError as exc:
        await _send_response(send, 500, f"index.html: {exc}".encode(), "text/plain", accepts_gzip)
        return
    version_script = (
        "<script>"
        f"document.getElementById('app-version').textContent = {json.dumps(compute_version())};"
        "</script>"
    )
    if "</body>" in html:
        html = html.replace("</body>", f"{version_script}\n</body>", 1)
    else:
        html += version_script
    await _send_response(send, 200, html.encode("utf-8"), "text/html; charset=utf-8", accepts_gzip)


async def _serve_content(send, url_path: str, accepts_gzip: bool) -> None:
    rel = url_path[len("/content/") :]
    target = _resolve_static(rel, CONTENT_ROOT)
    if target is None:
        await _send_response(send, 404, b"not found", "text/plain", accepts_gzip)
        return
    ctype, _ = mimetypes.guess_type(str(target))
    if not ctype:
        ctype = "application/octet-stream"
    await _send_response(send, 200, target.read_bytes(), ctype, accepts_gzip)


async def _serve_frontend_static(send, url_path: str, accepts_gzip: bool) -> None:
    rel = url_path.lstrip("/")
    target = _resolve_static(rel, FRONTEND_ROOT)
    if target is None:
        await _send_response(send, 404, b"not found", "text/plain", accepts_gzip)
        return
    ctype, _ = mimetypes.guess_type(str(target))
    if not ctype:
        ctype = "application/octet-stream"
    await _send_response(send, 200, target.read_bytes(), ctype, accepts_gzip)


async def app(scope, receive, send):
    if scope["type"] == "lifespan":
        # Minimal lifespan handling so uvicorn doesn't warn.
        while True:
            message = await receive()
            if message["type"] == "lifespan.startup":
                await send({"type": "lifespan.startup.complete"})
            elif message["type"] == "lifespan.shutdown":
                global _upstream_client
                if _upstream_client is not None:
                    await _upstream_client.aclose()
                    _upstream_client = None
                await send({"type": "lifespan.shutdown.complete"})
                return
            else:
                return
    if scope["type"] != "http":
        return

    path = scope["path"]
    method = scope["method"]
    accepts_gzip = _accepts_gzip(scope.get("headers", []))

    if _is_git_path(path):
        if path == "/git/status" and method == "GET":
            await _handle_git_status(send, accepts_gzip)
            return
        if path == "/git/commit" and method == "POST":
            await _handle_git_commit(receive, send, accepts_gzip)
            return
        if path == "/git/pull" and method == "POST":
            await _handle_git_pull(send, accepts_gzip)
            return
        if path.startswith("/git/log") and method == "GET":
            await _handle_git_log(scope, send, accepts_gzip)
            return
        await _send_response(send, 405, b'{"error":"method not allowed"}', "application/json", accepts_gzip)
        return

    if _is_api_path(path):
        await _proxy_api(scope, receive, send)
        return

    if path in ("/", "/index.html"):
        await _serve_index(send, accepts_gzip)
        return

    if "." not in Path(path).name:
        await _serve_index(send, accepts_gzip)
        return

    if path.endswith(".md"):
        await _serve_index(send, accepts_gzip)
        return

    if path.startswith("/content/"):
        await _serve_content(send, path, accepts_gzip)
        return

    await _serve_frontend_static(send, path, accepts_gzip)


def main() -> None:
    port = int(os.environ.get("PORT", "5173"))
    print(f"Serving {FRONTEND_ROOT} on :{port} (API → {API_UPSTREAM})")
    uvicorn.run(
        "serve_frontend:app",
        host="0.0.0.0",
        port=port,
        log_level="info",
        access_log=True,
        proxy_headers=True,
    )


if __name__ == "__main__":
    main()
