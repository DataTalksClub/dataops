import argparse
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import urllib.request

from lambda_functions.api_handler import handler as api_handler
from lambda_functions.docs_index import build_index
from lambda_functions.search_handler import DEFAULT_INDEX_PATH, handler as search_handler, reset_index


class LocalLambdaHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if self._maybe_proxy_work_api(method="GET"):
            return
        if parsed.path == "/health":
            self.respond({"statusCode": 200, "headers": {"content-type": "application/json"}, "body": '{"ok": true}'})
            return

        if parsed.path == "/":
            self.respond(
                {
                    "statusCode": 200,
                    "headers": {"content-type": "application/json"},
                    "body": (
                        '{"service": "dataops-local-lambda", '
                        '"frontend": "http://127.0.0.1:5173", '
                        '"search": "http://127.0.0.1:8787/search?q=invoice&limit=3"}'
                    ),
                }
            )
            return

        if parsed.path == "/search":
            self.respond(search_handler(lambda_event("GET", parsed.query, parsed.path), None, work_fetcher=self.fetch_work_search_payload))
            return

        self.respond(api_handler(lambda_event("GET", parsed.query, parsed.path), None))

    def do_POST(self) -> None:
        if self._maybe_proxy_work_api(method="POST"):
            return
        self.handle_mutation("POST")

    def do_PUT(self) -> None:
        if self._maybe_proxy_work_api(method="PUT"):
            return
        self.handle_mutation("PUT")

    def do_DELETE(self) -> None:
        if self._maybe_proxy_work_api(method="DELETE"):
            return
        self.handle_mutation("DELETE")

    def do_OPTIONS(self) -> None:
        self.respond(api_handler(lambda_event("OPTIONS", "", ""), None))

    def handle_mutation(self, method: str) -> None:
        parsed = urlparse(self.path)
        event = lambda_event(method, parsed.query, parsed.path)
        event["body"] = self.read_body()
        result = api_handler(event, None)
        self.respond(result)

        if parsed.path == "/docs" and 200 <= result["statusCode"] < 300:
            rebuild_search_index()

    def respond(self, result: dict[str, Any]) -> None:
        self.send_response(result["statusCode"])
        for key, value in result.get("headers", {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(result.get("body", "").encode("utf-8"))

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.address_string()} - {fmt % args}")

    def _maybe_proxy_work_api(self, method: str) -> bool:
        """Proxy /work/api/* and /work/health to the work-engine dev server.

        In production the full_app_handler brokers these via Lambda invoke.
        Locally we proxy to the work-engine dev server (default port 3000)
        so the frontend gets real JSON without CORS or a second public URL.
        """
        base_url = os.environ.get("WORK_ENGINE_DEV_URL", "")
        parsed = urlparse(self.path)
        if not base_url or not parsed.path.startswith("/work/"):
            return False
        # Map /work/health -> /api/health to match the production broker,
        # which rewrites health checks to the canonical API path.
        if parsed.path == "/work/health":
            work_path = "/api/health"
        else:
            work_path = parsed.path.removeprefix("/work")
        target = f"{base_url.rstrip('/')}{work_path}"
        if parsed.query:
            target += f"?{parsed.query}"
        body = self.read_body().encode("utf-8") if method in {"POST", "PUT", "DELETE", "PATCH"} else None
        req = urllib.request.Request(target, data=body, method=method)
        req.add_header("content-type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=30) as upstream:
                response_body = upstream.read()
                content_type = upstream.headers.get("content-type", "application/json")
                self.respond_raw(upstream.status, content_type, response_body)
        except urllib.error.HTTPError as exc:
            response_body = exc.read()
            content_type = exc.headers.get("content-type", "application/json") if exc.headers else "application/json"
            self.respond_raw(exc.code, content_type, response_body)
        except urllib.error.URLError as exc:
            self.respond(
                {
                    "statusCode": 503,
                    "headers": {"content-type": "application/json"},
                    "body": json.dumps({"error": f"Work engine dev server unreachable: {exc.reason}"}),
                }
            )
        return True

    def respond_raw(self, status: int, content_type: str, body: bytes) -> None:
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.end_headers()
        self.wfile.write(body)

    def fetch_work_search_payload(self, work_path: str, params: dict[str, str]) -> dict[str, Any]:
        base_url = os.environ.get("WORK_ENGINE_DEV_URL", "")
        if not base_url:
            raise RuntimeError("Work engine dev server is not configured")
        query = urllib.parse.urlencode(params) if params else ""
        target = f"{base_url.rstrip('/')}{work_path}"
        if query:
            target += f"?{query}"
        try:
            with urllib.request.urlopen(target, timeout=15) as upstream:
                raw = upstream.read()
                payload = json.loads(raw.decode("utf-8") or "{}")
        except urllib.error.HTTPError as exc:
            try:
                payload = json.loads(exc.read().decode("utf-8") or "{}")
            except json.JSONDecodeError:
                payload = {}
            detail = payload.get("error") if isinstance(payload, dict) else ""
            raise RuntimeError(detail or f"{work_path} returned HTTP {exc.code}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Work engine dev server unreachable: {exc.reason}") from exc
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"{work_path} returned invalid JSON") from exc
        if not isinstance(payload, dict):
            raise RuntimeError(f"{work_path} returned an unsupported payload")
        return payload

    def read_body(self) -> str:
        content_length = int(self.headers.get("content-length") or "0")
        if content_length == 0:
            return "{}"
        return self.rfile.read(content_length).decode("utf-8")


def lambda_event(method: str, raw_query: str, path: str) -> dict[str, Any]:
    parsed = parse_qs(raw_query)
    params = {key: values[-1] for key, values in parsed.items() if values}
    return {
        "rawQueryString": raw_query,
        "queryStringParameters": params,
        "rawPath": path,
        "path": path,
        "requestContext": {"http": {"method": method}},
    }


def rebuild_search_index() -> None:
    content_root = Path(os.environ.get("CONTENT_ROOT", os.environ.get("DOCS_ROOT", "../content")))
    index_path = Path(os.environ.get("SEARCH_INDEX_PATH", DEFAULT_INDEX_PATH))
    build_index(content_root, index_path)
    reset_index()


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Lambda handlers locally over HTTP.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8787, type=int)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), LocalLambdaHandler)
    print(f"Local Lambda server listening on http://{args.host}:{args.port}")
    print(f"Try: http://{args.host}:{args.port}/search?q=invoice&limit=3")
    server.serve_forever()


if __name__ == "__main__":
    main()
