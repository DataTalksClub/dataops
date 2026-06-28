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


TASK_TEMPLATE_DOC_IDS = {
    "content/tasks/templates/book-of-the-week.md": "task-template.tasks.book-of-the-week",
    "content/tasks/templates/course.md": "task-template.tasks.course",
    "content/tasks/templates/maven-ll.md": "task-template.tasks.maven-ll",
    "content/tasks/templates/newsletter.md": "task-template.tasks.newsletter",
    "content/tasks/templates/office-hours.md": "task-template.tasks.office-hours",
    "content/tasks/templates/oss.md": "task-template.tasks.oss",
    "content/tasks/templates/podcast.md": "task-template.tasks.podcast",
    "content/tasks/templates/social-media.md": "task-template.tasks.social-media",
    "content/tasks/templates/tax-report.md": "task-template.tasks.tax-report",
    "content/tasks/templates/webinar.md": "task-template.tasks.webinar",
    "content/tasks/templates/workshop.md": "task-template.tasks.workshop",
}

PODCAST_WORKFLOW_CONTENT_DOC_IDS = {
    "reference.social-media.post-podcast-overview-after-the-event",
    "sop.events.announce-event-in-slack-in-announcements",
    "sop.events.calendar.create-a-calender-invite-for-the-guests-speaker-for-an-event",
    "sop.events.calendar.creating-tentative-event-on-google-calendar",
    "sop.events.luma.creating-events-on-google-calendar",
    "sop.events.luma.creating-events-webinar-workshop-and-podcast-on-luma",
    "sop.events.luma.downloading-the-csv-file-on-luma",
    "sop.events.meetup.create-events-in-meetup-com",
    "sop.events.outreach.how-to-find-emails-of-previous-guests",
    "sop.events.planning.create-speaker-profiles-via-airtable-form",
    "sop.events.planning.fill-in-the-event-form-in-airtable-for-adding-events-to-our-website",
    "sop.media.podcast.add-a-guest-bio-to-the-podcast-document",
    "sop.media.podcast.add-a-podcast-episode-via-airtable-form",
    "sop.media.podcast.add-links-to-youtube-after-the-stream-is-over",
    "sop.media.podcast.create-podcast-document",
    "sop.media.podcast.creating-podcast-transcription-document",
    "sop.media.podcast.generate-timecodes-from-docx-transcriptions",
    "sop.media.podcast.making-event-announcements-when-topic-bio-or-outline-is-missing",
    "sop.media.podcast.managing-podcast-workflow",
    "sop.media.podcast.move-podcast-documents-to-archive-in-google-drive",
    "sop.media.podcast.moving-podcast-audio-in-dropbox",
    "sop.media.podcast.reach-out-to-guests-and-propose-a-date-on-linkedin",
    "sop.media.podcast.removing-the-beginning-from-the-youtube-stream",
    "sop.media.podcast.schedule-podcast-episodes-with-spotify-for-podcaster",
    "sop.media.podcast.select-and-propose-a-date-for-events",
    "sop.media.podcast.sending-a-podcast-scheduled-email-to-pavel-after-the-event",
    "sop.media.podcast.update-the-website-with-the-information-from-forms",
    "sop.media.podcast.updating-the-cover-of-the-youtube-video",
    "sop.media.video-youtube.adding-videos-from-other-channels-to-our-playlist",
    "sop.social-media.post-podcast-guest-recommendations",
    "template.media.podcast.podcast-adding-johanna-and-sending-the-podcast-link-to-the-speaker",
    "template.media.podcast.podcast-links-after-the-event-is-over",
    "template.media.podcast.podcast-remind-about-the-event-in-a-week-share-registration-link-template",
    "template.media.podcast.podcast-remind-the-guest-about-the-event-a-day-before-template",
    "template.media.podcast.podcast-share-the-podcast-page-template",
    "template.media.podcast.sending-podcast-document-on-slack-the-dtc-podcast-help-channel",
    "template.social-media.template-new-event-announcements-podcasts-webinars-workshops",
}

PODCAST_EXTERNAL_SOURCE_DOC_IDS = {
    "assistant.podcast.process.podcast",
    "template.media.podcast.podcast-guest-intake",
}

NEWSLETTER_WORKFLOW_CONTENT_DOC_IDS = {
    "reference.newsletter.newsletter-sponsorship",
    "reference.overview.newsletter",
    "sop.finance.bookkeeping.creating-invoices-in-finom",
    "sop.newsletter.mailchimp.add-just-published-podcast-page-to-the-newsletter",
    "sop.newsletter.mailchimp.entering-information-in-the-book-of-the-week-block",
    "sop.newsletter.mailchimp.filling-newsletter-statistics",
    "sop.newsletter.mailchimp.getting-campaign-performance-stats",
    "sop.newsletter.mailchimp.schedule-a-newsletter-on-mailchimp",
    "sop.newsletter.sponsorship.creating-a-document-for-sponsored-content-for-a-newsletter",
    "sop.newsletter.sponsorship.fill-in-the-sponsored-block-in-the-newsletter",
    "sop.social-media.linkedin.creating-sponsored-content-for-linkedin-post",
    "sop.social-media.linkedin.schedule-social-media-posts-with-hootsuite-and-post-about-newsletter-promotional-content",
    "sop.social-media.twitter.schedule-posts-with-twitter-and-post-about-newsletter-promotional-content",
    "template.newsletter.communication-with-sponsors",
    "template.newsletter.create-newsletter-draft-from-template-in-mailchimp",
    "template.newsletter.newsletter-performance",
    "template.newsletter.send-sponsorship-document-2-weeks-before",
    "template.newsletter.sending-email-on-the-day-of-publication",
}

OSS_WORKFLOW_CONTENT_DOC_IDS = {
    "reference.media.open-source-spotlight.download-open-source-spotlight-video-from-zoom-and-upload-it-to-youtube",
    "reference.overview.events",
    "reference.overview.events-pre-recorded-open-source-spotlight",
    "reference.social-media.post-oss",
    "sop.media.open-source-spotlight.adding-links-from-the-zoom-chat",
    "sop.media.open-source-spotlight.adding-timecodes-for-open-source-spotlight-videos",
    "sop.media.open-source-spotlight.filling-in-the-open-source-spotlight-airtable-database",
    "sop.media.open-source-spotlight.find-timestamps-for-editing",
    "sop.media.open-source-spotlight.joining-open-source-project-communities-and-asking-for-oss-demos",
    "sop.media.open-source-spotlight.reach-out-to-open-source-spotlight-guests",
    "sop.media.open-source-spotlight.schedule-open-source-spotlight-youtube-videos",
    "sop.media.video-youtube.add-timecodes-to-youtube-videos",
    "sop.media.video-youtube.adding-videos-from-other-channels-to-our-playlist",
    "template.media.open-source-spotlight.oss-ask-the-guests-to-share-the-videos-with-their-networks",
    "template.media.open-source-spotlight.oss-asking-for-revisions-and-links",
    "template.media.open-source-spotlight.oss-reaching-out-to-authors-about-their-tool",
}

OSS_WORKFLOW_CONTENT_DOC_ALIASES = {
    "reference.media.open-source-spotlight.for-update-download-open-source-spotlight-video-from-zoom-and-upload-it-to-youtube": (
        "reference.media.open-source-spotlight.download-open-source-spotlight-video-from-zoom-and-upload-it-to-youtube"
    ),
    "sop.media.open-source-spotlight.joining-open-source-project-communities-and-asking-for-oss-demos-there": (
        "sop.media.open-source-spotlight.joining-open-source-project-communities-and-asking-for-oss-demos"
    ),
    "template.media.open-source-spotlight.oss-reaching-out-to-author-s-about-their-tool": (
        "template.media.open-source-spotlight.oss-reaching-out-to-authors-about-their-tool"
    ),
}


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
    assert registry_response["statusCode"] == 200
    registry_payload = json.loads(registry_response["body"])
    assert registry_payload["documents"][0]["id"] == "media.podcast.create-document"

    refs = [
        "media.podcast.create-document",
        "podcast-create-document",
        "content/media/podcast/sops/create-document.md",
        "/media/podcast/sops/create-document.md",
        "[[podcast-create-document]]",
        "doc:media.podcast.create-document",
    ]
    for ref in refs:
        resolve_response = api_handler.handler(
            {
                "rawPath": "/docs/resolve",
                "requestContext": {"http": {"method": "GET"}},
                "queryStringParameters": {"ref": ref},
            },
            None,
        )
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


def test_workflow_critical_docs_use_explicit_stable_frontmatter_ids():
    registry = doc_registry.build_registry(REPO_ROOT / "content")
    docs_by_path = {doc.path: doc for doc in registry.documents}

    assert set(TASK_TEMPLATE_DOC_IDS) == {
        path.relative_to(REPO_ROOT).as_posix()
        for path in sorted((REPO_ROOT / "content" / "tasks" / "templates").glob("*.md"))
    }

    for path, stable_id in TASK_TEMPLATE_DOC_IDS.items():
        record = docs_by_path[path]
        assert record.id == stable_id
        assert record.doc_type == "task-template"
        assert record.id_source == "frontmatter"
        assert record.to_dict()["stable_id"] is True
        assert doc_registry.resolve_reference(registry, stable_id).path == path

    for stable_id in PODCAST_WORKFLOW_CONTENT_DOC_IDS:
        record = doc_registry.resolve_reference(registry, stable_id)
        assert record.id == stable_id
        assert record.id_source == "frontmatter"
        assert record.to_dict()["stable_id"] is True

    for stable_id in NEWSLETTER_WORKFLOW_CONTENT_DOC_IDS:
        record = doc_registry.resolve_reference(registry, stable_id)
        assert record.id == stable_id
        assert record.id_source == "frontmatter"
        assert record.to_dict()["stable_id"] is True

    for stable_id in OSS_WORKFLOW_CONTENT_DOC_IDS:
        record = doc_registry.resolve_reference(registry, stable_id)
        assert record.id == stable_id
        assert record.id_source == "frontmatter"
        assert record.to_dict()["stable_id"] is True

    assert doc_registry.resolve_reference(registry, "sop.media.podcast.create-a-podcast-document").id == (
        "sop.media.podcast.create-podcast-document"
    )
    assert doc_registry.resolve_reference(
        registry,
        "template.internal-admin.create-a-newsletter-draft-from-a-template-in-mailchimp-10-01-2024-update",
    ).id == "template.newsletter.create-newsletter-draft-from-template-in-mailchimp"
    for alias, stable_id in OSS_WORKFLOW_CONTENT_DOC_ALIASES.items():
        assert doc_registry.resolve_reference(registry, alias).id == stable_id


def test_workflow_critical_search_docs_index_stable_id_keywords():
    indexed = {doc["id"]: doc for doc in iter_docs(REPO_ROOT / "content")}

    for stable_id in (
        set(TASK_TEMPLATE_DOC_IDS.values())
        | PODCAST_WORKFLOW_CONTENT_DOC_IDS
        | NEWSLETTER_WORKFLOW_CONTENT_DOC_IDS
        | OSS_WORKFLOW_CONTENT_DOC_IDS
    ):
        assert stable_id in indexed
        assert indexed[stable_id]["id"] == stable_id

    for external_id in PODCAST_EXTERNAL_SOURCE_DOC_IDS:
        assert external_id not in indexed


def test_search_docs_index_ids_come_from_document_registry(tmp_path):
    content_root = tmp_path / "content"
    _write_doc(
        content_root,
        "finance/reference/invoices.md",
        """---
id: finance.invoices
title: "Invoices"
doc_type: reference
---

# Invoices
""",
    )
    _write_doc(
        content_root,
        "communications/templates/datatalksclub-email-templates.md",
        """---
title: "DataTalksClub Email Templates"
doc_type: template
---

# DataTalksClub Email Templates
""",
    )

    registry = doc_registry.build_registry(content_root)
    registry_ids_by_path = {record.path: record.id for record in registry.documents}
    indexed = {doc["path"]: doc for doc in iter_docs(content_root)}

    assert indexed["content/finance/reference/invoices.md"]["id"] == registry_ids_by_path[
        "content/finance/reference/invoices.md"
    ]
    assert indexed["content/communications/templates/datatalksclub-email-templates.md"]["id"] == (
        "template.communications.datatalksclub-email-templates"
    )
    assert indexed["content/communications/templates/datatalksclub-email-templates.md"]["id"] == registry_ids_by_path[
        "content/communications/templates/datatalksclub-email-templates.md"
    ]


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
