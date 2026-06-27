from __future__ import annotations

"""
Smoke tests for the /work/api dashboard integration (issue #51).

These cover the local-dev and frontend contract for the brokered work API:
- The local server proxies /work/api/* to the work-engine dev server.
- The frontend app.js builds /work/api/* URLs (not bare /api/*).
- The request helper rejects non-JSON (e.g. login HTML) responses.
"""

import io
import json
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[2]
LAMBDA_SRC = REPO_ROOT / "lambda-functions" / "src"
if str(LAMBDA_SRC) not in sys.path:
    sys.path.insert(0, str(LAMBDA_SRC))

APP_JS = REPO_ROOT / "frontend" / "src" / "app.js"


# ---------------------------------------------------------------------------
# Frontend URL contract: the dashboard must call /work/api/*, not /api/*
# ---------------------------------------------------------------------------

def test_frontend_builds_work_api_urls_not_bare_api():
    source = APP_JS.read_text(encoding="utf-8")
    # workApiUrl must construct /work/api/* paths
    assert "apiUrl(`/work${path}`)" in source, "workApiUrl must prefix /work"
    # The snapshot refresh must call /api/tasks and /api/bundles through workApiUrl
    assert 'workApiUrl("/api/tasks"' in source, "dashboard must load tasks via /work/api/tasks"
    assert 'workApiUrl("/api/bundles"' in source, "dashboard must load bundles via /work/api/bundles"
    # The task panel must call /api/tasks/:id via workApiUrl
    assert "workApiUrl(`/api/tasks/${encodeURIComponent(taskId)}`)" in source, (
        "task panel must fetch task detail via /work/api/tasks/:id"
    )
    assert 'workApiUrl("/api/recurring")' in source, (
        "dashboard must load recurring configs via /work/api/recurring"
    )


def test_frontend_task_and_workflow_mutations_use_work_api():
    source = APP_JS.read_text(encoding="utf-8")

    assert 'request(workApiUrl("/api/tasks"), {' in source, (
        "quick task creation must POST through /work/api/tasks"
    )
    assert 'request(workApiUrl("/api/bundles"), {' in source, (
        "quick workflow creation must POST through /work/api/bundles"
    )
    assert "request(workApiUrl(`/api/tasks/${encodeURIComponent(taskId)}`), {" in source, (
        "task action helpers must update tasks through /work/api/tasks/:id"
    )
    assert "request(workApiUrl(`/api/bundles/${encodeURIComponent(bundleId)}`), {" in source, (
        "bundle stage/link/reference updates must go through /work/api/bundles/:id"
    )
    assert 'request(workApiUrl("/api/recurring"), {' in source, (
        "recurring config creation must POST through /work/api/recurring"
    )
    assert 'request(workApiUrl("/api/recurring/generate"), {' in source, (
        "recurring generation must POST through /work/api/recurring/generate"
    )
    assert "request(workApiUrl(`/api/recurring/${encodeURIComponent(configId)}`), {" in source, (
        "recurring toggles must update through /work/api/recurring/:id"
    )


def test_frontend_request_helper_rejects_non_json_responses():
    """The request helper must throw on non-JSON so login HTML cannot render
    as an empty dashboard. Commit d981f47 tightened this; this test locks it."""
    source = APP_JS.read_text(encoding="utf-8")
    # The helper must reject non-JSON responses explicitly.
    assert "Unexpected non-JSON API response" in source, (
        "request helper must reject non-JSON responses"
    )


# ---------------------------------------------------------------------------
# Local dev proxy: local_server proxies /work/api/* to work-engine dev URL
# ---------------------------------------------------------------------------

def test_local_server_proxies_work_api_to_dev_url(monkeypatch):
    """When WORK_ENGINE_DEV_URL is set, /work/api/* requests are proxied
    to the work-engine dev server instead of falling through to index.html."""
    import urllib.request
    import urllib.error

    from lambda_functions import local_server

    captured: dict = {}

    class FakeResponse:
        def __init__(self, status, body, content_type):
            self.status = status
            self._body = body
            self.headers = {"content-type": content_type}

        def read(self):
            return self._body

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["method"] = req.method
        captured["data"] = req.data
        return FakeResponse(200, b'{"tasks":[]}', "application/json")

    monkeypatch.setenv("WORK_ENGINE_DEV_URL", "http://127.0.0.1:3000")
    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

    handler = local_server.LocalLambdaHandler.__new__(local_server.LocalLambdaHandler)
    handler.path = "/work/api/tasks?date=2026-06-27"
    handler.headers = {"content-type": "application/json"}

    wrote: dict = {}

    def fake_respond_raw(status, content_type, body):
        wrote["status"] = status
        wrote["content_type"] = content_type
        wrote["body"] = body

    handler.respond_raw = fake_respond_raw

    # read_body is called for POST etc; stub it to avoid reading stdin
    handler.read_body = lambda *a: "{}"

    result = handler._maybe_proxy_work_api(method="GET")
    assert result is True
    assert captured["url"] == "http://127.0.0.1:3000/api/tasks?date=2026-06-27"
    assert captured["method"] == "GET"
    assert wrote["status"] == 200
    assert json.loads(wrote["body"]) == {"tasks": []}


def test_local_server_proxies_work_health():
    """/work/health should map to /api/health on the dev server."""
    import urllib.request

    from lambda_functions import local_server

    captured: dict = {}

    class FakeResponse:
        status = 200
        headers = {"content-type": "application/json"}

        def read(self):
            return b'{"status":"ok"}'

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        return FakeResponse()

    os.environ["WORK_ENGINE_DEV_URL"] = "http://127.0.0.1:3000"
    with patch.object(urllib.request, "urlopen", fake_urlopen):
        handler = local_server.LocalLambdaHandler.__new__(local_server.LocalLambdaHandler)
        handler.path = "/work/health"
        handler.headers = {}

        wrote: dict = {}
        handler.respond_raw = lambda status, ct, body: wrote.update(status=status, body=body)
        handler.read_body = lambda *a: "{}"

        result = handler._maybe_proxy_work_api(method="GET")
        assert result is True
        assert captured["url"] == "http://127.0.0.1:3000/api/health"

    os.environ.pop("WORK_ENGINE_DEV_URL", None)


def test_local_server_skips_proxy_without_dev_url(monkeypatch):
    """Without WORK_ENGINE_DEV_URL, the proxy is not active (returns False)
    so the request falls through to the normal handler."""
    from lambda_functions import local_server

    monkeypatch.delenv("WORK_ENGINE_DEV_URL", raising=False)
    handler = local_server.LocalLambdaHandler.__new__(local_server.LocalLambdaHandler)
    handler.path = "/work/api/tasks"
    handler.headers = {}

    result = handler._maybe_proxy_work_api(method="GET")
    assert result is False


def test_local_server_reports_unreachable_dev_server(monkeypatch):
    import urllib.request
    import urllib.error

    from lambda_functions import local_server

    def fake_urlopen(req, timeout=None):
        raise urllib.error.URLError("Connection refused")

    monkeypatch.setenv("WORK_ENGINE_DEV_URL", "http://127.0.0.1:3000")
    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

    handler = local_server.LocalLambdaHandler.__new__(local_server.LocalLambdaHandler)
    handler.path = "/work/api/health"
    handler.headers = {}

    wrote: dict = {}

    def fake_respond(result):
        wrote.update(result)

    handler.respond = fake_respond
    handler.read_body = lambda *a: "{}"

    result = handler._maybe_proxy_work_api(method="GET")
    assert result is True
    assert wrote["statusCode"] == 503
    assert "unreachable" in json.loads(wrote["body"])["error"].lower()
