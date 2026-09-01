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

# WHERE-clause placeholders whose builder applies customer_traffic_only() for the
# caller. trace_discovery._window_scan is the only such builder today; if another
# appears, add its placeholder here AND assert the builder guards, below.
GUARDED_WHERE_BUILDERS = {"_window_scan"}


def test_guarded_where_builders_still_guard():
    """The placeholders GUARD accepts are only safe while their builder guards.

    GUARD treats `{span_where}` and friends as satisfying the source check. That
    is true exactly as long as the builder that fills them appends
    customer_traffic_only(); this pins that, so removing it there fails here
    rather than silently unguarding every query the builder feeds.
    """
    text = (BACKEND / "rest/services/trace_discovery.py").read_text()
    for builder in GUARDED_WHERE_BUILDERS:
        start = text.index(f"def {builder}(")
        end = text.index("\ndef ", start + 1)
        assert "customer_traffic_only()" in text[start:end], (
            f"{builder} no longer applies customer_traffic_only(); "
            "every query using its placeholder is now unguarded"
        )


def _py_files():
    for p in BACKEND.rglob("*.py"):
        if "tests" in p.parts or "migrations" in p.parts:
            continue
        yield p


# How far past a `FROM spans|traces` a guard may appear and still be counted as
# guarding it. Query text between the FROM and its predicates; a guard further
# away than this belongs to a different statement.
GUARD_WINDOW = 1200

# A guard counts when it is literal in the query, or when the WHERE clause is a
# placeholder filled by a builder that applies one. Named builders are listed
# rather than matched loosely: an unrecognised placeholder must still fail.
GUARD = re.compile(
    r"customer_traffic_only\(|source = 'user'|DETECTOR_TARGET_SOURCE_SQL"
    r"|\{span_where\}|\{trace_where\}|\{inner_where\}"
)


def test_every_spans_or_traces_reader_is_classified():
    """Each scan is judged on its own guard, not on the file containing one somewhere.

    Checking file-wide string presence would let a file that already has one
    guarded query gain a second unguarded one and still pass — exactly the case
    this test exists to catch.
    """
    unclassified = []
    for path in _py_files():
        text = path.read_text()
        rel = str(path.relative_to(BACKEND))
        if rel in ALLOW_UNFILTERED:
            continue
        for match in SCAN.finditer(text):
            if not GUARD.search(text, match.end(), match.end() + GUARD_WINDOW):
                line = text.count("\n", 0, match.start()) + 1
                unclassified.append(f"{rel}:{line}")
    assert not unclassified, (
        "Unclassified spans/traces reads (add customer_traffic_only() next to the query, "
        "or an ALLOW_UNFILTERED entry for the file with a reason): "
        + ", ".join(sorted(unclassified))
    )


def test_no_reader_uses_the_fail_open_inequality():
    offenders = [
        str(p.relative_to(BACKEND))
        for p in _py_files()
        if "!= 'detector'" in p.read_text() or '!= "detector"' in p.read_text()
    ]
    assert not offenders, f"fail-open source predicate in: {offenders}"
