"""Reusable OTEL payload builders for tests.

These builders create valid OTEL JSON structures (camelCase format)
matching what the transformer expects.
"""

import base64


def encode_id(hex_id: str) -> str:
    """Encode hex ID to base64 (OTLP wire format)."""
    return base64.b64encode(bytes.fromhex(hex_id)).decode()


def make_attr(key: str, value) -> dict:
    """Build an OTEL attribute entry."""
    if isinstance(value, bool):
        return {"key": key, "value": {"boolValue": value}}
    elif isinstance(value, str):
        return {"key": key, "value": {"stringValue": value}}
    elif isinstance(value, int):
        return {"key": key, "value": {"intValue": str(value)}}
    elif isinstance(value, float):
        return {"key": key, "value": {"doubleValue": value}}
    return {"key": key, "value": {"stringValue": str(value)}}


def make_span(
    trace_id_hex: str,
    span_id_hex: str,
    name: str = "test-span",
    parent_span_id_hex: str | None = None,
    start_nanos: int = 1705320000000000000,
    end_nanos: int = 1705320001000000000,
    attributes: list[dict] | None = None,
    status_code: int = 0,
) -> dict:
    """Build a single OTEL span dict."""
    span = {
        "traceId": encode_id(trace_id_hex),
        "spanId": encode_id(span_id_hex),
        "name": name,
        "startTimeUnixNano": str(start_nanos),
        "endTimeUnixNano": str(end_nanos),
        "attributes": attributes or [],
        "status": {"code": status_code},
    }
    if parent_span_id_hex:
        span["parentSpanId"] = encode_id(parent_span_id_hex)
    return span


def make_otel_payload(
    spans: list[dict], scope_name: str = "openinference.instrumentation.test"
) -> dict:
    """Wrap span dicts into a full OTEL resourceSpans payload."""
    return {
        "resourceSpans": [
            {
                "resource": {"attributes": []},
                "scopeSpans": [{"scope": {"name": scope_name}, "spans": spans}],
            }
        ]
    }


# ── Evaluation-trace (SDK-shaped) builders ──────────────────────────────
#
# These mirror the REAL attribute keys the Python SDK stamps on an evaluation
# run's spans (traceroot-py `feat/offline-eval-sdk`, engine.py `_set_root_attrs`
# and the task/scorer child stampers) so backend contract tests exercise the
# actual cross-surface payload shape rather than an independently invented one.
# Source of truth for the key names: offline-eval/contract-notes/eval-trace-attributes.md.


def eval_root_attributes(
    *,
    run_id: str | None = "run_platform_1",
    local_run_id: str = "run_01JLOCALULID",
    dataset_id: str | None = "ds_1",
    dataset_version_id: str | None = "dsv_1",
    dataset_name: str = "billing-routing",
    name: str = "billing-routing",
    case_id: str = "tc_1",
    candidate_version: str | None = "cand_42",
    source_trace_id: str | None = "tr_src_1",
    source_span_id: str | None = "sp_src_1",
    score_target_span_id: str | None = "sp_scored_1",
    has_expected: bool = True,
) -> list[dict]:
    """The full identity attribute set on an evaluation-item root span.

    Optional fields (run_id, dataset_id, dataset_version_id, candidate_version,
    source ids, score_target_span_id) are omitted when passed None — the SDK's
    ``set_span_attribute`` no-ops on None, so they appear only when known.
    """
    attrs = [
        make_attr("traceroot.span.type", "evaluation"),
        make_attr("traceroot.eval.contract_version", "1"),
        make_attr("traceroot.environment", "evaluation"),
        make_attr("traceroot.eval.environment", "evaluation"),
        make_attr("traceroot.eval.name", name),
        make_attr("traceroot.eval.run_name", name),
        make_attr("traceroot.eval.dataset_name", dataset_name),
        make_attr("traceroot.eval.case_id", case_id),
        make_attr("traceroot.eval.has_expected", has_expected),
    ]
    optional = {
        "traceroot.eval.dataset_id": dataset_id,
        "traceroot.eval.dataset_version_id": dataset_version_id,
        "traceroot.eval.candidate_version": candidate_version,
        "traceroot.eval.run_id": run_id,
        "traceroot.eval.local_run_id": local_run_id,
        "traceroot.eval.source_trace_id": source_trace_id,
        "traceroot.eval.source_span_id": source_span_id,
        "traceroot.eval.score_target_span_id": score_target_span_id,
    }
    for key, value in optional.items():
        if value is not None:
            attrs.append(make_attr(key, value))
    return attrs


def make_eval_trace(
    trace_id_hex: str,
    root_span_id_hex: str = "bb" * 8,
    task_span_id_hex: str = "cc" * 8,
    scorer_span_id_hex: str = "dd" * 8,
    *,
    name: str = "billing-routing",
    case_id: str = "tc_1",
    scorer_name: str = "helpfulness",
    **root_attr_overrides,
) -> dict:
    """A full SDK-shaped evaluation trace: an evaluation-item root with a nested
    ``task`` (candidate) span and a sibling ``scorer`` span — the structure the SDK
    emits for one reported test case."""
    root = make_span(
        trace_id_hex,
        root_span_id_hex,
        name="evaluation-item",
        attributes=eval_root_attributes(name=name, case_id=case_id, **root_attr_overrides),
    )
    task = make_span(
        trace_id_hex,
        task_span_id_hex,
        name="task",
        parent_span_id_hex=root_span_id_hex,
        attributes=[
            make_attr("traceroot.span.type", "task"),
            make_attr("traceroot.eval.task_name", "task"),
            make_attr("traceroot.eval.case_id", case_id),
            make_attr("traceroot.eval.run_name", name),
        ],
    )
    scorer = make_span(
        trace_id_hex,
        scorer_span_id_hex,
        name=scorer_name,
        parent_span_id_hex=root_span_id_hex,
        attributes=[
            make_attr("traceroot.span.type", "scorer"),
            make_attr("traceroot.eval.scorer_name", scorer_name),
            make_attr("traceroot.eval.score_value", 0.9),
            make_attr("traceroot.eval.run_name", name),
        ],
    )
    return make_otel_payload([root, task, scorer])
