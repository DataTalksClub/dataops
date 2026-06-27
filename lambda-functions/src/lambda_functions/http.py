import json
from typing import Any


DEFAULT_HEADERS = {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type,x-user-email",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
}


def response(status_code: int, body: Any) -> dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": DEFAULT_HEADERS,
        "body": json.dumps(body, ensure_ascii=False),
    }
