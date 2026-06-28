from __future__ import annotations

import base64
import io
import json
import sys
import types
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
LAMBDA_SRC = REPO_ROOT / "lambda-functions" / "src"
if str(LAMBDA_SRC) not in sys.path:
    sys.path.insert(0, str(LAMBDA_SRC))

from lambda_functions import api_handler, docs_index, full_app_handler, github_store, search_handler  # noqa: E402


def _event(path: str, method: str = "GET", **extra):
    event = {"rawPath": path, "requestContext": {"http": {"method": method}}}
    event.update(extra)
    return event


def _json_body(response: dict) -> dict:
    return json.loads(response["body"])


def test_full_app_login_uses_secrets_manager_password_and_sets_session_cookie(monkeypatch):
    calls: list[str] = []

    class FakeSecretsManager:
        def get_secret_value(self, SecretId: str) -> dict[str, str]:
            calls.append(SecretId)
            return {"SecretString": "from-secret"}

    fake_boto3 = types.SimpleNamespace(client=lambda service: FakeSecretsManager())
    monkeypatch.setitem(sys.modules, "boto3", fake_boto3)
    monkeypatch.delenv("BASIC_AUTH_PASSWORD", raising=False)
    monkeypatch.setenv("BASIC_AUTH_PASSWORD_SECRET_NAME", "docs/basic-auth")
    monkeypatch.setenv("BASIC_AUTH_USERNAME", "docs-user")
    monkeypatch.setattr(github_store, "_SECRET_CACHE", {})

    response = full_app_handler.handler(
        _event(
            "/login",
            "POST",
            headers={"content-type": "application/json"},
            body=json.dumps({"username": "docs-user", "password": "from-secret", "remember": True}),
        ),
        None,
    )

    assert response["statusCode"] == 302
    assert response["headers"]["location"] == "/"
    cookie = response["headers"]["set-cookie"]
    assert cookie.startswith(f"dtc_auth={full_app_handler.session_token()}; Path=/")
    assert "Max-Age=15552000" in cookie
    assert calls == ["docs/basic-auth"]

    assert full_app_handler.basic_auth_password() == "from-secret"
    assert calls == ["docs/basic-auth"]


def test_full_app_accepts_basic_auth_and_serves_gzipped_index(tmp_path, monkeypatch):
    frontend_root = tmp_path / "frontend"
    frontend_root.mkdir()
    html = "<!doctype html><html><body>" + ("Docs app " * 80) + "</body></html>"
    (frontend_root / "index.html").write_text(html, encoding="utf-8")

    monkeypatch.setattr(full_app_handler, "FRONTEND_ROOT", frontend_root)
    monkeypatch.setattr(full_app_handler, "compute_version", lambda: "test-version")
    monkeypatch.setenv("BASIC_AUTH_USERNAME", "admin")
    monkeypatch.setenv("BASIC_AUTH_PASSWORD", "secret")
    monkeypatch.delenv("BASIC_AUTH_PASSWORD_SECRET_NAME", raising=False)

    credentials = base64.b64encode(b"admin:secret").decode("ascii")
    response = full_app_handler.handler(
        _event("/", headers={"authorization": f"Basic {credentials}", "accept-encoding": "gzip"}),
        None,
    )

    assert response["statusCode"] == 200
    assert response["isBase64Encoded"] is True
    assert response["headers"]["content-encoding"] == "gzip"
    assert response["headers"]["content-type"].startswith("text/html")


def test_full_app_commits_successful_doc_mutations_and_rebuilds_search(tmp_path, monkeypatch):
    content_root = tmp_path / "content"
    monkeypatch.setattr(api_handler, "CONTENT_ROOT", content_root)

    calls: list[tuple[str, str]] = []

    class FakeStore:
        def sync_markdown(self) -> None:
            content_root.mkdir(parents=True, exist_ok=True)

        def put_local_file(self, repo_path: str, message: str) -> None:
            calls.append((repo_path, message))

    FakeStore.content_root = content_root

    monkeypatch.setattr(full_app_handler, "STORE", FakeStore())
    monkeypatch.setattr(full_app_handler, "require_auth", lambda event: None)
    monkeypatch.setattr(full_app_handler, "rebuild_search", lambda: calls.append(("search", "rebuilt")))

    response = full_app_handler.handler(
        _event(
            "/docs",
            "POST",
            body=json.dumps(
                {
                    "path": "finance/reference/new-invoice.md",
                    "title": "New Invoice",
                    "doc_type": "reference",
                    "summary": "Invoice reference",
                    "scaffold": "minimal",
                }
            ),
        ),
        None,
    )

    assert response["statusCode"] == 201
    assert _json_body(response)["path"] == "content/finance/reference/new-invoice.md"
    assert calls == [
        ("content/finance/reference/new-invoice.md", "Update content/finance/reference/new-invoice.md"),
        ("search", "rebuilt"),
    ]


def test_full_app_commits_image_upload_with_repo_path_and_rebuilds_search(tmp_path, monkeypatch):
    cache_root = tmp_path / "cache"
    content_root = cache_root / "content"
    doc_path = content_root / "finance" / "sops" / "pay-invoice.md"
    doc_path.parent.mkdir(parents=True, exist_ok=True)
    doc_path.write_text("# Pay Invoice\n", encoding="utf-8")

    calls: list[tuple[str, str]] = []

    class FakeStore:
        def sync_markdown(self) -> None:
            content_root.mkdir(parents=True, exist_ok=True)

        def put_local_file(self, repo_path: str, message: str) -> None:
            calls.append((repo_path, message))

    FakeStore.content_root = content_root

    monkeypatch.setattr(api_handler, "CONTENT_ROOT", content_root)
    monkeypatch.setattr(full_app_handler, "CACHE_ROOT", cache_root)
    monkeypatch.setattr(full_app_handler, "STORE", FakeStore())
    monkeypatch.setattr(full_app_handler, "require_auth", lambda event: None)
    monkeypatch.setattr(full_app_handler, "rebuild_search", lambda: calls.append(("search", "rebuilt")))

    response = full_app_handler.handler(
        _event(
            "/images",
            "POST",
            body=json.dumps(
                {
                    "doc_path": "content/finance/sops/pay-invoice.md",
                    "filename": "../Receipt.PNG",
                    "data": base64.b64encode(b"image-bytes").decode("ascii"),
                }
            ),
        ),
        None,
    )

    assert response["statusCode"] == 201
    payload = _json_body(response)
    assert payload["absolute_path"] == "content/images/pay-invoice/receipt.png"
    assert payload["path"] == "../../images/pay-invoice/receipt.png"
    assert calls == [
        ("content/images/pay-invoice/receipt.png", "Upload content/images/pay-invoice/receipt.png"),
        ("search", "rebuilt"),
    ]


def test_full_app_commits_folder_rename_and_delete_with_fake_store(tmp_path, monkeypatch):
    cache_root = tmp_path / "cache"
    content_root = cache_root / "content"
    old_folder = content_root / "finance" / "reference"
    old_folder.mkdir(parents=True, exist_ok=True)
    (old_folder / "invoices.md").write_text("# Invoices\n", encoding="utf-8")
    (old_folder / "receipts.md").write_text("# Receipts\n", encoding="utf-8")

    calls: list[tuple[str, str]] = []

    class FakeStore:
        def __init__(self) -> None:
            self.files = {
                "content/finance/reference/invoices.md": {"type": "blob"},
                "content/finance/reference/receipts.md": {"type": "blob"},
            }

        def sync_markdown(self) -> None:
            content_root.mkdir(parents=True, exist_ok=True)

        def tree(self) -> dict[str, dict[str, str]]:
            return dict(self.files)

        def put_local_file(self, repo_path: str, message: str) -> None:
            calls.append((repo_path, message))

        def delete_repo_file(self, repo_path: str, message: str) -> None:
            calls.append((repo_path, message))
            self.files.pop(repo_path, None)

    store = FakeStore()
    monkeypatch.setattr(api_handler, "CONTENT_ROOT", content_root)
    monkeypatch.setattr(full_app_handler, "CACHE_ROOT", cache_root)
    monkeypatch.setattr(full_app_handler, "STORE", store)
    monkeypatch.setattr(full_app_handler, "require_auth", lambda event: None)
    monkeypatch.setattr(full_app_handler, "rebuild_search", lambda: calls.append(("search", "rebuilt")))

    rename_response = full_app_handler.handler(
        _event(
            "/folders/rename",
            "POST",
            body=json.dumps(
                {
                    "old_path": "content/finance/reference",
                    "new_path": "content/finance/guides",
                }
            ),
        ),
        None,
    )

    assert rename_response["statusCode"] == 200
    assert calls == [
        (
            "content/finance/guides/invoices.md",
            "Rename folder content/finance/reference to content/finance/guides",
        ),
        (
            "content/finance/guides/receipts.md",
            "Rename folder content/finance/reference to content/finance/guides",
        ),
        (
            "content/finance/reference/invoices.md",
            "Remove renamed content/finance/reference/invoices.md",
        ),
        (
            "content/finance/reference/receipts.md",
            "Remove renamed content/finance/reference/receipts.md",
        ),
        ("search", "rebuilt"),
    ]

    calls.clear()
    store.files = {
        "content/finance/guides/invoices.md": {"type": "blob"},
        "content/finance/guides/receipts.md": {"type": "blob"},
    }
    delete_response = full_app_handler.handler(
        _event("/folders", "DELETE", queryStringParameters={"path": "content/finance/guides"}),
        None,
    )

    assert delete_response["statusCode"] == 200
    assert calls == [
        ("content/finance/guides/invoices.md", "Delete content/finance/guides/invoices.md"),
        ("content/finance/guides/receipts.md", "Delete content/finance/guides/receipts.md"),
        ("search", "rebuilt"),
    ]


def test_full_app_internal_refresh_bypasses_http_auth_and_rebuilds_search(tmp_path, monkeypatch):
    content_root = tmp_path / "content"
    calls: list[str] = []

    class FakeStore:
        branch = "main"

        def reset(self) -> None:
            calls.append("reset")

        def sync_markdown(self) -> None:
            calls.append("sync")

    FakeStore.content_root = content_root

    monkeypatch.setattr(full_app_handler, "STORE", FakeStore())
    monkeypatch.setattr(full_app_handler.search_handler, "reset_index", lambda: calls.append("reset-index"))
    monkeypatch.setattr(full_app_handler, "rebuild_search", lambda: calls.append("rebuild"))
    monkeypatch.setattr(full_app_handler, "_search_ready", True)

    response = full_app_handler.handler(
        _event(
            "/admin/refresh",
            "POST",
            source="dataops.github-actions",
        ),
        None,
    )

    assert response["statusCode"] == 200
    assert _json_body(response) == {"ok": True, "refreshed": True, "branch": "main"}
    assert calls == ["reset", "reset-index", "sync", "rebuild"]


def test_full_app_brokers_work_api_to_private_work_engine(monkeypatch):
    captured: dict = {}

    class FakeLambda:
        def invoke(self, **kwargs):
            captured.update(kwargs)
            return {
                "Payload": io.BytesIO(
                    json.dumps(
                        {
                            "statusCode": 201,
                            "headers": {"Content-Type": "application/json"},
                            "body": json.dumps({"id": "task-1"}),
                        }
                    ).encode("utf-8")
                )
            }

    monkeypatch.setenv("WORK_ENGINE_FUNCTION_NAME", "dataops-v1-work-engine")
    monkeypatch.setenv("WORK_ENGINE_PORTAL_SECRET", "broker-secret")
    monkeypatch.setenv("WORK_ENGINE_PORTAL_USER_ID", "ops-manager")
    monkeypatch.setattr(full_app_handler, "_work_engine_client", FakeLambda())
    monkeypatch.setattr(full_app_handler, "require_auth", lambda event: None)

    response = full_app_handler.handler(
        _event(
            "/work/api/tasks",
            "POST",
            headers={
                "content-type": "application/json",
                "accept": "application/json",
                "authorization": "Basic should-not-forward",
                "cookie": "dtc_auth=should-not-forward; unrelated=value",
                "x-random-browser-header": "should-not-forward",
            },
            queryStringParameters={"date": "2028-10-03"},
            body=json.dumps({"description": "Brokered task"}),
        ),
        None,
    )

    assert response["statusCode"] == 201
    assert response["headers"] == {"Content-Type": "application/json"}
    assert _json_body(response) == {"id": "task-1"}
    assert captured["FunctionName"] == "dataops-v1-work-engine"
    assert captured["InvocationType"] == "RequestResponse"

    invoke_event = json.loads(captured["Payload"].decode("utf-8"))
    assert invoke_event == {
        "httpMethod": "POST",
        "path": "/api/tasks",
        "headers": {
            "x-portal-auth": "true",
            "x-portal-secret": "broker-secret",
            "x-user-id": "ops-manager",
            "content-type": "application/json",
            "accept": "application/json",
        },
        "body": json.dumps({"description": "Brokered task"}),
        "isBase64Encoded": False,
        "queryStringParameters": {"date": "2028-10-03"},
    }


def test_full_app_brokers_nested_work_api_mutation_to_private_work_engine(monkeypatch):
    captured: dict = {}

    class FakeLambda:
        def invoke(self, **kwargs):
            captured.update(kwargs)
            return {
                "Payload": io.BytesIO(
                    json.dumps(
                        {
                            "statusCode": 200,
                            "headers": {"Content-Type": "application/json"},
                            "body": json.dumps({"id": "task-1", "status": "waiting"}),
                        }
                    ).encode("utf-8")
                )
            }

    monkeypatch.setenv("WORK_ENGINE_FUNCTION_NAME", "dataops-v1-work-engine")
    monkeypatch.setenv("WORK_ENGINE_PORTAL_SECRET", "broker-secret")
    monkeypatch.setenv("WORK_ENGINE_PORTAL_USER_ID", "ops-manager")
    monkeypatch.setattr(full_app_handler, "_work_engine_client", FakeLambda())
    monkeypatch.setattr(full_app_handler, "require_auth", lambda event: None)

    body = {
        "status": "waiting",
        "waitingFor": "guest bio",
        "followUpAt": "2028-10-06",
    }
    response = full_app_handler.handler(
        _event(
            "/work/api/tasks/task-1",
            "PUT",
            headers={
                "content-type": "application/json",
                "accept": "application/json",
                "authorization": "Basic should-not-forward",
            },
            body=json.dumps(body),
        ),
        None,
    )

    assert response["statusCode"] == 200
    assert _json_body(response) == {"id": "task-1", "status": "waiting"}

    invoke_event = json.loads(captured["Payload"].decode("utf-8"))
    assert invoke_event == {
        "httpMethod": "PUT",
        "path": "/api/tasks/task-1",
        "headers": {
            "x-portal-auth": "true",
            "x-portal-secret": "broker-secret",
            "x-user-id": "ops-manager",
            "content-type": "application/json",
            "accept": "application/json",
        },
        "body": json.dumps(body),
        "isBase64Encoded": False,
        "queryStringParameters": None,
    }


def test_full_app_work_api_requires_portal_auth_before_broker(monkeypatch):
    monkeypatch.setenv("WORK_ENGINE_FUNCTION_NAME", "dataops-v1-work-engine")
    monkeypatch.setenv("WORK_ENGINE_PORTAL_SECRET", "broker-secret")
    monkeypatch.setattr(full_app_handler, "_work_engine_client", object())
    monkeypatch.setattr(full_app_handler, "require_auth", lambda event: full_app_handler.redirect_to_login())

    response = full_app_handler.handler(_event("/work/api/tasks", "GET"), None)

    assert response["statusCode"] == 302
    assert response["headers"]["location"] == "/login"


def test_full_app_work_shell_routes_require_portal_auth(monkeypatch):
    monkeypatch.setattr(full_app_handler, "require_auth", lambda event: full_app_handler.redirect_to_login())

    for path in ["/work", "/work/tasks"]:
        response = full_app_handler.handler(_event(path, "GET"), None)

        assert response["statusCode"] == 302
        assert response["headers"]["location"] == "/login"


def test_full_app_work_routes_do_not_fall_through_to_docs_api(monkeypatch):
    monkeypatch.delenv("WORK_ENGINE_FUNCTION_NAME", raising=False)
    monkeypatch.setattr(full_app_handler, "require_auth", lambda event: None)
    monkeypatch.setattr(
        api_handler,
        "handler",
        lambda event, context: (_ for _ in ()).throw(AssertionError("docs API should not handle work routes")),
    )
    monkeypatch.setattr(
        full_app_handler,
        "serve_index",
        lambda event: full_app_handler.json_response(200, {"shell": "work"}),
    )

    api_response = full_app_handler.handler(_event("/work/api/docs", "GET"), None)
    shell_response = full_app_handler.handler(_event("/work/tasks", "GET"), None)

    assert api_response["statusCode"] == 503
    assert _json_body(api_response) == {"error": "Work engine is not configured"}
    assert shell_response["statusCode"] == 200
    assert _json_body(shell_response) == {"shell": "work"}


def test_full_app_reports_unconfigured_work_engine(monkeypatch):
    monkeypatch.delenv("WORK_ENGINE_FUNCTION_NAME", raising=False)
    monkeypatch.setattr(full_app_handler, "require_auth", lambda event: None)

    response = full_app_handler.handler(_event("/work/api/health", "GET"), None)

    assert response["statusCode"] == 503
    assert _json_body(response) == {"error": "Work engine is not configured"}


def test_full_app_reports_unconfigured_work_engine_portal_secret(monkeypatch):
    monkeypatch.setenv("WORK_ENGINE_FUNCTION_NAME", "dataops-v1-work-engine")
    monkeypatch.delenv("WORK_ENGINE_PORTAL_SECRET", raising=False)
    monkeypatch.delenv("WORK_ENGINE_PORTAL_SECRET_NAME", raising=False)
    monkeypatch.setattr(full_app_handler, "require_auth", lambda event: None)

    response = full_app_handler.handler(_event("/work/api/health", "GET"), None)

    assert response["statusCode"] == 503
    assert _json_body(response) == {"error": "Work engine portal secret is not configured"}


def test_full_app_reports_work_engine_lambda_errors(monkeypatch):
    class FakeLambda:
        def invoke(self, **kwargs):
            return {
                "FunctionError": "Unhandled",
                "Payload": io.BytesIO(json.dumps({"errorMessage": "boom"}).encode("utf-8")),
            }

    monkeypatch.setenv("WORK_ENGINE_FUNCTION_NAME", "dataops-v1-work-engine")
    monkeypatch.setenv("WORK_ENGINE_PORTAL_SECRET", "broker-secret")
    monkeypatch.setattr(full_app_handler, "_work_engine_client", FakeLambda())
    monkeypatch.setattr(full_app_handler, "require_auth", lambda event: None)

    response = full_app_handler.handler(_event("/work/health", "GET"), None)

    assert response["statusCode"] == 502
    assert _json_body(response) == {"error": "Work engine failed", "detail": {"errorMessage": "boom"}}


def test_full_app_reports_invalid_work_engine_payload_as_bad_gateway(monkeypatch):
    class FakeLambda:
        def invoke(self, **kwargs):
            return {"Payload": io.BytesIO(b"not json")}

    monkeypatch.setenv("WORK_ENGINE_FUNCTION_NAME", "dataops-v1-work-engine")
    monkeypatch.setenv("WORK_ENGINE_PORTAL_SECRET", "broker-secret")
    monkeypatch.setattr(full_app_handler, "_work_engine_client", FakeLambda())
    monkeypatch.setattr(full_app_handler, "require_auth", lambda event: None)

    response = full_app_handler.handler(_event("/work/api/tasks", "GET"), None)

    assert response["statusCode"] == 502
    assert _json_body(response)["error"] == "Work engine returned an invalid response"


def test_full_app_reports_bad_work_engine_status_as_bad_gateway(monkeypatch):
    class FakeLambda:
        def invoke(self, **kwargs):
            return {"Payload": io.BytesIO(json.dumps({"statusCode": "bad", "body": ""}).encode("utf-8"))}

    monkeypatch.setenv("WORK_ENGINE_FUNCTION_NAME", "dataops-v1-work-engine")
    monkeypatch.setenv("WORK_ENGINE_PORTAL_SECRET", "broker-secret")
    monkeypatch.setattr(full_app_handler, "_work_engine_client", FakeLambda())
    monkeypatch.setattr(full_app_handler, "require_auth", lambda event: None)

    response = full_app_handler.handler(_event("/work/api/tasks", "GET"), None)

    assert response["statusCode"] == 502
    assert _json_body(response) == {"error": "Work engine returned an invalid response"}


def test_full_app_public_refresh_requires_auth(monkeypatch):
    monkeypatch.setattr(full_app_handler, "require_auth", lambda event: full_app_handler.redirect_to_login())

    response = full_app_handler.handler(_event("/admin/refresh", "POST"), None)

    assert response["statusCode"] == 302
    assert response["headers"]["location"] == "/login"


def test_search_handler_parses_raw_query_applies_filters_and_caps_limit(monkeypatch):
    captured: dict = {}

    class FakeIndex:
        def search(self, query, filter_dict, boost_dict, num_results):
            captured.update(
                {
                    "query": query,
                    "filter_dict": filter_dict,
                    "boost_dict": boost_dict,
                    "num_results": num_results,
                }
            )
            return [
                {
                    "path": "content/finance/reference/invoices.md",
                    "id": "invoice-reference",
                    "title": "Invoices",
                    "domain": "finance",
                    "doc_type": "reference",
                    "summary": "Invoice summary",
                    "description": "Workflow-facing invoice description",
                    "purpose": "Find invoice steps",
                }
            ]

    monkeypatch.setattr(search_handler, "get_index", lambda: FakeIndex())

    response = search_handler.handler(
        _event(
            "/search",
            rawQueryString="q=invoice+workflow&limit=500&domain=finance&doc_type=reference",
        ),
        None,
    )

    assert response["statusCode"] == 200
    assert captured["query"] == "invoice workflow"
    assert captured["filter_dict"] == {"domain": "finance", "doc_type": "reference"}
    assert captured["num_results"] == search_handler.MAX_LIMIT
    payload = _json_body(response)
    result = payload["results"][0]
    assert result["path"] == "content/finance/reference/invoices.md"
    assert result["id"] == "invoice-reference"
    assert result["title"] == "Invoices"
    assert result["domain"] == "finance"
    assert result["doc_type"] == "reference"
    assert result["summary"] == "Invoice summary"
    assert result["description"] == "Workflow-facing invoice description"
    assert result["purpose"] == "Find invoice steps"
    assert result["type"] == "doc"
    assert result["route"]["kind"] == "doc"


def test_search_handler_reports_missing_query_and_bad_limit_without_index_lookup(monkeypatch):
    monkeypatch.setattr(search_handler, "get_index", lambda: (_ for _ in ()).throw(AssertionError("no index lookup")))

    missing = search_handler.handler(_event("/search", queryStringParameters={"q": "  "}), None)
    bad_limit = search_handler.handler(
        _event("/search", queryStringParameters={"q": "invoice", "limit": "not-a-number"}),
        None,
    )

    assert missing["statusCode"] == 400
    assert _json_body(missing) == {"error": "Missing required query parameter: q"}
    assert bad_limit["statusCode"] == 400
    assert _json_body(bad_limit) == {"error": "invalid literal for int() with base 10: 'not-a-number'"}


def test_search_handler_metadata_filters_exclude_docs_without_requested_values(monkeypatch):
    class FakeIndex:
        def search(self, query, filter_dict, boost_dict, num_results):
            assert query == "invoice"
            return [
                {
                    "path": "content/finance/bookkeeping/sops/asking-for-invoice-information.md",
                    "id": "finance.ask-invoice-info",
                    "title": "Asking for Invoice Information",
                    "domain": "finance",
                    "doc_type": "sop",
                    "summary": "Invoice intake without system metadata.",
                    "tags": "",
                    "systems": "",
                },
                {
                    "path": "content/finance/bookkeeping/sops/creating-invoices-in-finom.md",
                    "id": "finance.create-finom-invoices",
                    "title": "Creating Invoices in Finom",
                    "domain": "finance",
                    "doc_type": "sop",
                    "summary": "Create invoices in Finom.",
                    "tags": "finance, bookkeeping",
                    "systems": "finom, revolut",
                },
                {
                    "path": "content/finance/bookkeeping/templates/invoice-commission.md",
                    "id": "finance.invoice-commission-template",
                    "title": "Invoice Commission Template",
                    "domain": "finance",
                    "doc_type": "template",
                    "summary": "Template with no requested tag.",
                    "tags": "sales",
                    "systems": "finom",
                },
            ]

    monkeypatch.setattr(search_handler, "get_index", lambda: FakeIndex())

    system_response = search_handler.handler(
        _event("/search", queryStringParameters={"q": "invoice", "source": "docs", "system": "finom"}),
        None,
    )
    tag_response = search_handler.handler(
        _event("/search", queryStringParameters={"q": "invoice", "source": "docs", "tag": "bookkeeping"}),
        None,
    )

    assert system_response["statusCode"] == 200
    system_payload = _json_body(system_response)
    assert [result["path"] for result in system_payload["results"]] == [
        "content/finance/bookkeeping/sops/creating-invoices-in-finom.md",
        "content/finance/bookkeeping/templates/invoice-commission.md",
    ]
    assert {"source": "docs", "status": "ok", "count": 2} in system_payload["sources"]

    assert tag_response["statusCode"] == 200
    tag_payload = _json_body(tag_response)
    assert [result["path"] for result in tag_payload["results"]] == [
        "content/finance/bookkeeping/sops/creating-invoices-in-finom.md",
    ]
    assert {"source": "docs", "status": "ok", "count": 1} in tag_payload["sources"]


def test_search_handler_returns_typed_docs_and_work_results_with_source_states(monkeypatch):
    assignee_id = "00000000-0000-0000-0000-000000000001"
    bundle_id = "11111111-1111-1111-1111-111111111111"

    class FakeIndex:
        def search(self, query, filter_dict, boost_dict, num_results):
            assert query == "Mailchimp newsletter"
            return [
                {
                    "path": "content/tasks/templates/newsletter.md",
                    "id": "task-template.newsletter",
                    "title": "Newsletter",
                    "domain": "tasks",
                    "doc_type": "template",
                    "summary": "Mailchimp newsletter process.",
                    "description": "Prepare the weekly newsletter in Mailchimp.",
                    "tags": "newsletter",
                    "systems": "mailchimp",
                }
            ]

    def work_fetcher(path, params):
        if path == "/api/tasks" and params == {"status": "todo"}:
            return {
                "tasks": [
                    {
                        "id": "task-newsletter",
                        "description": "Prepare Mailchimp newsletter",
                        "status": "todo",
                        "date": "2026-06-29",
                        "bundleId": bundle_id,
                        "assigneeId": assignee_id,
                        "instructionDocId": "task-template.newsletter",
                        "instructionStepId": "publish",
                        "systems": ["mailchimp"],
                        "proofRequirement": {"type": "url", "required": True},
                    }
                ]
            }
        if path == "/api/tasks" and params == {"status": "waiting"}:
            return {"tasks": []}
        if path == "/api/bundles":
            return {
                "bundles": [
                    {
                        "id": bundle_id,
                        "title": "Mailchimp newsletter run",
                        "stage": "preparation",
                        "status": "active",
                        "templateId": "tmpl-newsletter",
                    }
                ]
            }
        if path == "/api/tasks" and params == {"bundleId": bundle_id}:
            return {
                "tasks": [
                    {
                        "id": "task-newsletter",
                        "description": "Prepare Mailchimp newsletter",
                        "status": "todo",
                        "date": "2026-06-29",
                        "instructionDocId": "task-template.newsletter",
                        "proofRequirement": {"type": "url", "required": True},
                    }
                ]
            }
        if path == "/api/users":
            return {"users": [{"id": assignee_id, "name": "Grace", "email": "grace@datatalks.club"}]}
        if path == "/api/templates":
            return {"templates": [{"id": "tmpl-newsletter", "name": "Mailchimp Newsletter", "type": "newsletter", "sourceDocIds": ["task-template.newsletter"]}]}
        if path == "/api/artifacts":
            return {
                "artifacts": [
                    {
                        "id": "artifact-newsletter-proof",
                        "title": "Mailchimp newsletter proof",
                        "type": "external-link",
                        "status": "needs-review",
                        "taskId": "task-newsletter",
                        "storageUri": "https://example.test/private-proof",
                    }
                ]
            }
        if path == "/api/files":
            return {"files": []}
        if path == "/api/assistant-jobs":
            return {"jobs": [{"id": "job-newsletter", "title": "Mailchimp newsletter assistant output", "assistantType": "copy", "status": "succeeded", "taskId": "task-newsletter"}]}
        raise AssertionError((path, params))

    monkeypatch.setattr(search_handler, "get_index", lambda: FakeIndex())

    response = search_handler.handler(
        _event("/search", queryStringParameters={"q": "Mailchimp newsletter", "system": "mailchimp", "limit": "20"}),
        None,
        work_fetcher=work_fetcher,
    )

    assert response["statusCode"] == 200
    payload = _json_body(response)
    result_types = {result["type"] for result in payload["results"]}
    assert {"doc", "task", "workflow", "template", "artifact", "assistant-job"} <= result_types
    task = next(result for result in payload["results"] if result["type"] == "task")
    assert task["route"] == {
        "kind": "task",
        "taskId": "task-newsletter",
        "bundleId": bundle_id,
        "instructionDocId": "task-template.newsletter",
        "instructionStepId": "publish",
    }
    assert task["fields"]["proof"] == "url proof required"
    assert task["fields"]["assignee"] == "Grace"
    assert task["fields"]["assignee_name"] == "Grace"
    assert task["fields"]["assignee_id"] == assignee_id
    assert task["fields"]["workflow_title"] == "Mailchimp newsletter run"
    assert "Assignee Grace" in task["summary"]
    assert "Workflow Mailchimp newsletter run" in task["summary"]
    assert assignee_id not in task["summary"]
    assert bundle_id not in task["summary"]
    assert assignee_id not in task["context"]
    assert bundle_id not in task["context"]
    artifact = next(result for result in payload["results"] if result["type"] == "artifact")
    assert artifact["action_label"] == "Open owner context"
    assert "private-proof" not in artifact["summary"]
    assert {"source": "docs", "status": "ok", "count": 1} in payload["sources"]
    assert any(source["source"] == "work-engine:tasks" and source["status"] == "ok" for source in payload["sources"])
    assert {"source": "work-engine:users", "status": "ok", "count": 1} in payload["sources"]


def test_search_handler_keeps_docs_when_work_sources_are_unavailable(monkeypatch):
    class FakeIndex:
        def search(self, query, filter_dict, boost_dict, num_results):
            return [
                {
                    "path": "content/overview/reference/schedule.md",
                    "id": "overview.schedule",
                    "title": "Schedule",
                    "domain": "overview",
                    "doc_type": "reference",
                    "summary": "Luma schedule context.",
                }
            ]

    def broken_work_fetcher(path, params):
        raise RuntimeError("work down")

    monkeypatch.setattr(search_handler, "get_index", lambda: FakeIndex())

    response = search_handler.handler(
        _event("/search", queryStringParameters={"q": "Luma"}),
        None,
        work_fetcher=broken_work_fetcher,
    )

    assert response["statusCode"] == 200
    payload = _json_body(response)
    assert payload["results"][0]["type"] == "doc"
    assert payload["results"][0]["route"]["kind"] == "doc"
    assert any(source["status"] == "unavailable" and "work down" in source["error"] for source in payload["sources"])


def test_search_handler_hides_task_ids_when_user_or_bundle_lookup_is_unavailable():
    assignee_id = "00000000-0000-0000-0000-000000000001"
    bundle_id = "11111111-1111-1111-1111-111111111111"

    def work_fetcher(path, params):
        if path == "/api/tasks" and params == {"status": "todo"}:
            return {
                "tasks": [
                    {
                        "id": "task-uuid-fallback",
                        "description": "Review UUID fallback search result",
                        "status": "todo",
                        "date": "2026-06-29",
                        "bundleId": bundle_id,
                        "assigneeId": assignee_id,
                    }
                ]
            }
        if path == "/api/tasks" and params == {"status": "waiting"}:
            return {"tasks": []}
        if path in {"/api/bundles", "/api/users"}:
            raise RuntimeError(f"{path} unavailable")
        if path in {"/api/templates", "/api/artifacts", "/api/files", "/api/assistant-jobs"}:
            return {}
        raise AssertionError((path, params))

    response = search_handler.handler(
        _event("/search", queryStringParameters={"q": "UUID fallback", "source": "work", "limit": "10"}),
        None,
        work_fetcher=work_fetcher,
    )

    assert response["statusCode"] == 200
    payload = _json_body(response)
    task = next(result for result in payload["results"] if result["type"] == "task")
    assert task["summary"] == "Status todo · Due 2026-06-29 · Assigned · Workflow linked"
    assert task["context"] == task["summary"]
    assert assignee_id not in task["summary"]
    assert bundle_id not in task["summary"]
    assert task["fields"]["assignee"] == ""
    assert task["fields"]["workflow_title"] == ""
    assert task["fields"]["assignee_id"] == assignee_id
    assert task["fields"]["bundle_id"] == bundle_id
    assert any(source["source"] == "work-engine:workflows" and source["status"] == "unavailable" for source in payload["sources"])
    assert any(source["source"] == "work-engine:users" and source["status"] == "unavailable" for source in payload["sources"])


def test_built_search_index_exposes_workflow_facing_fields(tmp_path, monkeypatch):
    content_root = tmp_path / "content"
    doc_path = content_root / "finance" / "reference" / "invoices.md"
    doc_path.parent.mkdir(parents=True, exist_ok=True)
    doc_path.write_text(
        """---
id: finance.invoices
title: "Invoices"
summary: "Invoice summary"
description: "Workflow-facing invoice description"
purpose: "Help the operator find invoice steps."
doc_type: reference
---

# Invoices

Use this reference when a workflow task needs invoice context.
""",
        encoding="utf-8",
    )
    index_path = tmp_path / "search.index"
    count = docs_index.build_index(content_root, index_path)

    assert count == 1
    monkeypatch.setenv("SEARCH_INDEX_PATH", str(index_path))
    search_handler.reset_index()

    response = search_handler.handler(
        _event(
            "/search",
            queryStringParameters={"q": "invoice", "domain": "finance", "doc_type": "reference"},
        ),
        None,
    )

    assert response["statusCode"] == 200
    result = _json_body(response)["results"][0]
    assert result["path"] == "content/finance/reference/invoices.md"
    assert result["id"] == "finance.invoices"
    assert result["title"] == "Invoices"
    assert result["domain"] == "finance"
    assert result["doc_type"] == "reference"
    assert result["summary"] == "Invoice summary"
    assert result["description"] == "Workflow-facing invoice description"
    assert result["purpose"] == "Help the operator find invoice steps."
    assert result["type"] == "doc"
    assert result["route"] == {
        "kind": "doc",
        "path": "content/finance/reference/invoices.md",
        "docId": "finance.invoices",
    }
