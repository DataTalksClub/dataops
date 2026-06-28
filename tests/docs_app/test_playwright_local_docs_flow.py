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
OPS_PROCESS_DOC_PATH = "content/tasks/templates/newsletter.md"
OPS_REFERENCE_DOC_PATH = "content/finance/reference/invoices-receipts-and-statements.md"
OPS_SCREENSHOT_DIR = REPO_ROOT / ".tmp" / "screenshots"


def _mobile_operations_home_layout(page) -> dict:
    return page.evaluate(
        """() => {
            const sidebar = document.querySelector('#sidebar');
            const title = document.querySelector('#library-title');
            const home = document.querySelector('.operations-home');
            const menuButton = document.querySelector('#mobile-menu-button');
            const viewportWidth = document.documentElement.clientWidth;
            const sidebarRect = sidebar?.getBoundingClientRect();
            const titleRect = title?.getBoundingClientRect();
            const homeRect = home?.getBoundingClientRect();
            return {
                sidebarClosed: !document.body.classList.contains('sidebar-open'),
                menuVisible: Boolean(menuButton && getComputedStyle(menuButton).display !== 'none'),
                sidebarRight: sidebarRect?.right ?? null,
                sidebarWidth: sidebarRect?.width ?? null,
                titleLeft: titleRect?.left ?? null,
                titleRight: titleRect?.right ?? null,
                titleWidth: titleRect?.width ?? null,
                homeLeft: homeRect?.left ?? null,
                homeRight: homeRect?.right ?? null,
                homeWidth: homeRect?.width ?? null,
                viewportWidth,
                bodyScrollWidth: document.body.scrollWidth,
                documentClientWidth: viewportWidth,
            };
        }"""
    )


def _assert_mobile_operations_home_settled(page) -> None:
    page.wait_for_function(
        """() => {
            const sidebar = document.querySelector('#sidebar');
            const title = document.querySelector('#library-title');
            const home = document.querySelector('.operations-home');
            const menuButton = document.querySelector('#mobile-menu-button');
            if (!sidebar || !title || !home || !menuButton) return false;
            const viewportWidth = document.documentElement.clientWidth;
            const sidebarRect = sidebar.getBoundingClientRect();
            const titleRect = title.getBoundingClientRect();
            const homeRect = home.getBoundingClientRect();
            return !document.body.classList.contains('sidebar-open')
                && getComputedStyle(menuButton).display !== 'none'
                && sidebarRect.right <= 0.5
                && titleRect.left >= 0
                && titleRect.right <= viewportWidth + 1
                && titleRect.width > 0
                && homeRect.left >= 0
                && homeRect.left < viewportWidth
                && homeRect.width > 0
                && document.body.scrollWidth <= viewportWidth + 1;
        }"""
    )
    layout = _mobile_operations_home_layout(page)
    assert layout["sidebarClosed"], layout
    assert layout["menuVisible"], layout
    assert layout["sidebarRight"] <= 0.5, layout
    assert layout["titleLeft"] >= 0, layout
    assert layout["titleRight"] <= layout["viewportWidth"] + 1, layout
    assert layout["homeLeft"] >= 0, layout
    assert layout["homeLeft"] < layout["viewportWidth"], layout
    assert layout["bodyScrollWidth"] <= layout["documentClientWidth"] + 1, layout


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

    template_path = content_root / "tasks" / "templates" / "newsletter.md"
    template_path.parent.mkdir(parents=True, exist_ok=True)
    template_path.write_text(
        """---
id: task.template.newsletter
title: "Newsletter Task Template"
summary: "Git-backed DataOps workflow template for the Newsletter operational workflow."
doc_type: task-template
schema_version: 1
tags: [Newsletter, task-template, newsletter, recurring]
systems: [work-engine, docs-portal]
related_docs: []
---

# Newsletter Task Template

## Summary

Use this process doc when preparing the weekly newsletter workflow.
""",
        encoding="utf-8",
    )

    reference_path = content_root / "finance" / "reference" / "invoices-receipts-and-statements.md"
    reference_path.parent.mkdir(parents=True, exist_ok=True)
    reference_path.write_text(
        """---
id: reference.finance.invoices
title: "Invoices, Receipts, And Statements"
summary: "Finance reference for workflow evidence and payment context."
doc_type: reference
tags: [finance, reference]
systems: [docs-portal]
related_docs: []
---

# Invoices, Receipts, And Statements

Use this reference when a workflow task needs invoice context.
""",
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
    today = time.strftime("%Y-%m-%d")
    overdue = "2000-01-01"
    operator_id = "ops-smoke-operator"
    bundle_id = "bundle-ops-smoke"
    task_today = {
        "id": "task-ops-today",
        "description": "Publish newsletter issue",
        "status": "todo",
        "date": today,
        "assigneeId": operator_id,
        "instructionDocId": "task.template.newsletter",
        "phase": "send",
        "validation": {"requiredEvidence": "Published newsletter URL"},
    }
    task_overdue = {
        "id": "task-ops-overdue",
        "description": "Add Luma event page",
        "status": "todo",
        "date": overdue,
        "assigneeId": operator_id,
        "bundleId": bundle_id,
        "requiredLinkName": "Luma",
        "instructionDocId": "task.template.newsletter",
        "phase": "promotion",
    }
    task_waiting = {
        "id": "task-ops-waiting",
        "description": "Follow up with sponsor",
        "status": "waiting",
        "date": today,
        "assigneeId": operator_id,
        "bundleId": bundle_id,
        "waitingFor": "sponsor confirmation",
        "followUpAt": today,
        "instructionDocId": "reference.finance.invoices",
    }
    task_artifact = {
        "id": "task-ops-artifact",
        "description": "Approve newsletter draft artifact",
        "status": "todo",
        "date": today,
        "assigneeId": operator_id,
        "bundleId": bundle_id,
        "proofRequirement": {"type": "artifact", "label": "Approved newsletter draft"},
        "instructionDocId": "task.template.newsletter",
    }
    bundle = {
        "id": bundle_id,
        "title": "Newsletter smoke workflow",
        "status": "active",
        "stage": "preparation",
        "anchorDate": today,
        "description": "Daily operations smoke workflow context.",
        "bundleLinks": [{"name": "Luma", "url": ""}],
        "references": [{"name": "Newsletter process", "url": f"/{OPS_PROCESS_DOC_PATH}"}],
    }
    artifact = {
        "id": "artifact-ops-smoke",
        "type": "assistant-output",
        "title": "Newsletter draft output",
        "status": "needs-review",
        "storageUri": "https://example.com/newsletter-draft",
        "storageProvider": "external-url",
        "taskId": task_artifact["id"],
        "bundleId": bundle_id,
    }
    work_tasks = {task["id"]: task for task in [task_today, task_overdue, task_waiting, task_artifact]}

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
            parsed = urllib.parse.urlparse(self.path)
            path = parsed.path
            query = urllib.parse.parse_qs(parsed.query)
            if path.endswith("/api/me"):
                payload = {"user": {"id": operator_id, "email": "grace@datatalks.club", "name": "Grace"}}
            elif path.endswith("/api/recurring"):
                payload = {
                    "configs": [
                        {
                            "id": "rec-newsletter-smoke",
                            "description": "Weekly newsletter",
                            "cronExpression": "0 9 * * 3",
                            "enabled": True,
                        }
                    ]
                }
            elif path.endswith(f"/api/tasks/{task_artifact['id']}"):
                payload = task_artifact
            elif path.endswith(f"/api/tasks/{task_overdue['id']}"):
                payload = task_overdue
            elif path.endswith(f"/api/tasks/{task_waiting['id']}"):
                payload = task_waiting
            elif path.endswith(f"/api/tasks/{task_today['id']}"):
                payload = task_today
            elif path.endswith("/api/tasks"):
                if query.get("bundleId", [""])[0] == bundle_id:
                    payload = {"tasks": [task_overdue, task_waiting, task_artifact]}
                elif query.get("status", [""])[0] == "waiting":
                    payload = {"tasks": [task_waiting]}
                elif query.get("startDate"):
                    payload = {"tasks": [task_overdue]}
                elif query.get("date", [""])[0] == today:
                    payload = {"tasks": [task_today, task_artifact]}
                else:
                    payload = {"tasks": list(work_tasks.values())}
            elif path.endswith(f"/api/bundles/{bundle_id}"):
                payload = {"bundle": bundle}
            elif path.endswith("/api/bundles"):
                payload = {"bundles": [bundle]}
            elif path.endswith("/api/artifacts"):
                if query.get("taskId", [""])[0] == task_artifact["id"] or query.get("bundleId", [""])[0] == bundle_id:
                    payload = {"artifacts": [artifact]}
                else:
                    payload = {"artifacts": []}
            elif path.endswith("/api/files"):
                payload = {"files": []}
            elif path.endswith("/api/health"):
                payload = {"status": "ok"}
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


def test_operations_smoke_portal_shell_workflow_panels_and_docs_context(tmp_path):
    playwright_api = pytest.importorskip("playwright.sync_api")
    content_root = tmp_path / "content"
    search_index = tmp_path / "search.index"
    _write_temp_content(content_root)
    build_index(content_root, search_index)
    OPS_SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)

    with _lambda_server(content_root, search_index) as api_url:
        with _frontend_server(content_root, api_url) as frontend_url:
            with playwright_api.sync_playwright() as playwright:
                try:
                    browser = playwright.chromium.launch(headless=True)
                except playwright_api.Error as exc:
                    pytest.skip(f"Playwright browser is not available: {exc}")

                page = browser.new_page(viewport={"width": 1280, "height": 800})
                try:
                    page.goto(frontend_url, wait_until="domcontentloaded")
                    page.locator("#library-title").wait_for(state="visible")
                    assert page.locator("#library-title").inner_text() == "Operations Home"
                    page.locator(".operations-home").wait_for(state="visible")

                    for label in ["Today", "Overdue", "Waiting / Follow-Ups", "Active Workflows"]:
                        assert page.locator(".ops-lanes").get_by_text(label).first.is_visible()
                    for label in ["+ Task", "+ Workflow", "+ Recurring", "Recurring Operations", "Workflow Templates"]:
                        assert page.get_by_text(label).first.is_visible()
                    assert page.get_by_text("Incoming And Quality Signals").is_visible()
                    assert page.get_by_text("Assistant Jobs").is_visible()
                    assert page.get_by_text("Not connected yet").first.is_visible()
                    assert page.locator(".ops-summary").get_by_text("Overdue").is_visible()
                    assert page.locator(".ops-lane-overdue .ops-next-action", has_text="Add Luma").is_visible()
                    page.screenshot(path=str(OPS_SCREENSHOT_DIR / "docs-operations-home-desktop.png"), full_page=True)

                    page.locator(".ops-lane-overdue .ops-lane-item", has_text="Add Luma event page").click()
                    page.locator("#task-panel-title").wait_for(state="visible")
                    assert page.locator("#task-panel-title").inner_text() == "Add Luma event page"
                    assert page.locator("#task-panel-body").get_by_text("Luma").is_visible()
                    mark_done = page.locator("#task-panel-body .task-action-btn", has_text="Mark done").first
                    assert mark_done.is_disabled()
                    assert "Fill in Luma" in (mark_done.get_attribute("title") or "")
                    assert page.locator("#task-panel-body").get_by_text("Process doc").is_visible()
                    assert page.locator("#task-panel-body .task-instruction-doc-link").inner_text() == "Newsletter Task Template"
                    page.screenshot(path=str(OPS_SCREENSHOT_DIR / "docs-task-panel-missing-proof.png"), full_page=True)
                    page.locator("#task-panel-close").click()
                    assert page.locator("#task-panel").is_hidden()
                    assert page.locator("#library-title").inner_text() == "Operations Home"

                    page.locator(".ops-lane-bundles .ops-lane-item", has_text="Newsletter smoke workflow").click()
                    page.locator("#bundle-panel-title").wait_for(state="visible")
                    assert page.locator("#bundle-panel-title").inner_text() == "Newsletter smoke workflow"
                    assert page.locator("#bundle-panel-body").get_by_text("Links & Artifacts").is_visible()
                    assert page.locator("#bundle-panel-body").get_by_text("Newsletter draft output").is_visible()
                    assert page.locator("#bundle-panel-body").get_by_text("artifact review missing").is_visible()
                    page.screenshot(path=str(OPS_SCREENSHOT_DIR / "docs-workflow-panel-context.png"), full_page=True)
                    page.locator("#bundle-panel-close").click()
                    assert page.locator("#bundle-panel").is_hidden()
                    assert page.locator("#library-title").inner_text() == "Operations Home"

                    page.locator(".ops-lane-today .ops-lane-item", has_text="Approve newsletter draft artifact").click()
                    page.locator("#task-panel-title").wait_for(state="visible")
                    assert page.locator("#task-panel-body").get_by_text("Artifact proof").is_visible()
                    assert page.locator("#task-panel-body").get_by_text("Newsletter draft output").is_visible()
                    assert page.locator("#task-panel-body").get_by_text("needs-review").is_visible()
                    artifact_done = page.locator("#task-panel-body .task-action-btn", has_text="Mark done").first
                    assert artifact_done.is_disabled()
                    assert "Approve an attached artifact" in (artifact_done.get_attribute("title") or "")
                    page.locator("#task-panel-body .task-instruction-doc-link").click()
                    page.locator("#rendered-view").get_by_text("Use this process doc when preparing").wait_for()
                    assert page.locator("#document-path").inner_text() == OPS_PROCESS_DOC_PATH
                    assert page.locator("#sidebar").is_visible()

                    page.locator("#operations-home-button").click()
                    page.locator("#library-title").wait_for(state="visible")
                    assert page.locator("#library-title").inner_text() == "Operations Home"

                    page.set_viewport_size({"width": 390, "height": 844})
                    page.locator("#mobile-menu-button").wait_for(state="visible")
                    _assert_mobile_operations_home_settled(page)
                    page.screenshot(path=str(OPS_SCREENSHOT_DIR / "docs-operations-home-mobile.png"), full_page=True)
                    page.locator("#mobile-menu-button").click()
                    assert page.locator("body").evaluate("el => el.classList.contains('sidebar-open')")
                    page.keyboard.press("Escape")
                    assert not page.locator("body").evaluate("el => el.classList.contains('sidebar-open')")
                    _assert_mobile_operations_home_settled(page)

                    page.locator(".ops-lane-today .ops-lane-item", has_text="Approve newsletter draft artifact").click()
                    page.locator("#task-panel-title").wait_for(state="visible")
                    assert page.locator("#task-panel-title").inner_text() == "Approve newsletter draft artifact"
                    assert page.evaluate("document.body.scrollWidth <= document.documentElement.clientWidth + 1")
                finally:
                    browser.close()


def test_operations_smoke_runtime_failure_state_is_honest(tmp_path):
    playwright_api = pytest.importorskip("playwright.sync_api")
    content_root = tmp_path / "content"
    search_index = tmp_path / "search.index"
    _write_temp_content(content_root)
    build_index(content_root, search_index)

    @contextmanager
    def failing_work_frontend(content_root: Path, api_upstream: str):
        with _frontend_server(content_root, api_upstream) as frontend_url:
            yield frontend_url

    with _lambda_server(content_root, search_index) as api_url:
        with failing_work_frontend(content_root, api_url) as frontend_url:
            with playwright_api.sync_playwright() as playwright:
                try:
                    browser = playwright.chromium.launch(headless=True)
                except playwright_api.Error as exc:
                    pytest.skip(f"Playwright browser is not available: {exc}")
                page = browser.new_page()
                try:
                    page.route("**/work/api/tasks**", lambda route: route.fulfill(status=503, json={"error": "work down"}))
                    page.route("**/work/api/bundles**", lambda route: route.fulfill(status=503, json={"error": "work down"}))
                    page.goto(frontend_url, wait_until="domcontentloaded")
                    page.locator("#library-title").wait_for(state="visible")
                    page.get_by_text("Live work data unavailable", exact=True).wait_for()
                    assert page.get_by_role("heading", name="Workflow Templates").is_visible()
                    assert page.locator(".ops-lane-today .ops-empty").get_by_text(
                        "Live work data unavailable; tasks will appear here"
                    ).is_visible()
                finally:
                    browser.close()
