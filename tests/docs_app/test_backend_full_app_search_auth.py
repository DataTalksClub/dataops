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

from lambda_functions import api_handler, full_app_handler, github_store, search_handler  # noqa: E402


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


def test_full_app_work_api_requires_portal_auth_before_broker(monkeypatch):
    monkeypatch.setenv("WORK_ENGINE_FUNCTION_NAME", "dataops-v1-work-engine")
    monkeypatch.setenv("WORK_ENGINE_PORTAL_SECRET", "broker-secret")
    monkeypatch.setattr(full_app_handler, "_work_engine_client", object())
    monkeypatch.setattr(full_app_handler, "require_auth", lambda event: full_app_handler.redirect_to_login())

    response = full_app_handler.handler(_event("/work/api/tasks", "GET"), None)

    assert response["statusCode"] == 302
    assert response["headers"]["location"] == "/login"


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
    assert payload["results"] == [
        {
            "path": "content/finance/reference/invoices.md",
            "id": "invoice-reference",
            "title": "Invoices",
            "domain": "finance",
            "doc_type": "reference",
            "summary": "Invoice summary",
            "description": "Invoice summary",
            "purpose": "Find invoice steps",
        }
    ]


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
