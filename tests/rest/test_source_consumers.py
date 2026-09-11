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

# Individual readers that MUST NOT filter by source, in files whose other scans are
# judged one by one. Keyed (file, function); every other function in the file is
# still checked.
ALLOW_UNFILTERED_METHODS = {
    ("rest/services/trace_reader.py", "_evaluation_exclusion"): (
        "NOT IN subquery: it can only remove rows from the guarded scan it is ANDed into"
    ),
    ("rest/services/trace_reader.py", "get_trace_start_time"): (
        "retention gate keyed by trace_id; reached through a trace get_trace already scoped"
    ),
    ("rest/services/trace_reader.py", "get_trace_spans_io"): (
        "per-span I/O keyed by trace_id; reached through a trace get_trace already scoped"
    ),
    ("rest/services/trace_reader.py", "get_span_io"): (
        "per-span I/O keyed by trace_id + span_id; reached through a trace get_trace already scoped"
    ),
}

SCAN = re.compile(r"FROM\s+(spans|traces)\b")
DEF = re.compile(r"^[ \t]*(?:async\s+)?def\s+(\w+)\s*\(", re.MULTILINE)


def _enclosing_function(text: str, pos: int) -> tuple[str, int] | None:
    """Name and start offset of the innermost `def` above ``pos``, if any."""
    last = None
    for m in DEF.finditer(text, 0, pos):
        last = m
    return (last.group(1), last.start()) if last else None


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
    r"customer_traffic_only\(|source = 'user'"
    r"|\{span_where\}|\{trace_where\}|\{inner_where\}"
)

# A WHERE clause (or source predicate) assembled in Python inside the reader itself.
# It counts as a guard only when the enclosing function has already called
# customer_traffic_only() above the scan — i.e. the clause it builds carries it.
BUILT_WHERE = re.compile(r"\{\w*(?:where|source)\w*\}")

# A spans scan narrowed to trace ids taken from another query: a CTE this test
# judges on its own scan, or an id list the caller already resolved through one.
# Such a scan cannot widen the set of traces beyond what produced the ids.
NARROWED = re.compile(
    r"trace_id IN \(?(?:SELECT trace_id FROM \w+|\{\{?trace_ids:Array\(String\)\}\}?)\)?"
)


def _is_guarded(text: str, scan: re.Match) -> bool:
    # The window stops at the next scan: a predicate belongs to the statement it is
    # in, and a `WHERE {where_clause}` must not be credited with the `trace_id IN
    # (...)` of the spans subquery that follows it.
    following = SCAN.search(text, scan.end())
    window_end = min(scan.end() + GUARD_WINDOW, following.start() if following else len(text))
    if GUARD.search(text, scan.end(), window_end):
        return True
    if NARROWED.search(text, scan.end(), window_end):
        return True
    if BUILT_WHERE.search(text, scan.end(), window_end):
        enclosing = _enclosing_function(text, scan.start())
        return (
            enclosing is not None and "customer_traffic_only(" in text[enclosing[1] : scan.start()]
        )
    return False


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
            enclosing = _enclosing_function(text, match.start())
            if enclosing and (rel, enclosing[0]) in ALLOW_UNFILTERED_METHODS:
                continue
            if not _is_guarded(text, match):
                line = text.count("\n", 0, match.start()) + 1
                unclassified.append(f"{rel}:{line}")
    assert not unclassified, (
        "Unclassified spans/traces reads (add customer_traffic_only() next to the query, "
        "or an ALLOW_UNFILTERED / ALLOW_UNFILTERED_METHODS entry with a reason): "
        + ", ".join(sorted(unclassified))
    )


def test_method_exemptions_name_real_functions():
    """An exemption for a renamed or deleted function would silently exempt nothing —
    and the renamed reader would then be judged, which is right — but a stale entry
    still misdescribes the allowlist, so keep it honest."""
    for rel, name in ALLOW_UNFILTERED_METHODS:
        text = (BACKEND / rel).read_text()
        assert re.search(rf"^[ \t]*def {name}\(", text, re.MULTILINE), f"{rel} has no {name}()"


def test_built_where_is_only_a_guard_when_the_method_calls_customer_traffic_only():
    """The classifier's own behaviour, pinned: a `{where_clause}` scan is guarded
    exactly when customer_traffic_only() appears earlier in the same function."""
    guarded = (
        "def reader(self):\n"
        "    conditions = [customer_traffic_only('t')]\n"
        "    where_clause = ' AND '.join(conditions)\n"
        "    q = f'SELECT 1 FROM traces AS t WHERE {where_clause}'\n"
    )
    unguarded = guarded.replace("customer_traffic_only('t')", "'t.project_id = 1'")
    assert _is_guarded(guarded, SCAN.search(guarded))
    assert not _is_guarded(unguarded, SCAN.search(unguarded))


def test_no_reader_uses_the_fail_open_inequality():
    offenders = [
        str(p.relative_to(BACKEND))
        for p in _py_files()
        if "!= 'detector'" in p.read_text() or '!= "detector"' in p.read_text()
    ]
    assert not offenders, f"fail-open source predicate in: {offenders}"
