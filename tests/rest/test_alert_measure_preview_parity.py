"""Drift tests between the alert engine and the TypeScript that restates it.

Neither side can import the other, so several declarations exist twice and
nothing but this file makes them move together.
"""

import re
from pathlib import Path

import pytest

from rest.schemas.alerts import MAX_ALERT_WINDOW_MS, MAX_ALERTS_PER_REQUEST
from rest.services.alert_evaluation import _WIDGET_SOURCE_BY_ALERT_MEASURE
from rest.services.widget_registry import AGGS_NUMBER, REGISTRY

_REPO_ROOT = Path(__file__).resolve().parents[2]

CORE_ALERTS_TS = _REPO_ROOT / "frontend" / "packages" / "core" / "src" / "alerts.ts"
CORE_CONSTANTS_TS = _REPO_ROOT / "frontend" / "packages" / "core" / "src" / "constants.ts"
WORKER_EVALUATOR_CLIENT_TS = (
    _REPO_ROOT / "frontend" / "worker" / "src" / "alerts" / "evaluator-client.ts"
)

_FRONTEND_SOURCES = (CORE_ALERTS_TS, CORE_CONSTANTS_TS, WORKER_EVALUATOR_CLIENT_TS)

_MEASURE_ENTRY_RE = re.compile(
    r"(\w+):\s*\{\s*view:\s*\"(\w+)\"\s*,\s*field:\s*\"(\w+)\"\s*\}",
)
_STRING_LITERAL_RE = re.compile(r"\"([^\"]+)\"")
_WINDOW_ENTRY_RE = re.compile(r"\"(\w+)\"\s*:\s*([\d_]+)")
_MAX_ALERTS_RE = re.compile(r"MAX_ALERTS_PER_REQUEST\s*=\s*(\d+)\s*;")


def _declaration_body(source: str, declaration: str, closer: str) -> str:
    start = source.index(declaration)
    end = source.index(closer, start)
    return source[start:end]


def _parse_measure_source_map() -> dict[str, tuple[str, str]]:
    body = _declaration_body(CORE_ALERTS_TS.read_text(), "const SOURCE_BY_ALERT_MEASURE", "};")
    return {m[1]: (m[2], m[3]) for m in _MEASURE_ENTRY_RE.finditer(body)}


def _parse_engine_number_aggregations() -> list[str]:
    body = _declaration_body(CORE_ALERTS_TS.read_text(), "const ENGINE_NUMBER_AGGREGATIONS", "];")
    return _STRING_LITERAL_RE.findall(body)


def _parse_alert_windows_ms() -> dict[str, int]:
    body = _declaration_body(CORE_CONSTANTS_TS.read_text(), "export const ALERT_WINDOWS", "}")
    return {m[1]: int(m[2].replace("_", "")) for m in _WINDOW_ENTRY_RE.finditer(body)}


def _parse_worker_max_alerts_per_request() -> int:
    match = _MAX_ALERTS_RE.search(WORKER_EVALUATOR_CLIENT_TS.read_text())
    assert match is not None, (
        "MAX_ALERTS_PER_REQUEST is no longer declared as a literal in "
        f"{WORKER_EVALUATOR_CLIENT_TS.name}; the batch cap parity check cannot read it"
    )
    return int(match[1])


def _resolve_alert_metric_source_body() -> str:
    return _declaration_body(
        CORE_ALERTS_TS.read_text(), "export function resolveAlertMetricSource(", "\n}"
    )


requires_frontend = pytest.mark.skipif(
    not all(path.exists() for path in _FRONTEND_SOURCES),
    reason="frontend sources not present in this checkout",
)


# --- The measure map ---


@requires_frontend
def test_backend_and_core_measure_maps_are_identical():
    """A one-sided edit makes the preview promise a number the alert cannot reproduce."""
    core_map = _parse_measure_source_map()
    backend_map = {k: (v.view, v.field) for k, v in _WIDGET_SOURCE_BY_ALERT_MEASURE.items()}
    assert core_map == backend_map


@requires_frontend
def test_the_two_unique_id_measures_route_to_traces_on_both_sides():
    """The one deliberate grain exception: an unfiltered distinct count on traces equals spans."""
    core_map = _parse_measure_source_map()
    for measure, field in (("unique_user_ids", "user_id"), ("unique_session_ids", "session_id")):
        assert core_map[measure] == ("traces", field)
        assert _WIDGET_SOURCE_BY_ALERT_MEASURE[measure] == ("traces", field)


@requires_frontend
def test_the_measure_map_was_actually_parsed():
    core_map = _parse_measure_source_map()
    assert len(core_map) == 10
    assert core_map["count"] == ("spans", "count")


def test_every_mapped_measure_resolves_in_the_widget_registry():
    """The map names engine fields, so a registry rename must fail here, not at evaluation."""
    for measure, source in _WIDGET_SOURCE_BY_ALERT_MEASURE.items():
        view = REGISTRY.get(source.view)
        assert view is not None, f"measure '{measure}' routes to unknown view '{source.view}'"
        assert source.field in view.fields, (
            f"measure '{measure}' reads field '{source.field}', which the "
            f"'{source.view}' view no longer exposes"
        )


# --- The numeric aggregation vocabulary ---


@requires_frontend
def test_the_numeric_aggregation_vocabulary_matches_the_engine():
    """A drifted list makes an aggregation unreachable in the UI or fatal on every tick."""
    core_aggregations = _parse_engine_number_aggregations()
    assert core_aggregations, "ENGINE_NUMBER_AGGREGATIONS parsed as empty"
    assert set(core_aggregations) == set(AGGS_NUMBER)
    # Set equality alone would pass on a list carrying the same name twice.
    assert len(core_aggregations) == len(AGGS_NUMBER)


@requires_frontend
def test_count_stays_out_of_the_numeric_aggregation_vocabulary():
    """`count` is the engine's count(*) sentinel, not count(column)."""
    assert "count" not in _parse_engine_number_aggregations()
    assert "count" not in AGGS_NUMBER


# --- The traces-with-filters refusal ---


@requires_frontend
def test_core_refuses_span_filters_on_a_traces_routed_measure():
    """The grain invariance holds only for an unfiltered distinct count, so both sides refuse."""
    body = _resolve_alert_metric_source_body()
    assert "return null" in body, "resolveAlertMetricSource no longer refuses anything"
    refusal = re.search(
        r"source\.view\s*!==\s*\"spans\"[^\n]*filters\.some\([^\n]*return null",
        body,
    )
    assert refusal is not None, (
        "resolveAlertMetricSource no longer refuses a filtered traces-routed "
        "measure; the backend still does, so the form would offer a rule that "
        "errors on every evaluation"
    )


# --- The batch cap ---


@requires_frontend
def test_the_worker_chunks_against_the_batch_cap_the_api_enforces():
    """The cap is schema-enforced: lowered in Python alone, the worker sends over-cap chunks."""
    assert _parse_worker_max_alerts_per_request() == MAX_ALERTS_PER_REQUEST


# --- The window ceiling ---


@requires_frontend
def test_the_longest_offered_window_is_the_longest_the_engine_accepts():
    """A window token past the ceiling fails evaluation forever while the form offers it."""
    windows_ms = _parse_alert_windows_ms()
    assert "1m" in windows_ms and "2h" in windows_ms, (
        f"ALERT_WINDOWS parsed as {windows_ms}, which is not the window vocabulary"
    )
    assert max(windows_ms.values()) == MAX_ALERT_WINDOW_MS
