from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
LAMBDA_SRC = REPO_ROOT / "lambda-functions" / "src"
FRONTEND_ROOT = REPO_ROOT / "frontend"
if str(LAMBDA_SRC) not in sys.path:
    sys.path.insert(0, str(LAMBDA_SRC))

from lambda_functions.docs_index import build_index  # noqa: E402


DOC_RELATIVE_PATH = "internal-admin/documentation/sops/playwright-local-doc.md"
DOC_REPO_PATH = f"content/{DOC_RELATIVE_PATH}"
IMAGE_REPO_PATH = "content/images/playwright-local-doc/diagram.svg"


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _wait_for_url(url: str, timeout: float = 10.0) -> None:
    deadline = time.time() + timeout
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status < 500:
                    return
        except Exception as exc:  # pragma: no cover - diagnostic only
            last_error = exc
        time.sleep(0.1)
    raise RuntimeError(f"Timed out waiting for {url}: {last_error}")


def _write_temp_content(content_root: Path) -> None:
    doc_path = content_root / DOC_RELATIVE_PATH
    doc_path.parent.mkdir(parents=True, exist_ok=True)
    doc_path.write_text(
        """---
title: "Playwright Local Doc"
summary: "Searchable Playwright sentinel for the merged docs app."
doc_type: sop
schema_version: 1
tags: [playwright, local]
systems: [docs-portal]
related_docs: []
---

# Playwright Local Doc

<!-- sop-section-start: summary -->
## Summary

- Purpose: Verify the merged DataOps docs portal runs from repo-local content.
- Outcome: Search, edit, save, reload, and asset serving work locally.
<!-- sop-section-end -->

<!-- sop-section-start: procedure -->
## Procedure

<!-- sop-step-start id=1 -->
1.  Search for the Playwright sentinel document.
<!-- sop-step-end -->

<!-- sop-step-start id=2 -->
2.  Open the local asset.

    ![Local diagram](../../../images/playwright-local-doc/diagram.svg)
<!-- sop-step-end -->

<!-- sop-section-end -->

<!-- sop-section-start: validation -->
## Validation

- The saved title reloads from the temporary content tree.
<!-- sop-section-end -->
""",
        encoding="utf-8",
    )
    image_path = content_root / "images" / "playwright-local-doc" / "diagram.svg"
    image_path.parent.mkdir(parents=True, exist_ok=True)
    image_path.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">'
        '<rect width="20" height="20" fill="#256f6c"/></svg>',
        encoding="utf-8",
    )


@contextmanager
def _lambda_server(content_root: Path, search_index: Path):
    port = _free_port()
    env = os.environ.copy()
    env["CONTENT_ROOT"] = str(content_root)
    env["SEARCH_INDEX_PATH"] = str(search_index)
    env["PYTHONPATH"] = f"{LAMBDA_SRC}{os.pathsep}{env.get('PYTHONPATH', '')}"
    proc = subprocess.Popen(
        [sys.executable, "-m", "lambda_functions.local_server", "--host", "127.0.0.1", "--port", str(port)],
        cwd=REPO_ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    base_url = f"http://127.0.0.1:{port}"
    try:
        _wait_for_url(f"{base_url}/health")
        yield base_url
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


@contextmanager
def _frontend_server(content_root: Path, api_upstream: str):
    port = _free_port()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path == "/" or self.path.startswith("/index.html"):
                self._send_file(FRONTEND_ROOT / "index.html", "text/html; charset=utf-8")
                return
            if self.path.startswith("/src/"):
                self._send_file(FRONTEND_ROOT / self.path.lstrip("/"), self._content_type(self.path))
                return
            if self.path.startswith("/content/"):
                self._send_file(content_root.parent / self.path.lstrip("/"), self._content_type(self.path))
                return
            if self.path.startswith(("/docs", "/search", "/lint", "/images", "/folders", "/parse")):
                self._proxy_to_lambda("GET")
                return
            if self.path.startswith("/git/status"):
                self._send_json({"ok": True, "files": [], "count": 0, "branch": "test", "remote": "", "github": ""})
                return
            if self.path.startswith("/work/"):
                self._send_work_payload()
                return
            url_path = urllib.parse.urlparse(self.path).path
            if "." not in Path(url_path).name or url_path.endswith(".md"):
                self._send_file(FRONTEND_ROOT / "index.html", "text/html; charset=utf-8")
                return
            self.send_error(404)

        def do_POST(self) -> None:
            if self.path.startswith(("/docs", "/parse", "/images", "/folders")):
                self._proxy_to_lambda("POST")
                return
            if self.path.startswith("/work/"):
                self._send_work_payload()
                return
            self.send_error(404)

        def do_PUT(self) -> None:
            if self.path.startswith(("/docs", "/folders")):
                self._proxy_to_lambda("PUT")
                return
            if self.path.startswith("/work/"):
                self._send_work_payload()
                return
            self.send_error(404)

        def log_message(self, fmt: str, *args) -> None:
            return

        def _proxy_to_lambda(self, method: str) -> None:
            body = None
            if method in {"POST", "PUT"}:
                length = int(self.headers.get("content-length") or "0")
                body = self.rfile.read(length) if length else None
            req = urllib.request.Request(f"{api_upstream}{self.path}", data=body, method=method)
            content_type = self.headers.get("content-type")
            if content_type:
                req.add_header("content-type", content_type)
            try:
                with urllib.request.urlopen(req, timeout=10) as response:
                    payload = response.read()
                    self.send_response(response.status)
                    self.send_header("content-type", response.headers.get("content-type", "application/json"))
                    self.end_headers()
                    self.wfile.write(payload)
            except urllib.error.HTTPError as exc:
                payload = exc.read()
                self.send_response(exc.code)
                self.send_header("content-type", exc.headers.get("content-type", "application/json"))
                self.end_headers()
                self.wfile.write(payload)

        def _send_work_payload(self) -> None:
            path = urllib.parse.urlparse(self.path).path
            if path.endswith("/api/recurring"):
                payload = {"configs": []}
            elif path.endswith("/api/bundles"):
                payload = {"bundles": []}
            elif path.endswith("/api/tasks"):
                payload = {"tasks": []}
            else:
                payload = {"ok": True}
            self._send_json(payload)

        def _send_json(self, payload: dict) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _send_file(self, path: Path, content_type: str) -> None:
            if not path.is_file():
                self.send_error(404)
                return
            body = path.read_bytes()
            self.send_response(200)
            self.send_header("content-type", content_type)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        @staticmethod
        def _content_type(path: str) -> str:
            if path.endswith(".js"):
                return "application/javascript"
            if path.endswith(".css"):
                return "text/css"
            if path.endswith(".svg"):
                return "image/svg+xml"
            return "application/octet-stream"

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_local_docs_portal_search_edit_save_and_asset_flow(tmp_path):
    playwright_api = pytest.importorskip("playwright.sync_api")
    content_root = tmp_path / "content"
    search_index = tmp_path / "search.index"
    _write_temp_content(content_root)
    build_index(content_root, search_index)

    with _lambda_server(content_root, search_index) as api_url:
        with _frontend_server(content_root, api_url) as frontend_url:
            asset_response = urllib.request.urlopen(f"{frontend_url}/{IMAGE_REPO_PATH}", timeout=5)
            assert asset_response.status == 200
            assert asset_response.headers["content-type"] == "image/svg+xml"

            with playwright_api.sync_playwright() as playwright:
                try:
                    browser = playwright.chromium.launch(headless=True)
                except playwright_api.Error as exc:
                    pytest.skip(f"Playwright browser is not available: {exc}")
                page = browser.new_page()
                try:
                    page.goto(frontend_url, wait_until="domcontentloaded")
                    page.wait_for_selector("#search-input")
                    page.fill("#search-input", "Playwright sentinel")
                    page.press("#search-input", "Enter")
                    row = page.locator(".document-row", has_text="Playwright Local Doc").first
                    row.wait_for(state="visible")
                    row.click()

                    page.locator("#rendered-view").get_by_text("Search for the Playwright sentinel document.").wait_for()
                    assert page.locator("#document-path").inner_text() == DOC_REPO_PATH

                    page.locator("#rendered-view").get_by_text("Search for the Playwright sentinel document.").click()
                    page.fill(".inline-editor", "Search for the Playwright sentinel document after local edit.")
                    page.locator(".inline-editor").press("Control+Enter")
                    page.locator("#rendered-view").get_by_text(
                        "Search for the Playwright sentinel document after local edit."
                    ).wait_for()
                    page.click("#save-button")
                    page.wait_for_function(
                        "() => document.querySelector('#save-state')?.textContent.includes('Saved')"
                    )

                    page.reload(wait_until="domcontentloaded")
                    page.locator("#rendered-view").get_by_text(
                        "Search for the Playwright sentinel document after local edit."
                    ).wait_for()
                finally:
                    browser.close()

    saved = (content_root / DOC_RELATIVE_PATH).read_text(encoding="utf-8")
    assert "Search for the Playwright sentinel document after local edit." in saved
