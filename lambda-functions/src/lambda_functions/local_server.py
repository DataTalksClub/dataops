import argparse
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from lambda_functions.api_handler import handler as api_handler
from lambda_functions.docs_index import build_index
from lambda_functions.search_handler import DEFAULT_INDEX_PATH, handler as search_handler, reset_index


class LocalLambdaHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self.respond({"statusCode": 200, "headers": {"content-type": "application/json"}, "body": '{"ok": true}'})
            return

        if parsed.path == "/":
            self.respond(
                {
                    "statusCode": 200,
                    "headers": {"content-type": "application/json"},
                    "body": (
                        '{"service": "dtc-operations-local-lambda", '
                        '"frontend": "http://127.0.0.1:5173", '
                        '"search": "http://127.0.0.1:8787/search?q=invoice&limit=3"}'
                    ),
                }
            )
            return

        if parsed.path == "/search":
            self.respond(search_handler(lambda_event("GET", parsed.query, parsed.path), None))
            return

        self.respond(api_handler(lambda_event("GET", parsed.query, parsed.path), None))

    def do_POST(self) -> None:
        self.handle_mutation("POST")

    def do_PUT(self) -> None:
        self.handle_mutation("PUT")

    def do_DELETE(self) -> None:
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
