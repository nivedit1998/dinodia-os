import json
import re
import sys
from typing import Any

PROTOCOL_VERSION = 1
MAX_MESSAGE_BYTES = 1024 * 1024


def safe_text(value: Any, fallback: str = "") -> str:
    text = str(fallback if value is None else value).strip()
    return text[:256]


def public_error(code: str, message: str) -> dict[str, str]:
    cleaned = re.sub(r"(?i)(token|password|secret|credential|mfa|code)\s*[:=]?\s*[^,; ]+", r"\1=sensitive", safe_text(message, "Hive integration is unavailable."))
    return {"errorCode": re.sub(r"[^a-z0-9_]+", "_", code.lower())[:64], "message": cleaned[:240]}


def read_messages():
    for line in sys.stdin:
        if len(line.encode("utf-8")) > MAX_MESSAGE_BYTES:
            yield {"protocolVersion": PROTOCOL_VERSION, "id": "invalid", "operation": "error", "payload": {}, "error": public_error("message_too_large", "Hive worker message is too large.")}
            continue
        try:
            message = json.loads(line)
            if not isinstance(message, dict) or message.get("protocolVersion") != PROTOCOL_VERSION or not message.get("id"):
                raise ValueError("invalid message")
            yield message
        except Exception:
            yield {"protocolVersion": PROTOCOL_VERSION, "id": "invalid", "operation": "error", "payload": {}, "error": public_error("invalid_worker_message", "Invalid Hive worker message.")}


def response(message_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"protocolVersion": PROTOCOL_VERSION, "id": message_id, "ok": True, "payload": payload or {}}


def error_response(message_id: str, code: str, message: str) -> dict[str, Any]:
    return {"protocolVersion": PROTOCOL_VERSION, "id": message_id, "ok": False, **public_error(code, message)}
