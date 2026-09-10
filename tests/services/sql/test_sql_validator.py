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

from rest.services.sql import validator as validator_module
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
    # Mixed-case CTE alias — the in-scope reference must be allowed (identifier
    # matching is case-insensitive; scope.cte_sources preserves original case).
    "WITH MyCte AS (SELECT trace_id FROM traces) SELECT count() FROM MyCte",
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
    # project_id blocked as a table alias and as a column table-qualifier too
    # (policy consistency; not a scoping bypass — the rewriter scopes by table
    # identity regardless of alias).
    pytest.param("SELECT span_id FROM spans AS project_id", id="reject-project-id-table-alias"),
    pytest.param(
        "SELECT project_id.span_id FROM spans AS project_id",
        id="reject-project-id-column-qualifier",
    ),
    # ----- CTE shadow -------------------------------------------------------
    pytest.param(
        "WITH spans AS (SELECT 1 AS x) SELECT x FROM spans",
        id="reject-cte-shadow-spans",
    ),
    # Case-insensitive CTE matching must NOT reopen the scope-aware bypass: the
    # outer `Evil` is a real out-of-scope table; the same-named CTE lives only in
    # the subquery, so it must still be rejected despite the case difference.
    pytest.param(
        "SELECT span_id FROM Evil WHERE 1 IN (WITH evil AS (SELECT 1 AS n) SELECT n FROM evil)",
        id="reject-mixed-case-out-of-scope-table",
    ),
    # ----- SETTINGS ---------------------------------------------------------
    pytest.param(
        "SELECT count() FROM spans SETTINGS max_execution_time = 99999",
        id="reject-settings",
    ),
    # SETTINGS/FORMAT can attach to a set-operation (Union) or Subquery root,
    # not just a Select — those must be rejected too.
    pytest.param(
        "SELECT span_id FROM spans UNION ALL (SELECT span_id FROM spans) "
        "SETTINGS max_execution_time = 99999",
        id="reject-settings-union-root",
    ),
    pytest.param(
        "(SELECT span_id FROM spans UNION ALL SELECT span_id FROM spans) FORMAT JSON",
        id="reject-format-union-subquery-root",
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


def test_blocked_and_allowed_sets_do_not_overlap() -> None:
    # The invariant that keeps precedence from ever being exercised in production.
    assert BLOCKED_FUNCTIONS.isdisjoint(ALLOWED_FUNCTIONS), (
        "BLOCKED_FUNCTIONS and ALLOWED_FUNCTIONS must not overlap"
    )


def test_blocklist_wins_when_a_name_reaches_both_sets(monkeypatch: pytest.MonkeyPatch) -> None:
    # Because the two sets are disjoint today, the precedence branch is dead code from
    # the test suite's point of view and could regress unnoticed. Force the overlap the
    # invariant above forbids: a blocked name that is ALSO allowlisted stays rejected.
    monkeypatch.setattr(validator_module, "ALLOWED_FUNCTIONS", ALLOWED_FUNCTIONS | {"sleep"})
    with pytest.raises(SqlValidationError):
        validate("SELECT sleep(10) FROM spans")


@pytest.mark.parametrize(
    "sql",
    [
        pytest.param("SELECT span_id FROM spans;", id="terminator"),
        pytest.param("SELECT span_id FROM spans ;", id="spaced-terminator"),
    ],
)
def test_bare_trailing_semicolon_is_one_statement(sql: str) -> None:
    # A terminator is not a second statement: the parse yields one statement, and the
    # rewriter renders the AST rather than the caller's text, so the `;` never reaches
    # ClickHouse. Anything AFTER the `;` IS a second statement and is rejected — see
    # `reject-multi-stmt` and `reject-trailing-injection` in the rejection matrix.
    assert isinstance(validate(sql), exp.Query)


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


def test_user_placeholder_outside_scope_namespace_is_refused_while_unwired() -> None:
    # A user's own bound parameter is a legitimate feature and the reserved
    # `scope_` namespace is what keeps it away from the scope bind -- but nothing
    # populates the payload yet, so accepting one only buys a ClickHouse
    # `Substitution ... is not set` error that names the parameter back. Refuse
    # here until the endpoint binds them; the reserved-name branch stays either way.
    with pytest.raises(SqlValidationError):
        validate("SELECT span_id FROM spans WHERE span_id = {myval:String}")


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


# ---------------------------------------------------------------------------
# Curated `metadata` Map column: keying needs no function, inspecting does.
# ---------------------------------------------------------------------------
METADATA_MAP_CASES = [
    "SELECT metadata['user_id'] FROM spans",
    "SELECT count() FROM spans WHERE metadata['tier'] = 'pro'",
    "SELECT mapKeys(metadata) FROM spans",
    "SELECT mapValues(metadata) FROM traces",
    "SELECT name FROM spans WHERE mapContains(metadata, 'tenant')",
]


@pytest.mark.parametrize("sql", METADATA_MAP_CASES)
def test_metadata_map_access_is_allowed(sql: str) -> None:
    assert isinstance(validate(sql), exp.Query)


def test_map_functions_do_not_open_the_wider_array_surface() -> None:
    # Only the three map accessors were added; array functions that happen to
    # compose with mapKeys() are still rejected by the allowlist.
    with pytest.raises(SqlValidationError):
        validate("SELECT arrayJoin(mapKeys(metadata)) FROM spans")


# ---------------------------------------------------------------------------
# Identifier placeholders. ClickHouse substitutes `{name:Identifier}` as a table
# or column name on the SERVER, after validation — so the allowlists here would
# be inspecting an AST that never held the identifier the query actually reads.
# ---------------------------------------------------------------------------
IDENTIFIER_PLACEHOLDER_CASES = [
    pytest.param("SELECT {col:Identifier} FROM spans", id="select-list"),
    pytest.param("SELECT * FROM {tbl:Identifier}", id="table-position"),
    pytest.param("SELECT * FROM spans WHERE {c:Identifier} = 1", id="predicate"),
]


@pytest.mark.parametrize("sql", IDENTIFIER_PLACEHOLDER_CASES)
def test_identifier_placeholders_are_rejected(sql: str) -> None:
    with pytest.raises(SqlValidationError):
        validate(sql)


def test_identifier_placeholder_in_table_position_raises_the_domain_error() -> None:
    # It reaches the table walk as a Var rather than a table name; before the
    # placeholder gate this escaped as a raw AttributeError, which is a 500 and a
    # stack trace rather than a rejected query.
    with pytest.raises(SqlValidationError) as exc_info:
        validate("SELECT * FROM {tbl:Identifier}")
    assert "tbl" not in str(exc_info.value)


@pytest.mark.parametrize(
    "sql",
    [
        pytest.param("SELECT count() FROM spans WHERE span_id = {v:String}", id="string"),
        pytest.param("SELECT * FROM spans WHERE cost > {c:Float64}", id="float"),
    ],
)
def test_value_placeholders_are_refused_while_unwired(sql: str) -> None:
    # A caller's own value parameters are a product feature, but nothing binds
    # them yet. Left accepted, the query reaches ClickHouse and comes back with
    # `Code: 456 ... Substitution 'v' is not set` -- an error that echoes the
    # parameter name, which this layer exists to prevent. Lift with the endpoint.
    with pytest.raises(SqlValidationError) as exc_info:
        validate(sql)
    assert str(exc_info.value) != "v"
    assert "Substitution" not in str(exc_info.value)


def test_reserved_parameter_names_keep_their_own_error() -> None:
    # The reserved-name check must stay distinct from the blanket refusal above:
    # it is the branch that survives when user parameters are wired.
    for sql in (
        "SELECT span_id FROM spans WHERE trace_id = {project_id:String}",
        "SELECT span_id FROM spans WHERE trace_id = {scope_project_id:String}",
    ):
        with pytest.raises(SqlValidationError) as exc_info:
            validate(sql)
        assert "reserved name" in str(exc_info.value)


# ---------------------------------------------------------------------------
# EXISTS is a predicate over a subquery, not a call the allowlist rules on.
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "sql",
    [
        pytest.param("SELECT span_id FROM spans WHERE EXISTS (SELECT 1 FROM traces)", id="exists"),
        pytest.param(
            "SELECT span_id FROM spans AS s"
            " WHERE NOT EXISTS (SELECT 1 FROM traces AS t WHERE t.trace_id = s.trace_id)",
            id="not-exists-correlated",
        ),
    ],
)
def test_exists_is_allowed_like_its_not_in_equivalent(sql: str) -> None:
    assert isinstance(validate(sql), exp.Query)


def test_exists_subquery_is_still_validated() -> None:
    # Skipping the function gate for EXISTS must not skip the walk inside it.
    for sql in (
        "SELECT span_id FROM spans WHERE EXISTS (SELECT 1 FROM system.tables)",
        "SELECT span_id FROM spans WHERE EXISTS (SELECT sleep(5) FROM traces)",
    ):
        with pytest.raises(SqlValidationError):
            validate(sql)


# ---------------------------------------------------------------------------
# The reserved tenant name is refused in every identifier position, including the
# two that introduce a name rather than reference one.
# ---------------------------------------------------------------------------
RESERVED_ALIAS_CASES = [
    pytest.param("WITH project_id AS (SELECT 1 AS x) SELECT x FROM project_id", id="cte-alias"),
    pytest.param(
        "SELECT span_id FROM (SELECT span_id FROM spans) AS project_id", id="derived-table-alias"
    ),
]


@pytest.mark.parametrize("sql", RESERVED_ALIAS_CASES)
def test_reserved_name_is_refused_as_a_cte_or_derived_table_alias(sql: str) -> None:
    with pytest.raises(SqlValidationError) as exc_info:
        validate(sql)
    # Same generic wording as the other positions: the error never names the column.
    assert "project_id" not in str(exc_info.value)


@pytest.mark.parametrize(
    "sql",
    [
        pytest.param(
            "WITH recent AS (SELECT span_id FROM spans) SELECT span_id FROM recent", id="cte"
        ),
        pytest.param("SELECT span_id FROM (SELECT span_id FROM spans) AS s", id="derived-table"),
    ],
)
def test_ordinary_cte_and_derived_table_aliases_still_pass(sql: str) -> None:
    assert isinstance(validate(sql), exp.Query)
