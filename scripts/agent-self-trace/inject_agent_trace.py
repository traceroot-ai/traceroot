"""Inject a synthetic source='agent' trace through the internal ingest route.

Test fixture for the milestones where nothing emits yet: after the ingest PR lands,
any surface that reads agent traces can be exercised without the agent service, the
SDK, or an LLM key.

    uv run python scripts/agent-self-trace/inject_agent_trace.py <project_id> [trace_id]
"""

import os
import sys
import time
import urllib.request
from pathlib import Path

from opentelemetry.proto.common.v1 import common_pb2
from opentelemetry.proto.resource.v1 import resource_pb2
from opentelemetry.proto.trace.v1 import trace_pb2

BASE = os.environ.get("BACKEND_INTERNAL_URL", "http://localhost:8000")


def _env(key: str) -> str:
    """Read a key from the repo's .env (the launcher generates the secrets there)."""
    for line in (Path(__file__).resolve().parents[2] / ".env").read_text().splitlines():
        if line.startswith(f"{key}="):
            return line.split("=", 1)[1].split(" #")[0].strip().strip("\"'")
    raise SystemExit(f"{key} not found in .env")


def kv(key: str, value: str) -> common_pb2.KeyValue:
    return common_pb2.KeyValue(key=key, value=common_pb2.AnyValue(string_value=value))


def span(name: str, span_id: bytes, trace_id: bytes, parent: bytes | None, attrs: dict) -> object:
    now = time.time_ns()
    return trace_pb2.Span(
        trace_id=trace_id,
        span_id=span_id,
        parent_span_id=parent or b"",
        name=name,
        kind=trace_pb2.Span.SPAN_KIND_INTERNAL,
        start_time_unix_nano=now - 2_000_000_000,
        end_time_unix_nano=now,
        attributes=[kv(k, v) for k, v in attrs.items()],
    )


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    project_id = sys.argv[1]
    trace_hex = (sys.argv[2] if len(sys.argv) > 2 else "a" * 32).lower()
    trace_id = bytes.fromhex(trace_hex)

    root_id, child_id = bytes.fromhex("1111111111111111"), bytes.fromhex("2222222222222222")
    common = {"traceroot.project_id": project_id}

    req_spans = [
        span(
            "rca: Synthetic Detector",
            root_id,
            trace_id,
            None,
            {
                **common,
                "traceroot.span.input": "2 detectors fired on this trace.",
                "traceroot.span.output": "- Root cause: synthetic fixture.",
                "traceroot.span.metadata": '{"kind":"rca","attempt":1}',
            },
        ),
        span("gpt-5.4", child_id, trace_id, root_id, {**common, "gen_ai.request.model": "gpt-5.4"}),
    ]

    payload = trace_pb2.TracesData(
        resource_spans=[
            trace_pb2.ResourceSpans(
                resource=resource_pb2.Resource(attributes=[kv("service.name", "agent")]),
                scope_spans=[trace_pb2.ScopeSpans(spans=req_spans)],
            )
        ]
    ).SerializeToString()

    request = urllib.request.Request(
        f"{BASE}/api/v1/internal/traces?project_id={project_id}",
        data=payload,
        headers={
            "Content-Type": "application/x-protobuf",
            "X-Internal-Secret": _env("INTERNAL_API_SECRET_AGENT"),
        },
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        print(f"HTTP {response.status}  {response.read().decode()[:200]}")
    print(f"injected trace_id={trace_hex} project={project_id}")


if __name__ == "__main__":
    main()
