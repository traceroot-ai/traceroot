"""Convert LangSmith runs to OpenInference-shaped spans.

The attributes mirror what TraceRoot's live LangChain integration emits
(`openinference.span.kind`, `input.value`, `llm.token_count.*`, ...), so imported
traces render, cost, and filter like traces from the SDK.

Two LangSmith behaviors shape the mapping:

- LangSmith rolls token counts and cost up onto every ancestor run. Only `llm`
  runs get token attributes here; copying the rolled-up totals onto chains would
  count each call once per ancestor.
- IDs are derived deterministically: the trace ID is the LangSmith trace UUID, and
  a span ID is a hash of the run UUID. Re-running an import rewrites the same rows
  instead of duplicating them.
"""

import hashlib
import json
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

IMPORT_SOURCE = "langsmith"
MAX_STATUS_MESSAGE = 1000

# LangSmith run_type -> OpenInference span kind. Unknown types fall back to CHAIN.
SPAN_KINDS = {
    "llm": "LLM",
    "tool": "TOOL",
    "retriever": "RETRIEVER",
    "embedding": "EMBEDDING",
    "chain": "CHAIN",
    "prompt": "CHAIN",
    "parser": "CHAIN",
}
# Metadata keys LangChain and LangGraph use for a conversation ID, in priority order.
SESSION_KEYS = ("session_id", "thread_id", "conversation_id")

STATUS_UNSET, STATUS_OK, STATUS_ERROR = 0, 1, 2

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


@dataclass
class Span:
    trace_id: bytes
    span_id: bytes
    parent_span_id: bytes | None
    name: str
    start_ns: int
    end_ns: int
    status_code: int
    status_message: str = ""
    attributes: dict[str, Any] = field(default_factory=dict)


def trace_id_for(trace_uuid: str) -> bytes:
    """The LangSmith trace UUID is 16 bytes, exactly an OTel trace ID."""
    return uuid.UUID(trace_uuid).bytes


def span_id_for(run_uuid: str) -> bytes:
    """A stable 8-byte span ID derived from the 16-byte LangSmith run UUID."""
    digest = hashlib.sha256(uuid.UUID(run_uuid).bytes).digest()
    return digest[:8] if any(digest[:8]) else digest[8:16]


def _nanos(moment: datetime) -> int:
    return (moment - _EPOCH) // timedelta(microseconds=1) * 1000


def _json(value: Any) -> str:
    return value if isinstance(value, str) else json.dumps(value, default=str)


def _metadata(run: dict[str, Any]) -> dict[str, Any]:
    extra = run.get("extra") or {}
    metadata = extra.get("metadata") if isinstance(extra, dict) else None
    return metadata if isinstance(metadata, dict) else {}


def _model_name(run: dict[str, Any], metadata: dict[str, Any]) -> str | None:
    extra = run.get("extra") or {}
    params = extra.get("invocation_params") if isinstance(extra, dict) else None
    params = params if isinstance(params, dict) else {}
    model = params.get("model") or params.get("model_name") or metadata.get("ls_model_name")
    return str(model) if model else None


def _span_kind(run: dict[str, Any], metadata: dict[str, Any]) -> str:
    # Deep Agents / LangGraph sub-agents are chain runs named after the agent.
    agent_name = metadata.get("lc_agent_name")
    if run.get("run_type") == "chain" and agent_name and run.get("name") == agent_name:
        return "AGENT"
    return SPAN_KINDS.get(str(run.get("run_type") or "").lower(), "CHAIN")


def _output_value(outputs: Any) -> Any:
    # LangSmith wraps plain tool / function results as {"output": value}.
    if isinstance(outputs, dict) and set(outputs) == {"output"}:
        return outputs["output"]
    return outputs


def _token_attributes(run: dict[str, Any]) -> dict[str, int]:
    attrs: dict[str, int] = {}
    prompt, completion = run.get("prompt_tokens"), run.get("completion_tokens")
    if prompt is not None:
        attrs["llm.token_count.prompt"] = int(prompt)
    if completion is not None:
        attrs["llm.token_count.completion"] = int(completion)
    if prompt is not None or completion is not None:
        attrs["llm.token_count.total"] = int(prompt or 0) + int(completion or 0)

    details = run.get("prompt_token_details")
    if isinstance(details, dict):
        if details.get("cache_read"):
            attrs["llm.token_count.prompt_details.cache_read"] = int(details["cache_read"])
        write_5m = int(details.get("ephemeral_5m_input_tokens") or 0)
        write_1h = int(details.get("ephemeral_1h_input_tokens") or 0)
        cache_write = max(int(details.get("cache_creation") or 0), write_5m + write_1h)
        if cache_write:
            attrs["llm.token_count.prompt_details.cache_write"] = cache_write
        if write_1h:
            attrs["llm.token_count.prompt_details.cache_write_1h"] = write_1h

    completion_details = run.get("completion_token_details")
    if isinstance(completion_details, dict) and completion_details.get("reasoning"):
        attrs["llm.token_count.completion_details.reasoning"] = int(completion_details["reasoning"])
    return attrs


def run_to_span(run: dict[str, Any], *, use_langsmith_cost: bool = False) -> Span:
    """Convert one normalized LangSmith run (see readers.normalize_run) to a span."""
    metadata = _metadata(run)
    kind = _span_kind(run, metadata)
    start = run["start_time"]
    end = run.get("end_time") or start
    error = run.get("error")

    attrs: dict[str, Any] = {"openinference.span.kind": kind}
    if run.get("inputs") is not None:
        attrs["input.value"] = _json(run["inputs"])
        attrs["input.mime_type"] = "application/json"
    output = _output_value(run.get("outputs"))
    if output is not None and output != {}:
        attrs["output.value"] = _json(output)
        attrs["output.mime_type"] = "text/plain" if isinstance(output, str) else "application/json"

    if kind == "LLM":
        model = _model_name(run, metadata)
        if model:
            attrs["llm.model_name"] = model
        if metadata.get("ls_provider"):
            attrs["llm.provider"] = str(metadata["ls_provider"])
        attrs.update(_token_attributes(run))
        if use_langsmith_cost and run.get("total_cost") is not None:
            attrs["llm.cost.total"] = float(run["total_cost"])
    elif kind == "TOOL":
        attrs["tool.name"] = str(run.get("name") or "")

    session_id = next((metadata[k] for k in SESSION_KEYS if metadata.get(k)), None)
    if session_id:
        attrs["session.id"] = str(session_id)
    if metadata.get("user_id"):
        attrs["user.id"] = str(metadata["user_id"])

    span_metadata = {
        **metadata,
        "import.source": IMPORT_SOURCE,
        "langsmith.run_id": run["id"],
        "langsmith.project_id": run.get("session_id"),
    }
    if run.get("tags"):
        span_metadata["langsmith.tags"] = run["tags"]
    if run.get("feedback_stats"):
        span_metadata["langsmith.feedback"] = run["feedback_stats"]
    if error:
        span_metadata["error"] = str(error)
    if run.get("end_time") is None:
        span_metadata["langsmith.incomplete"] = True
    attrs["traceroot.span.metadata"] = _json(span_metadata)

    if not run.get("parent_run_id"):
        trace_metadata = {
            "import.source": IMPORT_SOURCE,
            "langsmith.trace_id": run["trace_id"],
            "langsmith.project_id": run.get("session_id"),
        }
        if run.get("feedback_stats"):
            trace_metadata["langsmith.feedback"] = run["feedback_stats"]
        attrs["traceroot.trace.metadata"] = _json(trace_metadata)

    if error:
        # LangSmith appends the traceback to the exception repr, often on the same line.
        summary = str(error).split("Traceback (most recent call last)")[0].strip()
        lines = (summary or str(error)).splitlines()
        status, message = STATUS_ERROR, lines[0][:MAX_STATUS_MESSAGE] if lines else ""
    elif run.get("end_time") is None:
        status, message = STATUS_UNSET, ""
    else:
        status, message = STATUS_OK, ""

    return Span(
        trace_id=trace_id_for(run["trace_id"]),
        span_id=span_id_for(run["id"]),
        parent_span_id=span_id_for(run["parent_run_id"]) if run.get("parent_run_id") else None,
        name=str(run.get("name") or run.get("run_type") or "run"),
        start_ns=_nanos(start),
        end_ns=_nanos(end),
        status_code=status,
        status_message=message,
        attributes=attrs,
    )
