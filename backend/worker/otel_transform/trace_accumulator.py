"""Trace record accumulation for OTEL transform."""

import json
from typing import Any

from .metadata import serialize_io
from .parsing import extract_session_id, extract_user_id
from .span_builder import SpanContext


class TraceAccumulator:
    """Collect trace-level records and root/child propagated trace attributes."""

    def __init__(self, project_id: str):
        self._project_id = project_id
        self._traces: dict[str, dict[str, Any]] = {}
        self._trace_attrs: dict[str, dict[str, str | None]] = {}

    def _update_trace_attrs(
        self,
        trace_id: str,
        parent_span_id: str | None,
        span_attrs: dict[str, Any],
    ) -> None:
        span_user_id = extract_user_id(span_attrs)
        span_session_id = extract_session_id(span_attrs)

        if trace_id not in self._trace_attrs:
            self._trace_attrs[trace_id] = {"user_id": None, "session_id": None}

        if not parent_span_id:
            self._trace_attrs[trace_id]["user_id"] = (
                span_user_id or self._trace_attrs[trace_id]["user_id"]
            )
            self._trace_attrs[trace_id]["session_id"] = (
                span_session_id or self._trace_attrs[trace_id]["session_id"]
            )
            return

        self._trace_attrs[trace_id]["user_id"] = (
            self._trace_attrs[trace_id]["user_id"] or span_user_id
        )
        self._trace_attrs[trace_id]["session_id"] = (
            self._trace_attrs[trace_id]["session_id"] or span_session_id
        )

    def consume(self, context: SpanContext) -> None:
        self._update_trace_attrs(context.trace_id, context.parent_span_id, context.span_attrs)
        if context.parent_span_id:
            return

        trace_record: dict[str, Any] = {
            "trace_id": context.trace_id,
            "project_id": self._project_id,
            "trace_start_time": context.start_time,
            "name": context.span_name,
            "user_id": self._trace_attrs[context.trace_id]["user_id"],
            "session_id": self._trace_attrs[context.trace_id]["session_id"],
        }

        git_ref = context.span_attrs.get("traceroot.git.ref")
        git_repo = context.span_attrs.get("traceroot.git.repo")
        if git_ref is not None:
            trace_record["git_ref"] = git_ref
        if git_repo is not None:
            trace_record["git_repo"] = git_repo

        trace_metadata = context.span_attrs.get("traceroot.trace.metadata")
        if trace_metadata is not None:
            trace_record["metadata"] = (
                json.dumps(trace_metadata)
                if not isinstance(trace_metadata, str)
                else trace_metadata
            )

        serialized_input = serialize_io(context.span_input)
        serialized_output = serialize_io(context.span_output)
        if serialized_input is not None:
            trace_record["input"] = serialized_input
        if serialized_output is not None:
            trace_record["output"] = serialized_output

        self._traces[context.trace_id] = trace_record

    def finalize(self) -> list[dict[str, Any]]:
        for trace_id, attrs in self._trace_attrs.items():
            if trace_id not in self._traces:
                continue
            if attrs["user_id"] and not self._traces[trace_id].get("user_id"):
                self._traces[trace_id]["user_id"] = attrs["user_id"]
            if attrs["session_id"] and not self._traces[trace_id].get("session_id"):
                self._traces[trace_id]["session_id"] = attrs["session_id"]
        return list(self._traces.values())
