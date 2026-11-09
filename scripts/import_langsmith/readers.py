"""Read LangSmith runs from bulk-export Parquet, saved JSONL, or the LangSmith API.

Every reader yields runs normalized by `normalize_run`, so the converter sees one
shape regardless of source: string UUIDs, timezone-aware datetimes, and decoded
JSON for the nested fields (bulk-export Parquet stores some of them as strings).
"""

import json
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

# Run fields holding nested JSON. Parquet exports may serialize them as strings.
JSON_FIELDS = (
    "inputs",
    "outputs",
    "extra",
    "events",
    "tags",
    "feedback_stats",
    "prompt_token_details",
    "completion_token_details",
    "parent_run_ids",
)
ID_FIELDS = ("id", "trace_id", "parent_run_id", "session_id")
TIME_FIELDS = ("start_time", "end_time")


def _to_uuid_str(value: Any) -> str | None:
    if value is None or value == "":
        return None
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, bytes | bytearray) and len(value) == 16:
        return str(uuid.UUID(bytes=bytes(value)))
    return str(uuid.UUID(str(value)))


def _to_datetime(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    if hasattr(value, "to_pydatetime"):  # pandas / pyarrow timestamp scalars
        return _to_datetime(value.to_pydatetime())
    text = str(value).replace("Z", "+00:00")
    parsed = datetime.fromisoformat(text)
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _decode_json(value: Any) -> Any:
    if isinstance(value, str) and value[:1] in ("{", "["):
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def normalize_run(raw: dict[str, Any]) -> dict[str, Any]:
    """Return a copy of a LangSmith run with IDs, timestamps, and JSON fields normalized."""
    run = dict(raw)
    for field in ID_FIELDS:
        run[field] = _to_uuid_str(run.get(field))
    for field in TIME_FIELDS:
        run[field] = _to_datetime(run.get(field))
    for field in JSON_FIELDS:
        run[field] = _decode_json(run.get(field))
    if not run.get("trace_id"):
        run["trace_id"] = run["id"]
    return run


def in_window(run: dict[str, Any], start: datetime | None, end: datetime | None) -> bool:
    """Whether a run's start time falls in [start, end)."""
    started = run.get("start_time")
    if started is None:
        return False
    return (start is None or started >= start) and (end is None or started < end)


def read_jsonl(path: Path) -> Iterator[dict[str, Any]]:
    """Runs saved one JSON object per line (e.g. `Run.model_dump(mode="json")`)."""
    with path.open() as handle:
        for line in handle:
            if line.strip():
                yield normalize_run(json.loads(line))


def read_parquet(path: Path, batch_size: int = 1000) -> Iterator[dict[str, Any]]:
    """Runs from a bulk-export Parquet file, or every `*.parquet` under a directory.

    Bulk exports land in Hive-style folders
    (`export_id=.../tenant_id=.../session_id=.../runs/year=.../month=.../day=...`), so
    a directory is walked recursively. Rows are streamed in batches to bound memory.
    """
    try:
        import pyarrow.parquet as pq
    except ImportError as exc:  # pragma: no cover - depends on the environment
        raise SystemExit("Reading Parquet needs pyarrow: pip install pyarrow") from exc

    files = sorted(path.rglob("*.parquet")) if path.is_dir() else [path]
    if not files:
        raise SystemExit(f"No .parquet files found under {path}")
    for file in files:
        parquet = pq.ParquetFile(file)
        for batch in parquet.iter_batches(batch_size=batch_size):
            for row in batch.to_pylist():
                yield normalize_run(row)


def read_api(
    project: str, start: datetime | None, end: datetime | None
) -> Iterator[dict[str, Any]]:
    """Runs pulled live from the LangSmith API for one project (name or UUID).

    Uses LANGSMITH_API_KEY / LANGSMITH_ENDPOINT from the environment. Slower than a
    bulk export, but works on every LangSmith plan.
    """
    try:
        from langsmith import Client
    except ImportError as exc:  # pragma: no cover - depends on the environment
        raise SystemExit("Reading from the API needs langsmith: pip install langsmith") from exc

    client = Client()
    try:
        project_kwargs = {"project_id": str(uuid.UUID(project))}
    except ValueError:
        project_kwargs = {"project_name": project}
    # `list_runs` is deprecated after 2027-01-31 in favor of `client.runs.query`.
    for run in client.list_runs(**project_kwargs, start_time=start):
        normalized = normalize_run(run.model_dump(mode="json"))
        if in_window(normalized, start, end):
            yield normalized
