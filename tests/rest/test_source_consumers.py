"""Every ClickHouse spans/traces read in the backend is either a customer read guarded by
customer_traffic_only(), or on the explicit allowlist of intentionally unfiltered readers.

Adding a new unfiltered `FROM spans` / `FROM traces` fails this test until it is classified.
"""

import re
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[2] / "backend"

# Readers that MUST NOT filter by source, and why.
ALLOW_UNFILTERED = {
    "rest/routers/internal/usage.py": "billing totals count every stored row (747562e2)",
    "rest/routers/live.py": "per-trace liveness keyed by trace_id; cannot cross sources",
    "worker/ingest_tasks.py": "write path",
    "worker/detector_tasks.py": "judge read; scoped by its own 'user' allowlist (Task 3)",
    "rest/services/trace_reader.py": "get_trace opts into an internal source by name; list reads use customer_traffic_only()",
    "rest/routers/internal/ingest.py": "write path",
    "rest/routers/internal/detectors.py": (
        "internal-secret-gated reads keyed on a specific trace_id/project_id for the "
        "detector run pipeline (spans-jsonl feeds the judge's LLM context; "
        "time-since-last-span is the eval-debounce check); enqueue only ever targets "
        "'user'-source traces (Task 3), and neither result reaches a customer surface"
    ),
    "rest/services/filters/columns.py": (
        "no actual query here — a comment on the SPAN_MEMBERSHIP enum member "
        "documents the shape of the scan that filters/translate.py builds"
    ),
    "rest/services/filters/translate.py": (
        "_span_semijoin's t.trace_id IN (...) is unconditionally ANDed into "
        "TraceReaderService.list_traces's own conditions, which always appends "
        "customer_traffic_only() (trace_reader.py:227); the semijoin can only "
        "narrow that outer query's result set, never expand it, so it never needs "
        "its own source predicate — it has no other caller (only list_traces "
        "imports build_conditions)"
    ),
}

SCAN = re.compile(r"FROM\s+(spans|traces)\b")


def _py_files():
    for p in BACKEND.rglob("*.py"):
        if "tests" in p.parts or "migrations" in p.parts:
            continue
        yield p


def test_every_spans_or_traces_reader_is_classified():
    unclassified = []
    for path in _py_files():
        text = path.read_text()
        if not SCAN.search(text):
            continue
        rel = str(path.relative_to(BACKEND))
        if rel in ALLOW_UNFILTERED:
            continue
        if "customer_traffic_only(" in text or "source = 'user'" in text:
            continue
        unclassified.append(rel)
    assert not unclassified, (
        "Unclassified spans/traces readers (add customer_traffic_only() or an ALLOW_UNFILTERED entry with a reason): "
        + ", ".join(sorted(unclassified))
    )


def test_no_reader_uses_the_fail_open_inequality():
    offenders = [
        str(p.relative_to(BACKEND))
        for p in _py_files()
        if "!= 'detector'" in p.read_text() or '!= "detector"' in p.read_text()
    ]
    assert not offenders, f"fail-open source predicate in: {offenders}"
