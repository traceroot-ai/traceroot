"""Every ClickHouse spans/traces read in the backend is either a customer read guarded by
customer_traffic_only(), or on the explicit allowlist of intentionally unfiltered readers.

Adding a new unfiltered `FROM spans` / `FROM traces` fails this test until it is classified.
"""

import ast
import io
import re
import tokenize
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
# judged one by one. Keyed (file, scope) where a scope is a function name or, for
# query text assembled at import time, the module-level constant holding it; every
# other scope in the file is still checked.
ALLOW_UNFILTERED_METHODS = {
    ("rest/services/sql/schema.py", "VIEW_EVALUATION_EXCLUSION"): (
        "NOT IN subquery spliced into each public view body, which filters "
        "source = 'user' itself (012_create_public_sql_views.sql); it can only "
        "remove rows from that guarded scan"
    ),
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
ASSIGN = re.compile(r"^([A-Z_][A-Z0-9_]*)\s*(?::[^=\n]+)?=", re.MULTILINE)


def prose_blanked(text: str) -> str:
    """``text`` with comments and docstrings replaced by spaces of the same length.

    A module that explains what SQL it rewrites quotes that SQL — the SQL gateway's
    rewriter and validator describe ``FROM spans`` a dozen times in comments and
    docstrings. Scanning prose would force an allowlist entry for a file that issues
    no query at all, which is the opposite of what the allowlist is for: it would
    then also wave through a real unguarded query added to that file later.
    Positions are preserved so reported line numbers stay true.
    """

    out = list(text)

    def blank(start_line: int, start_col: int, end_line: int, end_col: int) -> None:
        offsets = _line_offsets(text)
        start = offsets[start_line - 1] + start_col
        end = offsets[end_line - 1] + end_col
        for i in range(start, min(end, len(out))):
            if out[i] != "\n":
                out[i] = " "

    try:
        for tok in tokenize.generate_tokens(io.StringIO(text).readline):
            if tok.type == tokenize.COMMENT:
                blank(tok.start[0], tok.start[1], tok.end[0], tok.end[1])
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return text  # unparseable: scan it whole rather than skip anything

    try:
        tree = ast.parse(text)
    except SyntaxError:
        return "".join(out)
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        first = node.body[0] if node.body else None
        if (
            isinstance(first, ast.Expr)
            and isinstance(first.value, ast.Constant)
            and isinstance(first.value.value, str)
            and first.end_lineno is not None
            and first.end_col_offset is not None
        ):
            blank(first.lineno, first.col_offset, first.end_lineno, first.end_col_offset)
    return "".join(out)


def _line_offsets(text: str) -> list[int]:
    offsets = [0]
    for line in text.splitlines(keepends=True):
        offsets.append(offsets[-1] + len(line))
    return offsets


def _enclosing_function(text: str, pos: int) -> tuple[str, int] | None:
    """Name and start offset of the innermost `def` above ``pos``, if any.

    Falls back to the module-level constant being assigned, so query text built at
    import time is judged as its own scope rather than as whatever function happens
    to sit above it.
    """
    last = None
    for m in DEF.finditer(text, 0, pos):
        last = m
    assigned = None
    for m in ASSIGN.finditer(text, 0, pos):
        assigned = m
    if assigned and (last is None or assigned.start() > last.start()):
        return (assigned.group(1), assigned.start())
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
        text = prose_blanked(path.read_text())
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
    """An exemption for a renamed or deleted scope would silently exempt nothing —
    and the renamed reader would then be judged, which is right — but a stale entry
    still misdescribes the allowlist, so keep it honest."""
    for rel, name in ALLOW_UNFILTERED_METHODS:
        text = (BACKEND / rel).read_text()
        is_function = re.search(rf"^[ \t]*(?:async\s+)?def {name}\(", text, re.MULTILINE)
        is_constant = re.search(rf"^{name}\s*(?::[^=\n]+)?=", text, re.MULTILINE)
        assert is_function or is_constant, f"{rel} has no {name}"


def test_prose_is_skipped_but_a_real_query_beside_it_is_not():
    """Blanking prose must not blank the module: a file that talks about `FROM spans`
    in a docstring and a comment, and then issues one, still reports the query."""
    module = (
        '''"""Explains the rewrite of ``SELECT * FROM spans`` into a view call."""
'''
        "\n"
        "# A quoted example: FROM traces AS t\n"
        "def reader():\n"
        '    """Docstring mentioning FROM spans again."""\n'
        "    return 'SELECT 1 FROM spans WHERE project_id = %s'\n"
    )
    blanked = prose_blanked(module)
    hits = [m.start() for m in SCAN.finditer(blanked)]
    assert len(hits) == 1, f"expected only the real query to survive, got {len(hits)}"
    # Offsets are preserved, so the line number reported for it is still right.
    assert blanked.count("\n", 0, hits[0]) + 1 == 6
    assert not _is_guarded(blanked, SCAN.search(blanked))


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
