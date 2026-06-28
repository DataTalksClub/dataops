import os
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs

from lambda_functions.docs_index import BOOSTS, create_index
from lambda_functions.http import response


DEFAULT_LIMIT = 10
MAX_LIMIT = 50
DEFAULT_INDEX_PATH = Path(__file__).with_name("search.index")

_index = None


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
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

        matches = get_index().search(
            query,
            filter_dict=filters,
            boost_dict=BOOSTS,
            num_results=limit,
        )
        results = [format_result(match) for match in matches]
        return response(200, {"query": query, "results": results})
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
        "path": match.get("path"),
        "id": match.get("id"),
        "title": match.get("title"),
        "domain": match.get("domain"),
        "doc_type": match.get("doc_type"),
        "summary": summary,
        "description": description,
        "purpose": match.get("purpose") or "",
    }
