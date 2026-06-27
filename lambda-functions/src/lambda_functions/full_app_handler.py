import base64
import gzip
import hashlib
import hmac
import json
import mimetypes
import os
import urllib.parse
from pathlib import Path
from typing import Any


CACHE_ROOT = Path(os.environ.get("DTC_CACHE_ROOT", "/tmp/dataops")).resolve()
os.environ.setdefault("CONTENT_ROOT", str(CACHE_ROOT / "content"))
os.environ.setdefault("SEARCH_INDEX_PATH", "/tmp/dataops-search.index")

from lambda_functions import api_handler, search_handler  # noqa: E402
from lambda_functions.docs_index import build_index  # noqa: E402
from lambda_functions.github_store import GitHubError, GitHubStore, secret_string  # noqa: E402


_PACKAGE_ROOT = Path(__file__).resolve().parents[1]
_REPO_FRONTEND_ROOT = Path(__file__).resolve().parents[3] / "frontend"
FRONTEND_ROOT = Path(os.environ.get("FRONTEND_ROOT", _PACKAGE_ROOT / "frontend"))
if not FRONTEND_ROOT.exists() and _REPO_FRONTEND_ROOT.exists():
    FRONTEND_ROOT = _REPO_FRONTEND_ROOT
GZIP_TYPES = {
    "application/json",
    "text/html",
    "text/css",
    "application/javascript",
    "text/javascript",
    "text/plain",
    "image/svg+xml",
}
API_ROUTES = ("/docs", "/images", "/folders", "/lint", "/parse")
MUTATING_METHODS = {"POST", "PUT", "DELETE"}
STORE = GitHubStore(CACHE_ROOT)
_search_ready = False


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    method = event.get("requestContext", {}).get("http", {}).get("method", event.get("httpMethod", "GET"))
    path = event.get("rawPath") or event.get("path") or "/"

    if path == "/admin/refresh" and method == "POST" and is_internal_refresh_event(event):
        return refresh_from_github()

    if path == "/login" and method == "GET":
        return login_page("")
    if path == "/login" and method == "POST":
        return handle_login(event)
    if path == "/logout":
        return {
            "statusCode": 302,
            "headers": {
                "location": "/login",
                "set-cookie": "dtc_auth=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
                "cache-control": "no-store",
            },
            "body": "",
        }

    auth_response = require_auth(event)
    if auth_response:
        return auth_response

    try:
        if path in ("/", "/index.html") and method == "GET":
            return serve_index(event)
        if path.startswith("/src/") and method == "GET":
            return serve_frontend_static(path, event)
        if path.startswith("/content/") and method == "GET":
            return serve_content(path, event)
        if path == "/search" and method in {"GET", "OPTIONS"}:
            ensure_search()
            return search_handler.handler(event, context)
        if path == "/admin/refresh" and method == "POST":
            return refresh_from_github()
        if is_api_path(path):
            return handle_api(event, context, path, method)
        if path.startswith("/git/"):
            return handle_git_compat(event, path, method)
        if "." not in Path(path).name and method == "GET":
            return serve_index(event)
        if path.endswith(".md") and method == "GET":
            return serve_index(event)
        if method == "GET":
            return serve_frontend_static(path, event)
        return json_response(405, {"error": "Method not allowed"})
    except GitHubError as exc:
        return json_response(502, {"error": "GitHub request failed", "detail": str(exc)})
    except FileNotFoundError:
        return json_response(404, {"error": "Not found"})
    except ValueError as exc:
        return json_response(400, {"error": str(exc)})


def require_auth(event: dict[str, Any]) -> dict[str, Any] | None:
    if valid_session_cookie(event):
        return None
    if valid_basic_auth(event):
        return None
    return redirect_to_login()


def valid_session_cookie(event: dict[str, Any]) -> bool:
    expected = session_token()
    if not expected:
        return False
    cookie = header_value(event, "cookie")
    for part in cookie.split(";"):
        name, sep, value = part.strip().partition("=")
        if sep and name == "dtc_auth" and hmac.compare_digest(value, expected):
            return True
    return False


def session_token() -> str:
    password = basic_auth_password()
    if not password:
        return ""
    return hmac.new(password.encode("utf-8"), b"dataops-session", hashlib.sha256).hexdigest()


def valid_basic_auth(event: dict[str, Any]) -> bool:
    username = os.environ.get("BASIC_AUTH_USERNAME", "admin")
    password = basic_auth_password()
    if not password:
        return False
    header = header_value(event, "authorization")
    prefix = "Basic "
    if not header.startswith(prefix):
        return False
    try:
        decoded = base64.b64decode(header[len(prefix):]).decode("utf-8")
    except Exception:
        return False
    supplied_user, sep, supplied_password = decoded.partition(":")
    if not sep:
        return False
    return hmac.compare_digest(supplied_user, username) and hmac.compare_digest(supplied_password, password)


def auth_challenge() -> dict[str, Any]:
    return {
        "statusCode": 401,
        "headers": {
            "www-authenticate": 'Basic realm="DataOps"',
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
        },
        "body": "Authentication required",
    }


def redirect_to_login() -> dict[str, Any]:
    return {
        "statusCode": 302,
        "headers": {"location": "/login", "cache-control": "no-store"},
        "body": "",
    }


def handle_login(event: dict[str, Any]) -> dict[str, Any]:
    username = os.environ.get("BASIC_AUTH_USERNAME", "admin")
    password = basic_auth_password()
    body = raw_body(event)
    content_type = header_value(event, "content-type")
    supplied_user = ""
    supplied_password = ""
    if "application/json" in content_type:
        try:
            payload = json.loads(body or "{}")
        except json.JSONDecodeError:
            payload = {}
        if isinstance(payload, dict):
            supplied_user = str(payload.get("username") or "")
            supplied_password = str(payload.get("password") or "")
            remember = bool(payload.get("remember"))
    else:
        params = urllib.parse.parse_qs(body)
        supplied_user = params.get("username", [""])[-1]
        supplied_password = params.get("password", [""])[-1]
        remember = params.get("remember", [""])[-1] in {"1", "true", "on", "yes"}

    if (
        password
        and hmac.compare_digest(supplied_user, username)
        and hmac.compare_digest(supplied_password, password)
    ):
        max_age = "; Max-Age=15552000" if remember else ""
        return {
            "statusCode": 302,
            "headers": {
                "location": "/",
                "set-cookie": f"dtc_auth={session_token()}; Path=/{max_age}; HttpOnly; Secure; SameSite=Lax",
                "cache-control": "no-store",
            },
            "body": "",
        }
    return login_page("Invalid username or password.")


def basic_auth_password() -> str:
    password = os.environ.get("BASIC_AUTH_PASSWORD", "")
    secret_name = os.environ.get("BASIC_AUTH_PASSWORD_SECRET_NAME", "")
    if password or not secret_name:
        return password
    return secret_string(secret_name)


def login_page(error: str) -> dict[str, Any]:
    error_html = f'<p class="error">{html_escape(error)}</p>' if error else ""
    html = f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>DataOps Login</title>
    <style>
      :root {{ color-scheme: light dark; }}
      body {{
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f6f5f1;
        color: #23231f;
      }}
      form {{
        width: min(360px, calc(100vw - 32px));
        display: grid;
        gap: 12px;
      }}
      h1 {{ margin: 0 0 8px; font-size: 24px; }}
      label {{ display: grid; gap: 6px; font-size: 13px; color: #55524a; }}
      .check {{
        display: flex;
        align-items: center;
        gap: 8px;
        color: #55524a;
        font-size: 13px;
      }}
      input {{
        box-sizing: border-box;
        width: 100%;
        padding: 11px 12px;
        border: 1px solid #cbc8bd;
        border-radius: 6px;
        font: inherit;
        background: #fff;
        color: #23231f;
      }}
      input[type="checkbox"] {{
        width: 16px;
        height: 16px;
        padding: 0;
      }}
      button {{
        padding: 11px 14px;
        border: 0;
        border-radius: 6px;
        font: inherit;
        font-weight: 650;
        background: #256f6c;
        color: white;
        cursor: pointer;
      }}
      .error {{ margin: 0; color: #a33; font-size: 13px; }}
    </style>
  </head>
  <body>
    <form method="post" action="/login">
      <h1>DataOps</h1>
      {error_html}
      <label>Username <input name="username" autocomplete="username" autofocus></label>
      <label>Password <input name="password" type="password" autocomplete="current-password"></label>
      <label class="check"><input name="remember" type="checkbox" value="1" checked> Remember me</label>
      <button type="submit">Sign in</button>
    </form>
  </body>
</html>"""
    return {
        "statusCode": 200,
        "headers": {"content-type": "text/html; charset=utf-8", "cache-control": "no-store"},
        "body": html,
    }


def handle_api(event: dict[str, Any], context: Any, path: str, method: str) -> dict[str, Any]:
    STORE.sync_markdown()
    before = mutation_snapshot(path, method, event)
    response = api_handler.handler(event, context)
    status = int(response.get("statusCode", 500))
    if method in MUTATING_METHODS and 200 <= status < 300:
        commit_mutation(path, method, event, before, response)
        rebuild_search()
    return response


def mutation_snapshot(path: str, method: str, event: dict[str, Any]) -> dict[str, Any]:
    if method == "DELETE" and path == "/docs":
        doc_path = query_param(event, "path")
        return {"path": doc_path}
    if method == "POST" and path in {"/docs/rename", "/folders/rename"}:
        body = json_body(event)
        return {"old_path": body.get("old_path"), "new_path": body.get("new_path")}
    if method == "DELETE" and path == "/folders":
        folder = query_param(event, "path")
        prefix = normalize_content_prefix(folder)
        files = [p for p in STORE.tree() if p.startswith(prefix + "/") and STORE.tree()[p].get("type") == "blob"]
        return {"folder": folder, "files": files}
    return {}


def commit_mutation(path: str, method: str, event: dict[str, Any], before: dict[str, Any], response: dict[str, Any]) -> None:
    if path == "/docs" and method in {"PUT", "POST"}:
        repo_path = response_json(response).get("path") or query_param(event, "path")
        if repo_path:
            STORE.put_local_file(str(repo_path), f"Update {repo_path}")
    elif path == "/docs" and method == "DELETE":
        repo_path = before.get("path")
        if repo_path:
            STORE.delete_repo_file(str(repo_path), f"Delete {repo_path}")
    elif path == "/docs/rename" and method == "POST":
        payload = response_json(response)
        old_path = str(payload.get("old_path") or before.get("old_path") or "")
        new_path = str(payload.get("new_path") or before.get("new_path") or "")
        if new_path:
            STORE.put_local_file(new_path, f"Rename {old_path} to {new_path}")
        if old_path:
            STORE.delete_repo_file(old_path, f"Remove renamed {old_path}")
    elif path == "/images" and method == "POST":
        repo_path = response_json(response).get("absolute_path")
        if repo_path:
            STORE.put_local_file(str(repo_path), f"Upload {repo_path}")
    elif path == "/folders" and method == "DELETE":
        for repo_path in before.get("files", []):
            STORE.delete_repo_file(str(repo_path), f"Delete {repo_path}")
    elif path == "/folders/rename" and method == "POST":
        payload = response_json(response)
        old_prefix = normalize_content_prefix(str(payload.get("old_path") or before.get("old_path") or ""))
        new_prefix = normalize_content_prefix(str(payload.get("new_path") or before.get("new_path") or ""))
        for local in sorted((CACHE_ROOT / new_prefix).rglob("*")):
            if local.is_file():
                repo_path = local.relative_to(CACHE_ROOT).as_posix()
                STORE.put_local_file(repo_path, f"Rename folder {old_prefix} to {new_prefix}")
        for repo_path in list(STORE.tree()):
            if repo_path.startswith(old_prefix + "/"):
                STORE.delete_repo_file(repo_path, f"Remove renamed {repo_path}")


def ensure_search() -> None:
    STORE.sync_markdown()
    global _search_ready
    if not _search_ready or not Path(os.environ["SEARCH_INDEX_PATH"]).exists():
        rebuild_search()


def rebuild_search() -> None:
    global _search_ready
    build_index(STORE.content_root, Path(os.environ["SEARCH_INDEX_PATH"]))
    search_handler.reset_index()
    _search_ready = True


def serve_index(event: dict[str, Any]) -> dict[str, Any]:
    html = (FRONTEND_ROOT / "index.html").read_text(encoding="utf-8")
    version_script = (
        "<script>"
        f"document.getElementById('app-version').textContent = {json.dumps(compute_version())};"
        "</script>"
    )
    html = html.replace("</body>", f"{version_script}\n</body>", 1) if "</body>" in html else html + version_script
    return file_response(html.encode("utf-8"), "text/html; charset=utf-8", event)


def serve_frontend_static(path: str, event: dict[str, Any]) -> dict[str, Any]:
    rel = path.lstrip("/") or "index.html"
    target = resolve_under(FRONTEND_ROOT, rel)
    return file_response(target.read_bytes(), guess_type(target), event)


def serve_content(path: str, event: dict[str, Any]) -> dict[str, Any]:
    repo_path = path.lstrip("/")
    target = STORE.ensure_file(repo_path)
    return file_response(target.read_bytes(), guess_type(target), event)


def handle_git_compat(event: dict[str, Any], path: str, method: str) -> dict[str, Any]:
    if path == "/git/status" and method == "GET":
        return json_response(200, {"ok": True, "files": [], "count": 0, "branch": STORE.branch, "remote": STORE.github_url, "github": STORE.github_url})
    if path == "/git/pull" and method == "POST":
        response = refresh_from_github()
        payload = response_json(response)
        payload.update({"stdout": "Synced from GitHub", "stderr": ""})
        return json_response(response["statusCode"], payload)
    if path == "/git/commit" and method == "POST":
        return json_response(200, {"ok": True, "committed": False, "reason": "Changes are committed automatically"})
    if path == "/git/log" and method == "GET":
        target = query_param(event, "path")
        commits = STORE.commits_for_path(target) if target else []
        return json_response(200, {"ok": True, "commits": commits, "error": ""})
    return json_response(404, {"error": "Not found"})


def is_internal_refresh_event(event: dict[str, Any]) -> bool:
    return event.get("source") in {"dataops.github-actions", "dtc-operations.github-actions"}


def refresh_from_github() -> dict[str, Any]:
    STORE.reset()
    search_handler.reset_index()
    global _search_ready
    _search_ready = False
    STORE.sync_markdown()
    rebuild_search()
    return json_response(200, {"ok": True, "refreshed": True, "branch": STORE.branch})


def file_response(body: bytes, content_type: str, event: dict[str, Any]) -> dict[str, Any]:
    headers = {"content-type": content_type, "cache-control": "no-store"}
    is_binary = not content_type.startswith(("text/", "application/json", "application/javascript"))
    if accepts_gzip(event) and len(body) >= 512 and content_type.split(";")[0] in GZIP_TYPES:
        body = gzip.compress(body, compresslevel=5, mtime=0)
        headers["content-encoding"] = "gzip"
        headers["vary"] = "accept-encoding"
        is_binary = True
    if is_binary:
        return {"statusCode": 200, "headers": headers, "body": base64.b64encode(body).decode("ascii"), "isBase64Encoded": True}
    return {"statusCode": 200, "headers": headers, "body": body.decode("utf-8")}


def json_response(status: int, body: dict[str, Any]) -> dict[str, Any]:
    return {"statusCode": status, "headers": {"content-type": "application/json", "cache-control": "no-store"}, "body": json.dumps(body)}


def is_api_path(path: str) -> bool:
    return any(path == route or path.startswith(route + "/") for route in API_ROUTES)


def resolve_under(root: Path, rel: str) -> Path:
    if ".." in rel.split("/"):
        raise ValueError("Invalid path")
    target = (root / rel).resolve()
    if root not in target.parents and target != root:
        raise ValueError("Path escapes root")
    if not target.is_file():
        raise FileNotFoundError(rel)
    return target


def compute_version() -> str:
    digest = hashlib.md5()
    for rel in ("index.html", "src/app.js", "src/styles.css"):
        path = FRONTEND_ROOT / rel
        if path.exists():
            digest.update(path.read_bytes())
    return f"github {STORE.branch} · build {digest.hexdigest()[:7]}"


def response_json(response: dict[str, Any]) -> dict[str, Any]:
    try:
        body = json.loads(response.get("body") or "{}")
        return body if isinstance(body, dict) else {}
    except json.JSONDecodeError:
        return {}


def json_body(event: dict[str, Any]) -> dict[str, Any]:
    raw = raw_body(event) or "{}"
    body = json.loads(raw)
    return body if isinstance(body, dict) else {}


def raw_body(event: dict[str, Any]) -> str:
    raw = event.get("body") or ""
    if event.get("isBase64Encoded"):
        return base64.b64decode(raw).decode("utf-8")
    return str(raw)


def query_param(event: dict[str, Any], name: str) -> str | None:
    params = event.get("queryStringParameters") or {}
    value = params.get(name)
    return str(value) if value is not None else None


def normalize_content_prefix(path: str | None) -> str:
    raw = (path or "").strip().replace("\\", "/").lstrip("/")
    if not raw.startswith("content/"):
        raw = "content/" + raw
    return raw.rstrip("/")


def header_value(event: dict[str, Any], name: str) -> str:
    headers = event.get("headers") or {}
    for key, value in headers.items():
        if key.lower() == name.lower():
            return str(value)
    return ""


def accepts_gzip(event: dict[str, Any]) -> bool:
    return "gzip" in header_value(event, "accept-encoding").lower()


def guess_type(path: Path) -> str:
    content_type, _ = mimetypes.guess_type(str(path))
    return content_type or "application/octet-stream"


def html_escape(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )
