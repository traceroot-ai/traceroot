"""Live ClickHouse coverage for remote-parent trace replacement semantics."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from shared.trace_identity import TraceRootKind, trace_root_version

from .conftest import _insert, _span

pytestmark = pytest.mark.integration

PROJECT = "remote_parent_precedence"
BASE = datetime(2026, 9, 20, 10, 0, 0, tzinfo=UTC)


def _trace_row(trace_id: str, start: datetime, kind: TraceRootKind, **fields) -> dict:
    is_evaluation = fields.pop("is_evaluation", 0)
    row = {
        "trace_id": trace_id,
        "project_id": PROJECT,
        "trace_start_time": start,
        "name": fields.pop("name", "trace"),
        "user_id": fields.pop("user_id", None),
        "session_id": fields.pop("session_id", None),
        "git_ref": None,
        "git_repo": None,
        "input": fields.pop("input", None),
        "output": fields.pop("output", None),
        "metadata": fields.pop("metadata", None),
        "source": "user",
        "is_evaluation": is_evaluation,
        "root_kind": int(kind),
        "root_version": trace_root_version(kind, start, bool(is_evaluation)),
        "ch_update_time": BASE + timedelta(seconds=fields.pop("updated_seconds", 0)),
    }
    assert not fields
    return row


def _final_trace(client, trace_id: str):
    return client.query(
        """
        SELECT name, toInt8(root_kind), root_version, input, output, is_evaluation
        FROM traces FINAL
        WHERE project_id = {project_id:String} AND trace_id = {trace_id:String}
        """,
        parameters={"project_id": PROJECT, "trace_id": trace_id},
    ).result_rows


def test_root_precedence_and_remote_parent_topology(gateway):
    """FINAL picks logical precedence, not insertion order, and spans keep topology."""
    root_trace = "remote-root-final"
    remote_trace = "remote-earliest-wins"
    late_remote = _trace_row(
        remote_trace,
        BASE + timedelta(minutes=4),
        TraceRootKind.REMOTE_PARENT,
        name="late-callee",
        input="late input",
        updated_seconds=1,
    )
    early_remote = _trace_row(
        remote_trace,
        BASE + timedelta(minutes=3),
        TraceRootKind.REMOTE_PARENT,
        name="early-callee",
        input="early input",
        updated_seconds=2,
    )
    placeholder = _trace_row(
        root_trace,
        BASE + timedelta(minutes=1),
        TraceRootKind.PLACEHOLDER,
        name="child-placeholder",
        input="child input",
    )
    remote = _trace_row(
        root_trace,
        BASE + timedelta(minutes=2),
        TraceRootKind.REMOTE_PARENT,
        name="callee",
        input="callee input",
        output="callee output",
        metadata='{"service":"callee"}',
    )
    root = _trace_row(
        root_trace,
        BASE + timedelta(minutes=3),
        TraceRootKind.ROOT,
        name="caller",
        metadata='{"service":"caller"}',
        is_evaluation=1,
    )
    _insert(gateway.admin, "traces", [late_remote, early_remote, placeholder, remote, root])

    spans = [
        _span(PROJECT, "caller-span", root_trace, BASE + timedelta(minutes=3)),
        _span(
            PROJECT,
            "callee-span",
            root_trace,
            BASE + timedelta(minutes=4),
            parent="caller-span",
        ),
    ]
    _insert(gateway.admin, "spans", spans)

    gateway.admin.command("OPTIMIZE TABLE traces PARTITION '202609' FINAL")
    gateway.admin.command("OPTIMIZE TABLE spans PARTITION '202609' FINAL")

    assert _final_trace(gateway.admin, root_trace) == [
        ("caller", 2, root["root_version"], None, None, 1)
    ]
    assert _final_trace(gateway.admin, remote_trace) == [
        ("early-callee", 1, early_remote["root_version"], "early input", None, 0)
    ]

    parent_rows = gateway.admin.query(
        """
        SELECT span_id, parent_span_id
        FROM spans FINAL
        WHERE project_id = {project_id:String} AND trace_id = {trace_id:String}
        ORDER BY span_id
        """,
        parameters={"project_id": PROJECT, "trace_id": root_trace},
    ).result_rows
    assert parent_rows == [("callee-span", "caller-span"), ("caller-span", None)]
