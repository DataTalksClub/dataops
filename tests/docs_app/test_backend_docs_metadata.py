from __future__ import annotations

import json
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
LAMBDA_SRC = REPO_ROOT / "lambda-functions" / "src"
if str(LAMBDA_SRC) not in sys.path:
    sys.path.insert(0, str(LAMBDA_SRC))

from lambda_functions import api_handler, doc_registry, full_app_handler, github_store, search_handler, sop_parse  # noqa: E402
from lambda_functions.docs_index import iter_docs  # noqa: E402


def _write_doc(content_root: Path, relative_path: str, markdown: str) -> Path:
    path = content_root / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(markdown, encoding="utf-8")
    return path


def test_list_docs_exposes_metadata_needed_by_sidebar_and_links(tmp_path, monkeypatch):
    content_root = tmp_path / "content"
    _write_doc(
        content_root,
        "systems/airtable/sops/update-record.md",
        """---
id: airtable-update-record
aliases:
  - airtable-update
title: "Update an Airtable Record"
summary: "Change a record safely."
tags: [airtable, operations]
systems:
  - airtable
---

# Update an Airtable Record
""",
    )
    _write_doc(
        content_root,
        "finance/reference/invoices.md",
        """---
title: "Invoices"
summary: "Invoice reference."
---

# Invoices
""",
    )
    monkeypatch.setattr(api_handler, "CONTENT_ROOT", content_root)

    response = api_handler.list_docs()

    assert response["statusCode"] == 200
    payload = json.loads(response["body"])
    docs = {doc["path"]: doc for doc in payload["documents"]}
    update_doc = docs["content/systems/airtable/sops/update-record.md"]
    assert update_doc["path"] == "content/systems/airtable/sops/update-record.md"
    assert update_doc["id"] == "airtable-update-record"
    assert update_doc["aliases"] == ["airtable-update"]
    assert update_doc["title"] == "Update an Airtable Record"
    assert update_doc["summary"] == "Change a record safely."
    assert update_doc["doc_type"] == "sop"
    assert update_doc["domain"] == "systems"
    assert update_doc["tags"] == ["airtable", "operations"]
    assert update_doc["systems"] == ["airtable"]
    assert update_doc["related_docs"] == []
    assert update_doc["updated"] == update_doc["updated_at"]
    assert update_doc["id_source"] == "frontmatter"
    assert update_doc["stable_id"] is True
    assert docs["content/finance/reference/invoices.md"]["doc_type"] == "reference"
    assert docs["content/finance/reference/invoices.md"]["domain"] == "finance"
    assert docs["content/finance/reference/invoices.md"]["id"] == "reference.finance.invoices"
    assert docs["content/finance/reference/invoices.md"]["id_source"] == "generated"
    assert docs["content/finance/reference/invoices.md"]["stable_id"] is False


def test_document_registry_resolves_ids_aliases_paths_and_wiki_refs(tmp_path):
    content_root = tmp_path / "content"
    _write_doc(
        content_root,
        "systems/airtable/sops/update-record.md",
        """---
id: systems.airtable.update-record
aliases:
  - airtable-update
  - content/old/airtable-update.md
title: "Update an Airtable Record"
summary: "Change a record safely."
doc_type: sop
tags: [airtable, operations]
systems:
  - airtable
related_docs:
  - ../reference/airtable-fields.md
---

# Update an Airtable Record
""",
    )
    _write_doc(
        content_root,
        "systems/airtable/reference/airtable-fields.md",
        """---
id: systems.airtable.fields
title: "Airtable Fields"
doc_type: reference
---

# Airtable Fields
""",
    )

    registry = doc_registry.build_registry(content_root)

    assert doc_registry.resolve_reference(registry, "systems.airtable.update-record").path == (
        "content/systems/airtable/sops/update-record.md"
    )
    assert doc_registry.resolve_reference(registry, "airtable-update").id == "systems.airtable.update-record"
    assert doc_registry.resolve_reference(registry, "content/old/airtable-update.md").id == (
        "systems.airtable.update-record"
    )
    assert doc_registry.resolve_reference(registry, "/systems/airtable/sops/update-record.md").id == (
        "systems.airtable.update-record"
    )
    assert doc_registry.resolve_reference(registry, "[[systems.airtable.update-record|Update]]").id == (
        "systems.airtable.update-record"
    )


def test_document_registry_rejects_duplicate_ids_and_aliases(tmp_path):
    content_root = tmp_path / "content"
    _write_doc(
        content_root,
        "finance/reference/invoices.md",
        """---
id: finance.invoices
aliases: [invoice-guide]
title: "Invoices"
doc_type: reference
---
""",
    )
    _write_doc(
        content_root,
        "finance/reference/receipts.md",
        """---
id: finance.invoices
aliases: [invoice-guide]
title: "Receipts"
doc_type: reference
---
""",
    )

    try:
        doc_registry.build_registry(content_root)
    except doc_registry.DocumentRegistryError as exc:
        assert any("duplicate id 'finance.invoices'" in violation for violation in exc.violations)
        assert any("duplicate alias 'invoice-guide'" in violation for violation in exc.violations)
    else:
        raise AssertionError("expected duplicate identity validation to fail")


def test_document_registry_rejects_alias_that_conflicts_with_another_id(tmp_path):
    content_root = tmp_path / "content"
    _write_doc(
        content_root,
        "finance/reference/invoices.md",
        """---
id: finance.invoices
aliases: [finance.receipts]
title: "Invoices"
doc_type: reference
---
""",
    )
    _write_doc(
        content_root,
        "finance/reference/receipts.md",
        """---
id: finance.receipts
title: "Receipts"
doc_type: reference
---
""",
    )

    try:
        doc_registry.build_registry(content_root)
    except doc_registry.DocumentRegistryError as exc:
        assert any(
            "alias 'finance.receipts' from content/finance/reference/invoices.md conflicts with id" in violation
            for violation in exc.violations
        )
    else:
        raise AssertionError("expected alias conflict validation to fail")


def test_document_registry_rejects_alias_that_conflicts_with_another_path(tmp_path):
    content_root = tmp_path / "content"
    _write_doc(
        content_root,
        "finance/reference/invoices.md",
        """---
id: finance.invoices
aliases:
  - content/finance/reference/receipts.md
title: "Invoices"
doc_type: reference
---
""",
    )
    _write_doc(
        content_root,
        "finance/reference/receipts.md",
        """---
id: finance.receipts
title: "Receipts"
doc_type: reference
---
""",
    )

    try:
        doc_registry.build_registry(content_root)
    except doc_registry.DocumentRegistryError as exc:
        assert any(
            "alias 'content/finance/reference/receipts.md' from content/finance/reference/invoices.md conflicts with path" in violation
            for violation in exc.violations
        )
    else:
        raise AssertionError("expected alias path conflict validation to fail")


def test_document_registry_rejects_invalid_ids_and_broken_related_docs(tmp_path):
    content_root = tmp_path / "content"
    _write_doc(
        content_root,
        "finance/reference/invoices.md",
        """---
id: "Finance Invoices"
title: "Invoices"
doc_type: reference
related_docs:
  - missing-reference
---
""",
    )

    try:
        doc_registry.build_registry(content_root)
    except doc_registry.DocumentRegistryError as exc:
        assert any("invalid id 'Finance Invoices'" in violation for violation in exc.violations)
        assert any("related_docs reference not found: 'missing-reference'" in violation for violation in exc.violations)
    else:
        raise AssertionError("expected registry validation to fail")


def test_document_registry_api_lists_and_resolves_canonical_documents(tmp_path, monkeypatch):
    content_root = tmp_path / "content"
    _write_doc(
        content_root,
        "media/podcast/sops/create-document.md",
        """---
id: media.podcast.create-document
aliases:
  - podcast-create-document
title: "Create Podcast Document"
doc_type: sop
systems: [google-drive]
related_docs: []
---

# Create Podcast Document
""",
    )
    monkeypatch.setattr(api_handler, "CONTENT_ROOT", content_root)

    registry_response = api_handler.handler(
        {"rawPath": "/docs/registry", "requestContext": {"http": {"method": "GET"}}},
        None,
    )
    resolve_response = api_handler.handler(
        {
            "rawPath": "/docs/resolve",
            "requestContext": {"http": {"method": "GET"}},
            "queryStringParameters": {"ref": "[[podcast-create-document]]"},
        },
        None,
    )

    assert registry_response["statusCode"] == 200
    registry_payload = json.loads(registry_response["body"])
    assert registry_payload["documents"][0]["id"] == "media.podcast.create-document"

    assert resolve_response["statusCode"] == 200
    resolve_payload = json.loads(resolve_response["body"])
    assert resolve_payload["document"]["path"] == "content/media/podcast/sops/create-document.md"


def test_exported_task_templates_are_git_backed_process_documents():
    templates_dir = REPO_ROOT / "content" / "tasks" / "templates"
    template_paths = sorted(templates_dir.glob("*.md"))

    assert len(template_paths) == 11

    podcast = templates_dir / "podcast.md"
    text = podcast.read_text(encoding="utf-8")
    assert "title: \"Podcast Task Template\"" in text
    assert "doc_type: task-template" in text
    assert "source: \"work-engine/scripts/seed-templates.ts\"" in text
    assert "| 4 | `create-podcast-document` | -25 | Create a podcast document with the questions" in text

    indexed = {doc["path"]: doc for doc in iter_docs(REPO_ROOT / "content")}
    assert indexed["content/tasks/templates/podcast.md"]["domain"] == "tasks"
    assert indexed["content/tasks/templates/podcast.md"]["doc_type"] == "task-template"
    assert indexed["content/tasks/templates/podcast.md"]["title"] == "Podcast Task Template"


def test_doc_and_folder_path_normalization_accepts_visible_urls(tmp_path, monkeypatch):
    content_root = tmp_path / "content"
    doc = _write_doc(content_root, "finance/reference/invoices.md", "# Invoices\n")
    (content_root / "finance" / "reference").mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(api_handler, "CONTENT_ROOT", content_root)

    assert api_handler.resolve_doc_path("/finance/reference/invoices.md") == doc.resolve()
    assert api_handler.resolve_doc_path("content/finance/reference/invoices.md") == doc.resolve()
    assert (
        api_handler._resolve_folder_path("/finance/reference")
        == (content_root / "finance" / "reference").resolve()
    )


def test_structured_sop_parser_extracts_link_rich_body_and_screenshot_caption():
    markdown = """---
schema_version: 1
title: "Link Rendering SOP"
doc_type: sop
---

<!-- sop-section-start: summary -->
## Summary
See [[airtable-update-record]] and [Invoices](../../finance/reference/invoices.md).
<!-- sop-section-end -->

<!-- sop-section-start: prerequisites -->
## Prerequisites
<!-- sop-section-end -->

<!-- sop-section-start: procedure -->
## Procedure
<!-- sop-group-start: "Airtable" -->
<!-- sop-step-start id=1 systems="airtable" -->
1. Open [Airtable](doc:airtable-update-record).

<!-- sop-screenshot-start -->
![Record editor](../../images/airtable/record.png)
<!-- sop-caption-start -->
Confirm the updated record is visible.
<!-- sop-caption-end -->
<!-- sop-screenshot-end -->
<!-- sop-step-end -->
<!-- sop-group-end -->
<!-- sop-section-end -->

<!-- sop-section-start: validation -->
## Validation
<!-- sop-section-end -->

<!-- sop-section-start: troubleshooting -->
## Troubleshooting
<!-- sop-section-end -->

<!-- sop-section-start: references -->
## References
<!-- sop-section-end -->
"""

    parsed = sop_parse.parse(markdown)

    assert parsed["schema_version"] == "1"
    assert parsed["sections"]["summary"]["body_md"].startswith("## Summary")
    procedure = parsed["sections"]["procedure"]
    step = procedure["groups"][0]["steps"][0]
    assert step["body_md"] == "Open [Airtable](doc:airtable-update-record)."
    assert step["screenshots"] == [
        {
            "alt": "Record editor",
            "src": "../../images/airtable/record.png",
            "caption": "Confirm the updated record is visible.",
        }
    ]


def test_full_app_routes_search_before_frontend_extensionless_fallback(monkeypatch):
    called = {"ensure_search": False, "search": False}

    def fake_ensure_search():
        called["ensure_search"] = True

    def fake_search_handler(event, context):
        called["search"] = True
        return {
            "statusCode": 200,
            "headers": {"content-type": "application/json"},
            "body": json.dumps({"results": [{"title": "Invoice"}]}),
        }

    monkeypatch.setattr(full_app_handler, "require_auth", lambda event: None)
    monkeypatch.setattr(full_app_handler, "ensure_search", fake_ensure_search)
    monkeypatch.setattr(full_app_handler.search_handler, "handler", fake_search_handler)

    response = full_app_handler.handler(
        {
            "rawPath": "/search",
            "queryStringParameters": {"q": "invoice", "limit": "1"},
            "requestContext": {"http": {"method": "GET"}},
        },
        None,
    )

    assert response["statusCode"] == 200
    assert json.loads(response["body"]) == {"results": [{"title": "Invoice"}]}
    assert called == {"ensure_search": True, "search": True}


def test_full_app_reads_basic_auth_password_from_secret(monkeypatch):
    monkeypatch.delenv("BASIC_AUTH_PASSWORD", raising=False)
    monkeypatch.setenv("BASIC_AUTH_USERNAME", "hammer")
    monkeypatch.setenv("BASIC_AUTH_PASSWORD_SECRET_NAME", "dtc/basic-auth")
    monkeypatch.setattr(full_app_handler, "secret_string", lambda name: "fruitless dynamo")

    token = full_app_handler.session_token()

    assert token
    assert full_app_handler.valid_basic_auth(
        {
            "headers": {
                "authorization": "Basic aGFtbWVyOmZydWl0bGVzcyBkeW5hbW8=",
            }
        }
    )


def test_github_store_reads_token_from_secret_once(monkeypatch):
    calls = []

    def fake_secret_string(name: str) -> str:
        calls.append(name)
        return "github-token"

    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.setenv("GITHUB_TOKEN_SECRET_NAME", "dtc/github-token")
    monkeypatch.setattr(github_store, "secret_string", fake_secret_string)
    monkeypatch.setattr(github_store, "_GITHUB_TOKEN_CACHE", None)

    assert github_store.github_token() == "github-token"
    assert github_store.github_token() == "github-token"
    assert calls == ["dtc/github-token"]


def test_secret_string_decodes_secret_binary(monkeypatch):
    class FakeSecretsManager:
        def get_secret_value(self, SecretId):
            assert SecretId == "dtc/binary"
            return {"SecretBinary": b"ZnJ1aXRsZXNzIGR5bmFtbw=="}

    class FakeBoto3:
        def client(self, name):
            assert name == "secretsmanager"
            return FakeSecretsManager()

    monkeypatch.setitem(sys.modules, "boto3", FakeBoto3())
    monkeypatch.setattr(github_store, "_SECRET_CACHE", {})

    assert github_store.secret_string("dtc/binary") == "fruitless dynamo"


def test_search_handler_validates_query_and_clamps_limit(monkeypatch):
    seen = {}

    class FakeIndex:
        def search(self, query, filter_dict, boost_dict, num_results):
            seen.update(
                {
                    "query": query,
                    "filter_dict": filter_dict,
                    "num_results": num_results,
                    "boosts": bool(boost_dict),
                }
            )
            return [
                {
                    "path": "content/finance/reference/invoices.md",
                    "id": "invoice-reference",
                    "title": "Invoices",
                    "domain": "finance",
                    "doc_type": "reference",
                    "summary": "Invoice reference.",
                }
            ]

    monkeypatch.setattr(search_handler, "get_index", lambda: FakeIndex())

    missing = search_handler.handler({"queryStringParameters": {}}, None)
    assert missing["statusCode"] == 400
    assert json.loads(missing["body"])["error"] == "Missing required query parameter: q"

    response = search_handler.handler(
        {
            "queryStringParameters": {
                "q": " invoice ",
                "limit": "500",
                "domain": "finance",
                "doc_type": "reference",
            }
        },
        None,
    )

    assert response["statusCode"] == 200
    assert json.loads(response["body"])["results"][0]["path"] == "content/finance/reference/invoices.md"
    assert seen == {
        "query": "invoice",
        "filter_dict": {"domain": "finance", "doc_type": "reference"},
        "num_results": search_handler.MAX_LIMIT,
        "boosts": True,
    }
