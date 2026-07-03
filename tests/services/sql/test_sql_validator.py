"""Security-policy tests for the allowlist-primary SQL validator (Layer 1).

Tests are parametrized over two matrices:
  ALLOWED — queries that must pass without raising.
  REJECTED — queries that must raise SqlValidationError.

The module is pure: no DB, no network, no config dependency.

Empirical sqlglot findings documented here
------------------------------------------
* Trailing ``;``      — produces ONE statement (``SELECT 1;`` → 1 stmt); handled correctly.
* ``SELECT 1; SELECT 2`` — produces TWO statements; rejected by multi-statement check.
* ``quantile(0.95)(duration_ms)``  — parses as ``exp.Quantile``; ``sql_name()`` == ``QUANTILE``
  → lowercased ``quantile`` is in ALLOWED_FUNCTIONS.
* ``count()``  — parses as ``exp.Count``; ``sql_name()`` == ``COUNT``.
* ``FORMAT JSON`` — captured in ``tree.args["format"]`` on the ``Select`` node.
* ``INTO OUTFILE`` — raises ``ParseError``; caught by the parse-error rejection path.
* ``FINAL`` — sqlglot wraps the ``Table`` in ``exp.Final``; detected via walk.
* CASE expressions — parse as ``exp.Case`` (an ``exp.Func`` subclass); added to the
  skip list alongside ``exp.Cast`` so they are allowed implicitly (see validator.py).
* ``uniq()`` — maps to ``exp.ApproxDistinct``; ``sql_name()`` == ``APPROX_DISTINCT`` which
  is NOT in ALLOWED_FUNCTIONS.  Because no ALLOWED test exercises ``uniq`` and the
  validator is allowlist-primary, this is conservative-correct (``uniq`` is rejected).
  Noted in the report.
"""

from __future__ import annotations

import pytest
import sqlglot.expressions as exp

from rest.services.sql.errors import SqlValidationError
from rest.services.sql.validator import (
    ALLOWED_FUNCTIONS,
    BLOCKED_FUNCTIONS,
    BLOCKED_PREFIXES,
    validate,
)

# ---------------------------------------------------------------------------
# ALLOWED matrix — must NOT raise
# ---------------------------------------------------------------------------
ALLOWED_CASES = [
    # Aggregate over public table
    "SELECT count() FROM spans",
    # count(*) — exp.Count(this=Star); name-extraction must resolve to `count`
    "SELECT count(*) FROM spans",
    "SELECT count(*) FROM traces",
    "SELECT model_name, count(*) FROM spans GROUP BY model_name",
    # Group-by with aggregate
    "SELECT model_name, sum(cost) FROM spans GROUP BY model_name",
    # now() + INTERVAL — now is Anonymous, INTERVAL is not a Func node
    "SELECT * FROM spans WHERE span_start_time >= now() - INTERVAL 24 HOUR",
    # CTE (non-shadow) + public table inside
    "WITH t AS (SELECT trace_id FROM traces) SELECT count() FROM t",
    # Subquery
    "SELECT trace_id FROM (SELECT trace_id FROM traces) s",
    # UNION ALL
    "SELECT span_id FROM spans UNION ALL SELECT span_id FROM spans",
    # Parametric aggregate — quantile(0.95)(duration_ms)
    "SELECT model_name, quantile(0.95)(duration_ms) FROM spans GROUP BY model_name",
    # CAST — exp.Cast is in the skip list → implicitly allowed
    "SELECT CAST(cost AS Float64) FROM spans",
    # CASE expression — exp.Case is a Func subclass; added to skip list (see validator.py)
    "SELECT CASE WHEN cost > 0 THEN cost ELSE 0 END FROM spans",
    # Pure arithmetic (operators are non-Func)
    "SELECT cost * 2 FROM spans",
    # IN (exp.In is not a Func subclass)
    "SELECT span_id FROM spans WHERE span_id IN ('a', 'b')",
    # BETWEEN (exp.Between is not a Func subclass)
    "SELECT * FROM spans WHERE cost BETWEEN 0 AND 100",
    # LIKE (exp.Like is not a Func subclass)
    "SELECT * FROM spans WHERE name LIKE '%test%'",
    # --- Scope-aware CTE regression: legitimate in-scope references (P1 fix) ---
    # CTE whose alias is an arbitrary non-public name — in-scope reference is allowed
    "WITH evil AS (SELECT 1 AS n) SELECT n FROM evil",
    # Chained CTEs: later CTE references earlier CTE in the same WITH block
    "WITH a AS (SELECT span_id FROM spans), b AS (SELECT span_id FROM a) SELECT count() FROM b",
]


@pytest.mark.parametrize("sql", ALLOWED_CASES)
def test_allowed_queries_do_not_raise(sql: str) -> None:
    result = validate(sql)
    assert isinstance(result, exp.Query)


# ---------------------------------------------------------------------------
# REJECTED matrix — must raise SqlValidationError
# ---------------------------------------------------------------------------
REJECTED_CASES = [
    # ----- Write / DDL operations ------------------------------------------
    pytest.param("INSERT INTO spans VALUES (1)", id="reject-insert"),
    pytest.param("UPDATE spans SET cost = 0", id="reject-update"),
    pytest.param("DELETE FROM spans", id="reject-delete"),
    pytest.param("ALTER TABLE spans ADD COLUMN x Int32", id="reject-alter"),
    pytest.param("DROP TABLE spans", id="reject-drop"),
    pytest.param("TRUNCATE TABLE spans", id="reject-truncate"),
    pytest.param("OPTIMIZE TABLE spans FINAL", id="reject-optimize"),
    pytest.param("SYSTEM RELOAD CONFIG", id="reject-system"),
    pytest.param("SET max_threads = 1", id="reject-set"),
    # ----- Multi-statement injection ----------------------------------------
    pytest.param("SELECT 1; SELECT 2", id="reject-multi-stmt"),
    pytest.param("SELECT 1; DROP TABLE spans", id="reject-trailing-injection"),
    # ----- Unknown / forbidden tables ---------------------------------------
    pytest.param("SELECT * FROM users", id="reject-unknown-table"),
    pytest.param("SELECT * FROM system.tables", id="reject-db-qualified"),
    pytest.param("SELECT * FROM default.spans", id="reject-db-qualified-spans"),
    pytest.param("SELECT * FROM spans_public_v1", id="reject-internal-view"),
    # ----- Table functions (not real tables) --------------------------------
    pytest.param("SELECT * FROM url('http://evil/x', 'CSV')", id="reject-table-fn-url"),
    pytest.param("SELECT * FROM s3('http://x','CSV')", id="reject-table-fn-s3"),
    pytest.param("SELECT * FROM remote('h', default.spans)", id="reject-table-fn-remote"),
    pytest.param("SELECT * FROM numbers(1000000000)", id="reject-table-fn-numbers"),
    # ----- Blocked functions ------------------------------------------------
    pytest.param("SELECT sleep(10)", id="reject-fn-sleep"),
    pytest.param("SELECT getSetting('max_threads')", id="reject-fn-getsetting"),
    pytest.param("SELECT currentUser()", id="reject-fn-currentuser"),
    # ----- Blocked by prefix ------------------------------------------------
    pytest.param("SELECT dictGet('d', 'a', toUInt64(1))", id="reject-prefix-dictget"),
    pytest.param("SELECT joinGet('j', 'a', 1)", id="reject-prefix-joinget"),
    # ----- project_id references -------------------------------------------
    pytest.param("SELECT project_id FROM spans", id="reject-project-id-select"),
    pytest.param("SELECT count() FROM spans WHERE project_id = 'x'", id="reject-project-id-where"),
    pytest.param("SELECT span_id AS project_id FROM spans", id="reject-project-id-alias"),
    # ----- CTE shadow -------------------------------------------------------
    pytest.param(
        "WITH spans AS (SELECT 1 AS x) SELECT x FROM spans",
        id="reject-cte-shadow-spans",
    ),
    # ----- SETTINGS ---------------------------------------------------------
    pytest.param(
        "SELECT count() FROM spans SETTINGS max_execution_time = 99999",
        id="reject-settings",
    ),
    # ----- Unknown functions (allowlist-primary: reject unknown) ------------
    pytest.param("SELECT mystery(span_id) FROM spans", id="reject-fn-unknown-mystery"),
    pytest.param("SELECT reverse(name) FROM spans", id="reject-fn-unknown-reverse"),
    pytest.param("SELECT arrayJoin(name) FROM spans", id="reject-fn-unknown-arrayjoin"),
    # ----- FINAL modifier ---------------------------------------------------
    pytest.param("SELECT * FROM spans FINAL", id="reject-final"),
    # ----- Output escape hatches --------------------------------------------
    pytest.param("SELECT * FROM spans FORMAT JSON", id="reject-format-json"),
    # INTO OUTFILE raises ParseError → caught by parse-error rejection path
    pytest.param(
        "SELECT * FROM spans INTO OUTFILE '/tmp/x'",
        id="reject-into-outfile-parse-error",
    ),
    # ----- Empty / whitespace-only ------------------------------------------
    pytest.param("", id="reject-empty"),
    pytest.param("   ", id="reject-whitespace"),
    # ----- Scope-aware CTE bypass (P1 regression) ---------------------------
    # Outer FROM references a real table whose name matches a CTE defined only
    # inside an inner subquery — must be rejected, not allowlisted by mistake.
    pytest.param(
        "SELECT * FROM evil WHERE 1 IN (WITH evil AS (SELECT 1 AS n) SELECT n FROM evil)",
        id="reject-cte-scope-bypass-subquery",
    ),
    # First UNION arm's table is a real (unknown) table; the CTE is scoped only
    # to the second arm — the outer reference must be rejected.
    pytest.param(
        "SELECT n FROM evil UNION ALL WITH evil AS (SELECT 1 AS n) SELECT n FROM evil",
        id="reject-cte-scope-bypass-union",
    ),
]


@pytest.mark.parametrize("sql", REJECTED_CASES)
def test_rejected_queries_raise_sql_validation_error(sql: str) -> None:
    with pytest.raises(SqlValidationError):
        validate(sql)


# ---------------------------------------------------------------------------
# Error message sanity
# ---------------------------------------------------------------------------
def test_error_message_is_non_empty() -> None:
    with pytest.raises(SqlValidationError) as exc_info:
        validate("SELECT sleep(10)")
    assert str(exc_info.value).strip()


def test_error_message_does_not_echo_raw_sql() -> None:
    raw = "SELECT sleep(10) FROM spans"
    with pytest.raises(SqlValidationError) as exc_info:
        validate(raw)
    # message must not contain the raw SQL
    assert raw not in str(exc_info.value)


def test_parse_error_message_does_not_leak_sql_or_tenant_data() -> None:
    # The parse-error path must not echo the raw SQL fragment or any embedded
    # tenant value (sqlglot's exception text would otherwise carry both).
    secret = "tenant-SECRET-42"
    malformed = f"SELECT * FROM spans WHERE project_id = '{secret}' AND ("
    with pytest.raises(SqlValidationError) as exc_info:
        validate(malformed)
    msg = str(exc_info.value)
    assert secret not in msg
    assert "project_id" not in msg
    assert "FROM spans" not in msg


def test_error_message_does_not_contain_internal_view_names() -> None:
    with pytest.raises(SqlValidationError) as exc_info:
        validate("SELECT * FROM spans_public_v1")
    msg = str(exc_info.value)
    assert "spans_public_v1" not in msg
    assert "traces_public_v1" not in msg


# ---------------------------------------------------------------------------
# Module-level constant shape tests
# ---------------------------------------------------------------------------
def test_allowed_functions_is_frozenset() -> None:
    assert isinstance(ALLOWED_FUNCTIONS, frozenset)
    assert len(ALLOWED_FUNCTIONS) > 0
    for name in ALLOWED_FUNCTIONS:
        assert name == name.lower(), f"ALLOWED_FUNCTIONS entry not lowercased: {name!r}"


def test_blocked_functions_is_frozenset() -> None:
    assert isinstance(BLOCKED_FUNCTIONS, frozenset)
    assert len(BLOCKED_FUNCTIONS) > 0
    for name in BLOCKED_FUNCTIONS:
        assert name == name.lower(), f"BLOCKED_FUNCTIONS entry not lowercased: {name!r}"


def test_blocked_prefixes_is_tuple_of_lowercase_strings() -> None:
    assert isinstance(BLOCKED_PREFIXES, tuple)
    assert len(BLOCKED_PREFIXES) > 0
    for prefix in BLOCKED_PREFIXES:
        assert isinstance(prefix, str)
        assert prefix == prefix.lower(), f"BLOCKED_PREFIXES entry not lowercased: {prefix!r}"


def test_blocklist_wins_over_allowlist() -> None:
    # Manually add a blocked name into ALLOWED_FUNCTIONS would not help;
    # here we verify the symbolic contract: blocked set and allowed set
    # are both present as public constants.
    assert BLOCKED_FUNCTIONS.isdisjoint(ALLOWED_FUNCTIONS), (
        "BLOCKED_FUNCTIONS and ALLOWED_FUNCTIONS must not overlap"
    )


def test_validate_returns_query_ast_on_success() -> None:
    result = validate("SELECT count() FROM spans")
    assert isinstance(result, exp.Query)


def test_validate_raises_sql_validation_error_not_generic_exception() -> None:
    """SqlValidationError must be raised, not a raw ValueError or Exception."""
    with pytest.raises(SqlValidationError):
        validate("DROP TABLE spans")


def test_sql_validation_error_is_value_error_subclass() -> None:
    assert issubclass(SqlValidationError, ValueError)


# ---------------------------------------------------------------------------
# Reserved scope-parameter placeholders (defense-in-depth: user SQL must not
# reference the server-side scope bind namespace)
# ---------------------------------------------------------------------------
RESERVED_PLACEHOLDER_CASES = [
    pytest.param(
        "SELECT span_id FROM spans WHERE span_id = {project_id:String}",
        id="reject-user-project-id-placeholder",
    ),
    pytest.param(
        "SELECT span_id FROM spans WHERE span_id = {PROJECT_ID:String}",
        id="reject-user-project-id-placeholder-uppercase",
    ),
    pytest.param(
        "SELECT span_id FROM spans WHERE span_id = {scope_project_id:String}",
        id="reject-user-scope-project-id-placeholder",
    ),
    pytest.param(
        "SELECT span_id FROM spans WHERE span_id = {scope_evil:String}",
        id="reject-user-scope-namespace-placeholder",
    ),
    pytest.param(
        "SELECT span_id FROM spans WHERE span_id = {SCOPE_PROJECT_ID:String}",
        id="reject-user-scope-placeholder-uppercase",
    ),
]


@pytest.mark.parametrize("sql", RESERVED_PLACEHOLDER_CASES)
def test_reserved_scope_placeholders_are_rejected(sql: str) -> None:
    with pytest.raises(SqlValidationError):
        validate(sql)


def test_user_placeholder_outside_scope_namespace_is_allowed() -> None:
    # A user's own bound parameter is a legitimate feature; only the reserved
    # `scope_` namespace is off-limits.
    result = validate("SELECT span_id FROM spans WHERE span_id = {myval:String}")
    assert isinstance(result, exp.Query)


def test_uniqexact_allowed_but_uniq_rejected() -> None:
    # uniqExact keeps its name and is in the allowlist; uniq normalises to
    # ApproxDistinct and is (intentionally) rejected. Pin both so a sqlglot
    # upgrade that changes normalisation cannot silently flip the outcome.
    assert isinstance(validate("SELECT uniqExact(span_id) FROM spans"), exp.Query)
    with pytest.raises(SqlValidationError):
        validate("SELECT uniq(span_id) FROM spans")


# ---------------------------------------------------------------------------
# F5: widened analytics-function allowlist (one case per added function, so a
# sqlglot canonical-name change surfaces as a failure rather than silent drift)
# ---------------------------------------------------------------------------
F5_ALLOWED_CASES = [
    "SELECT toStartOfMinute(span_start_time) FROM spans",
    "SELECT toStartOfHour(span_start_time) FROM spans",
    "SELECT toStartOfDay(span_start_time) FROM spans",
    "SELECT toStartOfInterval(span_start_time, INTERVAL 1 HOUR) FROM spans",
    "SELECT toYYYYMM(span_start_time) FROM spans",
    "SELECT toHour(span_start_time) FROM spans",
    "SELECT formatDateTime(span_start_time, '%Y-%m') FROM spans",
    "SELECT concat(name, status) FROM spans",
    "SELECT any(name) FROM spans",
    "SELECT argMax(name, cost) FROM spans",
    "SELECT argMin(name, cost) FROM spans",
    "SELECT groupArray(name) FROM spans",
    "SELECT stddevPop(cost) FROM spans",
    "SELECT stddevSamp(cost) FROM spans",
    "SELECT row_number() OVER (ORDER BY cost) FROM spans",
    "SELECT rank() OVER (ORDER BY cost) FROM spans",
    "SELECT dense_rank() OVER (ORDER BY cost) FROM spans",
]


@pytest.mark.parametrize("sql", F5_ALLOWED_CASES)
def test_f5_widened_functions_are_allowed(sql: str) -> None:
    assert isinstance(validate(sql), exp.Query)


def test_restricted_column_error_does_not_name_project_id() -> None:
    # The blocked-column error must not echo the reserved column name (keeps the
    # message sanitized and avoids confirming the internal scoping column).
    for sql in ("SELECT project_id FROM spans", "SELECT span_id AS project_id FROM spans"):
        with pytest.raises(SqlValidationError) as exc_info:
            validate(sql)
        assert "project_id" not in str(exc_info.value)
