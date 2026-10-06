"""Structured JSON audit logging for RAG app queries.

One line per query, written to RAGAPP_AUDIT_LOG_PATH (default: logs/audit.jsonl
next to the corpus). Mirrors the gateway's json_logs pattern so both
components feed the same class of log-based detection tooling. Question and
answer text are never logged here -- only counts and verdicts --
matching the gateway's store_prompts_in_spend_logs: false stance.
"""

import json
import os
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_LOG_PATH = Path(__file__).resolve().parent.parent.parent / "logs" / "audit.jsonl"


def log_event(event: str, level: str, **fields) -> None:
    # event/level are required, named params (not folded into **fields) so a
    # call site can't accidentally clobber timestamp/component by passing a
    # field with that name -- fail at the call site, not silently in the log.
    if "timestamp" in fields or "component" in fields:
        raise ValueError("fields must not include 'timestamp' or 'component'")
    log_path = Path(os.environ.get("RAGAPP_AUDIT_LOG_PATH", str(DEFAULT_LOG_PATH)))
    log_path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "component": "ragapp.query",
        "event": event,
        "level": level,
        **fields,
    }
    with log_path.open("a") as f:
        f.write(json.dumps(record) + "\n")
