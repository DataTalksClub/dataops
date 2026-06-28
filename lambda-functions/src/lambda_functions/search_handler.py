import os
from pathlib import Path
from datetime import date
from typing import Any, Callable
from urllib.parse import parse_qs

from lambda_functions.docs_index import BOOSTS, create_index
from lambda_functions.http import response


DEFAULT_LIMIT = 10
MAX_LIMIT = 50
DEFAULT_INDEX_PATH = Path(__file__).with_name("search.index")

_index = None
WorkFetcher = Callable[[str, dict[str, str]], dict[str, Any]]


def handler(event: dict[str, Any], context: Any, work_fetcher: WorkFetcher | None = None) -> dict[str, Any]:
    method = event.get("requestContext", {}).get("http", {}).get("method", event.get("httpMethod"))
    if method == "OPTIONS":
        return response(204, {})

    try:
        params = query_params(event)
        query = (params.get("q") or "").strip()
        if not query:
            return response(400, {"error": "Missing required query parameter: q"})

        limit = min(int(params.get("limit", DEFAULT_LIMIT)), MAX_LIMIT)
        filters = {}
        for field in ("domain", "doc_type"):
            value = (params.get(field) or "").strip()
            if value:
                filters[field] = value

        results: list[dict[str, Any]] = []
        sources: list[dict[str, Any]] = []
        if source_enabled(params, "docs"):
            matches = get_index().search(
                query,
                filter_dict=filters,
                boost_dict=BOOSTS,
                num_results=limit,
            )
            doc_results = [format_result(match) for match in matches]
            doc_results = apply_unified_filters(doc_results, params)
            results.extend(doc_results)
            sources.append({"source": "docs", "status": "ok", "count": len(doc_results)})

        if source_enabled(params, "work"):
            if work_fetcher:
                work_results, work_sources = search_work_sources(query, params, work_fetcher)
                results.extend(work_results)
                sources.extend(work_sources)
            else:
                sources.append(
                    {
                        "source": "work-engine",
                        "status": "unavailable",
                        "error": "Work search is not configured for this runtime",
                    }
                )

        results = sort_results(results)[:limit]
        return response(200, {"query": query, "results": results, "sources": sources})
    except ValueError as exc:
        return response(400, {"error": str(exc)})
    except Exception as exc:
        return response(500, {"error": "Search failed", "detail": str(exc)})


def get_index():
    global _index
    if _index is None:
        index_path = Path(os.environ.get("SEARCH_INDEX_PATH", DEFAULT_INDEX_PATH))
        if not index_path.exists():
            raise FileNotFoundError(f"Search index not found: {index_path}")
        _index = create_index(index_path)
    return _index


def reset_index() -> None:
    global _index
    _index = None


def query_params(event: dict[str, Any]) -> dict[str, str]:
    params = event.get("queryStringParameters") or {}
    if params:
        return {key: str(value) for key, value in params.items() if value is not None}

    raw_query = event.get("rawQueryString")
    if not raw_query:
        return {}

    parsed = parse_qs(raw_query)
    return {key: values[-1] for key, values in parsed.items() if values}


def format_result(match: dict[str, Any]) -> dict[str, Any]:
    summary = match.get("summary") or ""
    description = match.get("description") or summary
    return {
        "type": "doc",
        "source": "docs",
        "source_label": doc_source_label(match),
        "action_label": "Open process doc",
        "path": match.get("path"),
        "id": match.get("id"),
        "title": match.get("title"),
        "domain": match.get("domain"),
        "doc_type": match.get("doc_type"),
        "summary": summary,
        "context": description or summary or match.get("path") or "",
        "description": description,
        "purpose": match.get("purpose") or "",
        "tags": list_values(match.get("tags")),
        "systems": list_values(match.get("systems")),
        "route": {
            "kind": "doc",
            "path": match.get("path"),
            "docId": match.get("id"),
        },
        "fields": {
            "doc_type": match.get("doc_type") or "",
            "domain": match.get("domain") or "",
            "tags": list_values(match.get("tags")),
            "systems": list_values(match.get("systems")),
        },
    }


def source_enabled(params: dict[str, str], source: str) -> bool:
    requested = (params.get("source") or params.get("sources") or "").strip().lower()
    if not requested:
        return True
    values = {value.strip() for value in requested.replace(",", " ").split() if value.strip()}
    if source == "docs":
        return bool(values & {"docs", "doc", "process", "process-docs"})
    return bool(values & {"work", "work-engine", "tasks", "task", "workflow", "workflows", "runtime"})


def apply_unified_filters(results: list[dict[str, Any]], params: dict[str, str]) -> list[dict[str, Any]]:
    out = []
    for result in results:
        if not result_matches_filters(result, params):
            continue
        out.append(result)
    return out


def result_matches_filters(result: dict[str, Any], params: dict[str, str]) -> bool:
    requested_type = (params.get("type") or params.get("result_type") or "").strip().lower()
    if requested_type and requested_type not in {str(result.get("type") or "").lower(), str(result.get("doc_type") or "").lower()}:
        return False

    tag = (params.get("tag") or "").strip().lower()
    if tag and not metadata_filter_matches(result, "tags", tag):
        return False

    system = (params.get("system") or "").strip().lower()
    if system and not metadata_filter_matches(result, "systems", system):
        return False

    status = (params.get("task_status") or params.get("status") or "").strip().lower()
    if status and result.get("type") == "task" and status != str(result.get("fields", {}).get("status") or "").lower():
        return False

    assignee = (params.get("assignee") or params.get("assignee_id") or "").strip().lower()
    if assignee and result.get("type") == "task":
        fields = result.get("fields", {})
        assignee_values = {
            str(fields.get("assignee") or "").lower(),
            str(fields.get("assignee_name") or "").lower(),
            str(fields.get("assignee_id") or "").lower(),
        }
        if assignee not in assignee_values:
            return False

    due_bucket = (params.get("due") or params.get("due_bucket") or "").strip().lower()
    if due_bucket and result.get("type") == "task" and due_bucket != str(result.get("fields", {}).get("due_bucket") or "").lower():
        return False

    bundle = (params.get("bundle") or params.get("bundle_id") or params.get("workflow") or "").strip().lower()
    if bundle and result.get("source") == "work-engine":
        fields = result.get("fields", {})
        ids = {
            str(fields.get("bundle_id") or "").lower(),
            str(fields.get("workflow_id") or "").lower(),
            str(result.get("id") or "").lower() if result.get("type") == "workflow" else "",
        }
        if bundle not in ids:
            return False

    template_type = (params.get("template_type") or params.get("workflow_type") or "").strip().lower()
    if template_type and result.get("source") == "work-engine":
        if template_type != str(result.get("fields", {}).get("template_type") or "").lower():
            return False

    return True


def metadata_filter_matches(result: dict[str, Any], field: str, requested: str) -> bool:
    values = {value.lower() for value in list_values(result.get(field) or result.get("fields", {}).get(field))}
    if result.get("source") == "docs":
        return requested in values
    return not values or requested in values


def search_work_sources(query: str, params: dict[str, str], fetcher: WorkFetcher) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    results: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    today = date.today().isoformat()

    tasks = fetch_work_collection("tasks", fetcher, task_search_requests(params, today), "tasks", sources)
    bundles = fetch_work_collection("workflows", fetcher, [("/api/bundles", {})], "bundles", sources)
    templates = fetch_work_collection("templates", fetcher, [("/api/templates", {})], "templates", sources)
    artifacts = fetch_work_collection("artifacts", fetcher, [("/api/artifacts", {})], "artifacts", sources)
    files = fetch_work_collection("files", fetcher, [("/api/files", {})], "files", sources)
    assistant_jobs = fetch_work_collection("assistant-jobs", fetcher, [("/api/assistant-jobs", {})], "jobs", sources)
    users = fetch_work_collection("users", fetcher, [("/api/users", {})], "users", sources)

    tasks_by_bundle: dict[str, list[dict[str, Any]]] = {}
    for bundle in bundles[:20]:
        bundle_id = str(bundle.get("id") or "")
        if not bundle_id:
            continue
        try:
            payload = fetcher("/api/tasks", {"bundleId": bundle_id})
            tasks_by_bundle[bundle_id] = collection_from_payload(payload, "tasks")
        except Exception as exc:
            sources.append({"source": "work-engine:workflow-tasks", "status": "unavailable", "error": str(exc), "owner_id": bundle_id})

    users_by_id = {str(user.get("id")): user for user in users if user.get("id")}
    bundles_by_id = {str(bundle.get("id")): bundle for bundle in bundles if bundle.get("id")}

    for task in dedupe_records(tasks + [task for group in tasks_by_bundle.values() for task in group]):
        result = format_task_result(task, today, users_by_id=users_by_id, bundles_by_id=bundles_by_id)
        if work_result_matches(result, query, params):
            results.append(result)

    for bundle in bundles:
        bundle_tasks = tasks_by_bundle.get(str(bundle.get("id") or ""), [])
        result = format_bundle_result(bundle, bundle_tasks, today)
        if work_result_matches(result, query, params):
            results.append(result)

    for template in templates:
        result = format_template_result(template)
        if work_result_matches(result, query, params):
            results.append(result)

    for artifact in artifacts:
        result = format_artifact_result(artifact)
        if work_result_matches(result, query, params):
            results.append(result)

    for file_record in files:
        result = format_file_result(file_record)
        if work_result_matches(result, query, params):
            results.append(result)

    for job in assistant_jobs:
        result = format_assistant_job_result(job)
        if work_result_matches(result, query, params):
            results.append(result)

    return dedupe_results(results), sources


def task_search_requests(params: dict[str, str], today: str) -> list[tuple[str, dict[str, str]]]:
    status = (params.get("task_status") or params.get("status") or "").strip()
    bundle = (params.get("bundle") or params.get("bundle_id") or params.get("workflow") or "").strip()
    due_bucket = (params.get("due") or params.get("due_bucket") or "").strip().lower()
    if bundle:
        return [("/api/tasks", {"bundleId": bundle})]
    if status:
        return [("/api/tasks", {"status": status})]
    if due_bucket == "today":
        return [("/api/tasks", {"date": today})]
    if due_bucket == "overdue":
        return [("/api/tasks", {"startDate": "1970-01-01", "endDate": today})]
    return [
        ("/api/tasks", {"status": "todo"}),
        ("/api/tasks", {"status": "waiting"}),
    ]


def fetch_work_collection(
    label: str,
    fetcher: WorkFetcher,
    requests: list[tuple[str, dict[str, str]]],
    collection_key: str,
    sources: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    ok = False
    for path, query in requests:
        try:
            payload = fetcher(path, query)
            chunk = collection_from_payload(payload, collection_key)
            rows.extend(chunk)
            ok = True
        except Exception as exc:
            sources.append({"source": f"work-engine:{label}", "status": "unavailable", "error": str(exc)})
    if ok:
        rows = dedupe_records(rows)
        sources.append({"source": f"work-engine:{label}", "status": "ok", "count": len(rows)})
    return rows


def collection_from_payload(payload: Any, key: str) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    candidates = [payload.get(key), payload.get("items")]
    if key == "jobs":
        candidates.extend([payload.get("assistantJobs"), payload.get("assistant_jobs")])
    for value in candidates:
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return []


def format_task_result(
    task: dict[str, Any],
    today: str,
    *,
    users_by_id: dict[str, dict[str, Any]] | None = None,
    bundles_by_id: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    task_id = str(task.get("id") or "")
    title = str(task.get("description") or task.get("title") or task_id or "Task")
    status = str(task.get("status") or "todo")
    due = str(task.get("date") or "")
    proof = proof_state(task)
    assignee_id = str(task.get("assigneeId") or "")
    bundle_id = str(task.get("bundleId") or "")
    assignee_label = user_display_label((users_by_id or {}).get(assignee_id))
    workflow_label = bundle_display_label((bundles_by_id or {}).get(bundle_id))
    summary = " · ".join(
        part
        for part in [
            f"Status {status}",
            f"Due {due}" if due else "",
            f"Assignee {assignee_label}" if assignee_label else "Assigned" if assignee_id else "",
            f"Workflow {workflow_label}" if workflow_label else "Workflow linked" if bundle_id else "",
            proof,
        ]
        if part
    )
    context = str(task.get("comment") or task.get("waitingFor") or task.get("requiredLinkName") or summary)
    return {
        "type": "task",
        "source": "work-engine",
        "source_label": "Live task",
        "action_label": "Open task",
        "id": task_id,
        "title": title,
        "summary": summary,
        "context": context,
        "tags": list_values(task.get("tags")),
        "systems": list_values(task.get("systems")),
        "route": {
            "kind": "task",
            "taskId": task_id,
            "bundleId": task.get("bundleId"),
            "instructionDocId": task.get("instructionDocId"),
            "instructionStepId": task.get("instructionStepId"),
        },
        "fields": {
            "status": status,
            "due_date": due,
            "due_bucket": due_bucket(due, today),
            "assignee": assignee_label,
            "assignee_name": assignee_label,
            "assignee_id": assignee_id,
            "workflow_title": workflow_label,
            "bundle_id": bundle_id,
            "template_id": task.get("templateId") or "",
            "instructionDocId": task.get("instructionDocId") or "",
            "instructionStepId": task.get("instructionStepId") or "",
            "phase": task.get("phase") or "",
            "proof": proof,
            "systems": list_values(task.get("systems")),
            "tags": list_values(task.get("tags")),
        },
        "_search_text": stringify_search_text(task, [title, summary, assignee_label, workflow_label, proof]),
    }


def format_bundle_result(bundle: dict[str, Any], tasks: list[dict[str, Any]], today: str) -> dict[str, Any]:
    bundle_id = str(bundle.get("id") or "")
    title = str(bundle.get("title") or bundle.get("name") or bundle_id or "Workflow")
    active = [task for task in tasks if str(task.get("status") or "").lower() not in {"done", "archived"}]
    overdue = [task for task in active if due_bucket(str(task.get("date") or ""), today) == "overdue"]
    missing_proof = [task for task in active if proof_state(task).startswith("Missing")]
    next_due = sorted([str(task.get("date") or "") for task in active if task.get("date")])
    related_docs = sorted({str(task.get("instructionDocId")) for task in tasks if task.get("instructionDocId")})
    summary = " · ".join(
        part
        for part in [
            f"Stage {bundle.get('stage')}" if bundle.get("stage") else "",
            f"Status {bundle.get('status')}" if bundle.get("status") else "",
            f"{len(active)} active tasks",
            f"{len(overdue)} overdue" if overdue else "",
            f"{len(missing_proof)} missing proof" if missing_proof else "",
            f"Next due {next_due[0]}" if next_due else "",
        ]
        if part
    )
    return {
        "type": "workflow",
        "source": "work-engine",
        "source_label": "Active workflow",
        "action_label": "Open workflow",
        "id": bundle_id,
        "title": title,
        "summary": summary,
        "context": str(bundle.get("description") or ""),
        "tags": list_values(bundle.get("tags")),
        "systems": [],
        "route": {"kind": "workflow", "bundleId": bundle_id},
        "fields": {
            "workflow_id": bundle_id,
            "bundle_id": bundle_id,
            "template_id": bundle.get("templateId") or "",
            "stage": bundle.get("stage") or "",
            "status": bundle.get("status") or "",
            "active_tasks": len(active),
            "overdue_tasks": len(overdue),
            "missing_proof": len(missing_proof),
            "next_due": next_due[0] if next_due else "",
            "related_doc_ids": related_docs,
            "tags": list_values(bundle.get("tags")),
        },
        "_search_text": stringify_search_text(bundle, [title, summary, " ".join(related_docs)] + task_search_fragments(tasks)),
    }


def format_template_result(template: dict[str, Any]) -> dict[str, Any]:
    template_id = str(template.get("id") or "")
    title = str(template.get("name") or template.get("title") or template_id or "Workflow template")
    source_docs = list_values(template.get("sourceDocIds"))
    task_defs = template.get("taskDefinitions") if isinstance(template.get("taskDefinitions"), list) else []
    summary = " · ".join(
        part
        for part in [
            str(template.get("type") or "workflow template"),
            f"{len(task_defs)} tasks" if task_defs else "",
            f"Docs {', '.join(source_docs)}" if source_docs else "",
        ]
        if part
    )
    return {
        "type": "template",
        "source": "work-engine",
        "source_label": "Live workflow template",
        "action_label": "Start or inspect workflow",
        "id": template_id,
        "title": title,
        "summary": summary,
        "context": "Runtime template from work-engine, distinct from Git-backed task-template docs.",
        "tags": list_values(template.get("tags")),
        "systems": [],
        "route": {"kind": "template", "templateId": template_id, "templateType": template.get("type")},
        "fields": {
            "template_id": template_id,
            "template_type": template.get("type") or "",
            "source_doc_ids": source_docs,
            "tags": list_values(template.get("tags")),
        },
        "_search_text": stringify_search_text(template, [title, summary, " ".join(source_docs)]),
    }


def format_artifact_result(artifact: dict[str, Any]) -> dict[str, Any]:
    artifact_id = str(artifact.get("id") or "")
    title = str(artifact.get("title") or artifact.get("filename") or artifact_id or "Artifact")
    owner = owner_context(artifact)
    summary = " · ".join(part for part in [str(artifact.get("status") or ""), str(artifact.get("type") or ""), owner] if part)
    return {
        "type": "artifact",
        "source": "work-engine",
        "source_label": "Artifact",
        "action_label": "Open owner context",
        "id": artifact_id,
        "title": title,
        "summary": summary,
        "context": str(artifact.get("description") or owner),
        "tags": list_values(artifact.get("tags")),
        "systems": [],
        "route": {
            "kind": "artifact",
            "artifactId": artifact_id,
            "taskId": artifact.get("taskId"),
            "bundleId": artifact.get("bundleId"),
            "assistantJobId": artifact.get("assistantJobId"),
        },
        "fields": {
            "status": artifact.get("status") or "",
            "artifact_type": artifact.get("type") or "",
            "task_id": artifact.get("taskId") or "",
            "bundle_id": artifact.get("bundleId") or "",
            "assistant_job_id": artifact.get("assistantJobId") or "",
            "storage_provider": artifact.get("storageProvider") or "",
            "tags": list_values(artifact.get("tags")),
        },
        "_search_text": stringify_search_text(artifact, [title, summary], exclude_keys={"storageUri"}),
    }


def format_file_result(file_record: dict[str, Any]) -> dict[str, Any]:
    file_id = str(file_record.get("id") or "")
    title = str(file_record.get("filename") or file_id or "File")
    owner = owner_context(file_record)
    summary = " · ".join(part for part in [str(file_record.get("category") or "file"), owner] if part)
    return {
        "type": "file",
        "source": "work-engine",
        "source_label": "File",
        "action_label": "Open task context",
        "id": file_id,
        "title": title,
        "summary": summary,
        "context": owner,
        "tags": list_values(file_record.get("tags")),
        "systems": [],
        "route": {"kind": "file", "fileId": file_id, "taskId": file_record.get("taskId"), "bundleId": file_record.get("bundleId")},
        "fields": {
            "task_id": file_record.get("taskId") or "",
            "bundle_id": file_record.get("bundleId") or "",
            "category": file_record.get("category") or "",
            "storage_provider": file_record.get("storageProvider") or "",
            "tags": list_values(file_record.get("tags")),
        },
        "_search_text": stringify_search_text(file_record, [title, summary], exclude_keys={"storagePath", "storageUri"}),
    }


def format_assistant_job_result(job: dict[str, Any]) -> dict[str, Any]:
    job_id = str(job.get("id") or "")
    title = str(job.get("title") or job.get("assistantType") or job_id or "Assistant job")
    owner = owner_context(job)
    summary = " · ".join(part for part in [str(job.get("status") or ""), str(job.get("assistantType") or ""), owner] if part)
    return {
        "type": "assistant-job",
        "source": "work-engine",
        "source_label": "Assistant job",
        "action_label": "Open owner context",
        "id": job_id,
        "title": title,
        "summary": summary,
        "context": "Metadata-only assistant result. Live assistant execution is not started from search.",
        "tags": [],
        "systems": [],
        "route": {"kind": "assistant-job", "assistantJobId": job_id, "taskId": job.get("taskId"), "bundleId": job.get("bundleId")},
        "fields": {
            "status": job.get("status") or "",
            "assistant_type": job.get("assistantType") or "",
            "task_id": job.get("taskId") or "",
            "bundle_id": job.get("bundleId") or "",
        },
        "_search_text": stringify_search_text(job, [title, summary]),
    }


def work_result_matches(result: dict[str, Any], query: str, params: dict[str, str]) -> bool:
    if not result_matches_filters(result, params):
        return False
    return query_matches(result.get("_search_text") or stringify_search_text(result), query)


def query_matches(text: str, query: str) -> bool:
    haystack = text.lower()
    normalized = query.strip().lower()
    if not normalized:
        return True
    if normalized in haystack:
        return True
    tokens = [token for token in normalized.replace("-", " ").split() if token]
    return bool(tokens) and all(token in haystack for token in tokens)


def stringify_search_text(value: Any, extra: list[str] | None = None, exclude_keys: set[str] | None = None) -> str:
    parts = list(extra or [])
    exclude_keys = exclude_keys or set()

    def walk(item: Any) -> None:
        if item is None:
            return
        if isinstance(item, (str, int, float, bool)):
            parts.append(str(item))
            return
        if isinstance(item, list):
            for child in item:
                walk(child)
            return
        if isinstance(item, dict):
            for key, child in item.items():
                if key in exclude_keys:
                    continue
                parts.append(str(key))
                walk(child)

    walk(value)
    return " ".join(parts)


def task_search_fragments(tasks: list[dict[str, Any]]) -> list[str]:
    return [stringify_search_text(task, exclude_keys={"link", "storageUri", "storagePath"}) for task in tasks]


def sort_results(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    order = {"task": 0, "workflow": 1, "template": 2, "doc": 3, "artifact": 4, "file": 5, "assistant-job": 6}
    return sorted(results, key=lambda item: (order.get(str(item.get("type")), 9), str(item.get("title") or "").lower()))


def dedupe_records(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen = set()
    out = []
    for row in rows:
        row_id = row.get("id")
        if not row_id or row_id in seen:
            continue
        seen.add(row_id)
        out.append(row)
    return out


def dedupe_results(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen = set()
    out = []
    for result in results:
        key = (result.get("source"), result.get("type"), result.get("id") or result.get("path"))
        if key in seen:
            continue
        seen.add(key)
        result.pop("_search_text", None)
        out.append(result)
    return out


def due_bucket(due: str, today: str) -> str:
    if not due:
        return "none"
    if due < today:
        return "overdue"
    if due == today:
        return "today"
    return "upcoming"


def proof_state(task: dict[str, Any]) -> str:
    if task.get("requiredLinkName") and not task.get("link"):
        return f"Missing {task.get('requiredLinkName')}"
    if task.get("requiresFile"):
        return "File proof required"
    proof = task.get("proofRequirement")
    if isinstance(proof, dict) and proof.get("required", True):
        return f"{proof.get('type', 'proof')} proof required"
    return ""


def user_display_label(user: dict[str, Any] | None) -> str:
    if not isinstance(user, dict):
        return ""
    for key in ("name", "displayName", "fullName", "email"):
        value = str(user.get(key) or "").strip()
        if value:
            return value
    return ""


def bundle_display_label(bundle: dict[str, Any] | None) -> str:
    if not isinstance(bundle, dict):
        return ""
    for key in ("title", "name"):
        value = str(bundle.get(key) or "").strip()
        if value:
            return value
    return ""


def owner_context(record: dict[str, Any]) -> str:
    if record.get("taskId"):
        return f"Task {record.get('taskId')}"
    if record.get("bundleId"):
        return f"Workflow {record.get('bundleId')}"
    if record.get("assistantJobId"):
        return f"Assistant job {record.get('assistantJobId')}"
    return ""


def list_values(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item) for item in value if str(item)]
    if isinstance(value, str):
        return [part.strip() for part in value.replace(",", " ").split() if part.strip()]
    return [str(value)]


def doc_source_label(match: dict[str, Any]) -> str:
    doc_type = match.get("doc_type") or "doc"
    return f"Process {doc_type}"
