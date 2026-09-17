"""Tests for the project-scoped AST rewriter + post-rewrite verification (Layer 2 + 3).

TDD: these tests were written before the implementation so they all fail first.

Design under test
-----------------
``scope_and_render(sql, project_id) -> (rendered_sql, bind_map)``

* Layer 2 — rewrites every whitelisted ``exp.Table`` to its parameterised curated
  view, preserving user-supplied aliases.
* Layer 3 — post-rewrite AST verification: fail closed if any whitelisted table
  survived un-rewritten.

Key sqlglot empirical findings (confirmed before writing tests)
---------------------------------------------------------------
* ``{scope_project_id:String}`` parses/renders as
  ``Placeholder(this=Var(this='scope_project_id'), kind=DataType(TEXT))``.
  sqlglot renders it as ``{scope_project_id: String}`` (note the space after the
  colon) when using the ClickHouse dialect.
* A parameterised view call, e.g.
  ``spans_public_v1(project_id = {scope_project_id:String}) AS spans``, is
  represented as ``Table(this=Anonymous(this='spans_public_v1', ...), alias=...)``.
  ``table.name`` is ``''`` (empty, because ``this`` is ``Anonymous`` not
  ``Identifier``); ``table.alias`` is the alias string.
* ``tree.transform`` visits ``Table`` nodes inside JOINs, CTE bodies, subqueries,
  and both ``UNION``/``UNION ALL`` arms.
* ARRAY JOIN right-hand sides do NOT produce ``exp.Table`` nodes; they are
  ``Alias(Column(...))`` or ``Column(...)`` inside a ``Join``.
"""

from __future__ import annotations

import pytest
import sqlglot.expressions as exp

from rest.services.sql import rewriter as rewriter_mod
from rest.services.sql.errors import SqlValidationError
from rest.services.sql.rewriter import PROJECT_ID_RE, USE_BOUND_PARAM, scope_and_render

# A safe project_id used as the fixture value throughout.
PID = "acme_corp:proj.123-abc"


# ---------------------------------------------------------------------------
# Helper: assert that a string appears in the rendered SQL (modulo whitespace
# within the placeholder; sqlglot adds a space after the colon).
# ---------------------------------------------------------------------------
def _has_placeholder(sql: str) -> bool:
    """Return True if the ClickHouse bound-parameter placeholder is present."""
    return "scope_project_id" in sql


# ---------------------------------------------------------------------------
# 1.  Simple single-table rewrite — bound-parameter path
# ---------------------------------------------------------------------------
class TestSimpleRewrite:
    def test_sql_references_curated_view(self) -> None:
        rendered, _ = scope_and_render("SELECT count() FROM spans", PID)
        assert "spans_public_v1" in rendered

    def test_placeholder_present_in_sql(self) -> None:
        rendered, _ = scope_and_render("SELECT count() FROM spans", PID)
        assert _has_placeholder(rendered)

    def test_bind_map_contains_project_id(self) -> None:
        _, bind_map = scope_and_render("SELECT count() FROM spans", PID)
        assert bind_map == {"scope_project_id": PID}

    def test_pid_value_absent_from_sql(self) -> None:
        rendered, _ = scope_and_render("SELECT count() FROM spans", PID)
        assert PID not in rendered

    def test_bind_map_key_is_exactly_scope_project_id(self) -> None:
        _, bind_map = scope_and_render("SELECT count() FROM spans", PID)
        assert set(bind_map.keys()) == {"scope_project_id"}

    def test_return_type_is_tuple_of_str_and_dict(self) -> None:
        result = scope_and_render("SELECT count() FROM spans", PID)
        assert isinstance(result, tuple) and len(result) == 2
        sql, bmap = result
        assert isinstance(sql, str)
        assert isinstance(bmap, dict)


# ---------------------------------------------------------------------------
# 2.  Both tables + aliases preserved
# ---------------------------------------------------------------------------
class TestJoinBothTablesWithAliases:
    SQL = "SELECT s.span_id FROM spans s JOIN traces t ON s.trace_id = t.trace_id"

    def test_spans_view_present(self) -> None:
        rendered, _ = scope_and_render(self.SQL, PID)
        assert "spans_public_v1" in rendered

    def test_traces_view_present(self) -> None:
        rendered, _ = scope_and_render(self.SQL, PID)
        assert "traces_public_v1" in rendered

    def test_alias_s_preserved(self) -> None:
        rendered, _ = scope_and_render(self.SQL, PID)
        # Up to the next token: a dropped alias renders `AS spans`, which starts
        # with `AS s` and would satisfy a prefix match.
        assert "AS s JOIN" in rendered

    def test_alias_t_preserved(self) -> None:
        rendered, _ = scope_and_render(self.SQL, PID)
        # `AS traces` would satisfy a prefix match the same way.
        assert "AS t ON" in rendered

    def test_pid_absent(self) -> None:
        rendered, _ = scope_and_render(self.SQL, PID)
        assert PID not in rendered


# ---------------------------------------------------------------------------
# 3.  Un-aliased table keeps AS <tablename>
# ---------------------------------------------------------------------------
class TestUnaliasedTableKeepsDefaultAlias:
    def test_spans_keeps_as_spans(self) -> None:
        rendered, _ = scope_and_render("SELECT count() FROM spans", PID)
        assert "AS spans" in rendered

    def test_traces_keeps_as_traces(self) -> None:
        rendered, _ = scope_and_render("SELECT count() FROM traces", PID)
        assert "AS traces" in rendered


# ---------------------------------------------------------------------------
# 4.  CTE body is rewritten; CTE alias reference is NOT rewritten
# ---------------------------------------------------------------------------
class TestCteBodyRewrittenAliasNot:
    SQL = (
        "WITH x AS (SELECT trace_id FROM traces) "
        "SELECT count() FROM x WHERE trace_id IN (SELECT trace_id FROM spans)"
    )

    def test_traces_view_in_cte_body(self) -> None:
        rendered, _ = scope_and_render(self.SQL, PID)
        assert "traces_public_v1" in rendered

    def test_spans_view_in_subquery(self) -> None:
        rendered, _ = scope_and_render(self.SQL, PID)
        assert "spans_public_v1" in rendered

    def test_no_x_public_v1_in_sql(self) -> None:
        rendered, _ = scope_and_render(self.SQL, PID)
        assert "x_public_v1" not in rendered

    def test_cte_alias_x_appears_in_from(self) -> None:
        # The outer FROM x must remain a reference to the CTE alias, not a view call.
        rendered, _ = scope_and_render(self.SQL, PID)
        # Assert the FROM specifically, up to the next token. A bare `" x "` also
        # matches the `WITH x AS` definition, and `FROM x` alone matches a rewritten
        # `FROM x_public_v1`, so neither would catch the outer reference changing.
        assert "FROM x WHERE" in rendered


# ---------------------------------------------------------------------------
# 5.  Subquery table is rewritten
# ---------------------------------------------------------------------------
class TestSubqueryTableRewritten:
    def test_traces_view_in_subquery(self) -> None:
        sql = "SELECT trace_id FROM (SELECT trace_id FROM traces) s"
        rendered, _ = scope_and_render(sql, PID)
        assert "traces_public_v1" in rendered

    def test_pid_absent_from_subquery_rewrite(self) -> None:
        sql = "SELECT trace_id FROM (SELECT trace_id FROM traces) s"
        rendered, _ = scope_and_render(sql, PID)
        assert PID not in rendered


# ---------------------------------------------------------------------------
# 6.  UNION ALL — both arms rewritten
# ---------------------------------------------------------------------------
class TestUnionAllBothArmsRewritten:
    SQL = "SELECT span_id FROM spans UNION ALL SELECT span_id FROM spans"

    def test_two_occurrences_of_spans_public_v1(self) -> None:
        rendered, _ = scope_and_render(self.SQL, PID)
        assert rendered.count("spans_public_v1") == 2

    def test_two_placeholders_in_sql(self) -> None:
        rendered, _ = scope_and_render(self.SQL, PID)
        # Both arms injected a placeholder
        assert rendered.count("scope_project_id") == 2

    def test_pid_absent(self) -> None:
        rendered, _ = scope_and_render(self.SQL, PID)
        assert PID not in rendered


# ---------------------------------------------------------------------------
# 7.  Literal fallback path (USE_BOUND_PARAM = False)
# ---------------------------------------------------------------------------
class TestLiteralFallback:
    SAFE_PID = "safe_project_42"

    def test_safe_pid_embedded_in_sql(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(rewriter_mod, "USE_BOUND_PARAM", False)
        rendered, _ = scope_and_render("SELECT count() FROM spans", self.SAFE_PID)
        assert self.SAFE_PID in rendered

    def test_bind_map_empty_in_literal_mode(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(rewriter_mod, "USE_BOUND_PARAM", False)
        _, bind_map = scope_and_render("SELECT count() FROM spans", self.SAFE_PID)
        assert bind_map == {}

    def test_placeholder_absent_in_literal_mode(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(rewriter_mod, "USE_BOUND_PARAM", False)
        rendered, _ = scope_and_render("SELECT count() FROM spans", self.SAFE_PID)
        assert "scope_project_id" not in rendered

    def test_unsafe_pid_with_quote_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(rewriter_mod, "USE_BOUND_PARAM", False)
        bad_pid = "'; DROP TABLE spans;--"
        with pytest.raises(SqlValidationError):
            scope_and_render("SELECT count() FROM spans", bad_pid)

    def test_unsafe_pid_with_semicolon_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(rewriter_mod, "USE_BOUND_PARAM", False)
        with pytest.raises(SqlValidationError):
            scope_and_render("SELECT count() FROM spans", "proj;evil")

    def test_unsafe_pid_with_whitespace_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(rewriter_mod, "USE_BOUND_PARAM", False)
        with pytest.raises(SqlValidationError):
            scope_and_render("SELECT count() FROM spans", "proj id")

    def test_empty_pid_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(rewriter_mod, "USE_BOUND_PARAM", False)
        with pytest.raises(SqlValidationError):
            scope_and_render("SELECT count() FROM spans", "")

    def test_pid_embedded_only_via_literal_not_fstring(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The literal must be SQL-escaped, not raw-injected via f-string."""
        monkeypatch.setattr(rewriter_mod, "USE_BOUND_PARAM", False)
        # A safe pid that, if injected raw, might look like SQL
        safe = "abc123"
        rendered, _ = scope_and_render("SELECT count() FROM spans", safe)
        # The pid must appear SQL-string-quoted ('abc123'), never bare. The
        # earlier `or safe in rendered` fallback made this vacuous (a quoted
        # literal always contains the bare substring), so it is removed.
        assert f"'{safe}'" in rendered


# ---------------------------------------------------------------------------
# 8.  Invalid queries are still rejected (validator pass-through)
# ---------------------------------------------------------------------------
class TestInvalidQueriesStillRejected:
    def test_drop_table_raises(self) -> None:
        with pytest.raises(SqlValidationError):
            scope_and_render("DROP TABLE spans", PID)

    def test_sleep_raises(self) -> None:
        with pytest.raises(SqlValidationError):
            scope_and_render("SELECT sleep(10)", PID)

    def test_unknown_table_raises(self) -> None:
        with pytest.raises(SqlValidationError):
            scope_and_render("SELECT * FROM users", PID)

    def test_empty_sql_raises(self) -> None:
        with pytest.raises(SqlValidationError):
            scope_and_render("", PID)


# ---------------------------------------------------------------------------
# 9.  Layer-3 fail-closed: monkeypatch _rewrite_table to be a no-op
# ---------------------------------------------------------------------------
class TestLayer3FailClosed:
    def test_skipped_rewrite_raises_sql_validation_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """If _rewrite_table is patched to a no-op, post-rewrite verification
        must detect the surviving un-rewritten table and raise SqlValidationError."""

        def _noop(
            node: exp.Table,
            cte_aliases: set,
            param_value: exp.Expression,
            bounds: dict | None = None,
        ) -> exp.Expression:
            return node  # deliberately skip the rewrite

        monkeypatch.setattr(rewriter_mod, "_rewrite_table", _noop)
        with pytest.raises(SqlValidationError):
            scope_and_render("SELECT count() FROM spans", PID)

    def test_skipped_rewrite_on_traces_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def _noop(
            node: exp.Table,
            cte_aliases: set,
            param_value: exp.Expression,
            bounds: dict | None = None,
        ) -> exp.Expression:
            return node

        monkeypatch.setattr(rewriter_mod, "_rewrite_table", _noop)
        with pytest.raises(SqlValidationError):
            scope_and_render("SELECT count() FROM traces", PID)


# ---------------------------------------------------------------------------
# 10. ARRAY JOIN column is not rewritten to a *_public_v1 reference
# ---------------------------------------------------------------------------
class TestArrayJoinNotRewritten:
    def test_array_join_col_not_rewritten(self) -> None:
        """An ARRAY JOIN operand is a column/alias, not a Table node — it must
        not be rewritten to a curated view call."""
        # spans is the only real table; ARRAY JOIN arr is a column reference.
        sql = "SELECT span_id FROM spans ARRAY JOIN arr"
        rendered, _ = scope_and_render(sql, PID)
        # spans must be rewritten
        assert "spans_public_v1" in rendered
        # arr must NOT be treated as a table to rewrite
        assert "arr_public_v1" not in rendered


# ---------------------------------------------------------------------------
# 11. Module-level constant shape tests
# ---------------------------------------------------------------------------
class TestModuleConstants:
    def test_use_bound_param_is_true_by_default(self) -> None:
        assert USE_BOUND_PARAM is True

    def test_project_id_re_accepts_safe_ids(self) -> None:
        safe_ids = ["proj123", "acme_corp:proj.123-abc", "A1.B2_C3:d4-e5"]
        for pid in safe_ids:
            assert PROJECT_ID_RE.fullmatch(pid), f"Should match: {pid!r}"

    def test_project_id_re_rejects_unsafe_ids(self) -> None:
        unsafe_ids = ["", "proj id", "proj;evil", "'; DROP TABLE", "proj\n", "proj\t"]
        for pid in unsafe_ids:
            assert not PROJECT_ID_RE.fullmatch(pid), f"Should not match: {pid!r}"


# ---------------------------------------------------------------------------
# Alias-quoting preservation (P2 regression)
# ---------------------------------------------------------------------------
def test_quoted_table_alias_with_space_is_preserved() -> None:
    """A table alias requiring quotes (contains a space) must stay quoted after
    rewrite; emitting it bare would produce invalid SQL."""
    import sqlglot

    sql, _ = scope_and_render("SELECT `weird alias`.span_id FROM spans AS `weird alias`", PID)
    assert 'AS "weird alias"' in sql
    # the rewritten SQL must still parse cleanly (no bare `AS weird alias`)
    sqlglot.parse_one(sql, read="clickhouse")


def test_reserved_word_table_alias_is_preserved() -> None:
    """A reserved-word alias must remain quoted after rewrite."""
    import sqlglot

    sql, _ = scope_and_render("SELECT `select`.span_id FROM spans AS `select`", PID)
    assert 'AS "select"' in sql
    sqlglot.parse_one(sql, read="clickhouse")


def test_unquoted_alias_stays_unquoted() -> None:
    """A plain alias is not gratuitously quoted."""
    sql, _ = scope_and_render("SELECT t.span_id FROM spans AS t", PID)
    assert "AS t" in sql
    assert 'AS "t"' not in sql


# ---------------------------------------------------------------------------
# Follow-up hardening (PR #1356): reparse, CTE-shadow, explicit placeholder
# ---------------------------------------------------------------------------
REPARSE_CASES = [
    "SELECT count() FROM spans",
    "SELECT s.span_id FROM spans s JOIN traces t ON s.trace_id = t.trace_id",
    "WITH x AS (SELECT trace_id FROM traces) "
    "SELECT count() FROM x WHERE trace_id IN (SELECT trace_id FROM spans)",
    "SELECT trace_id FROM (SELECT trace_id FROM traces) s",
    "SELECT span_id FROM spans UNION ALL SELECT span_id FROM spans",
]


@pytest.mark.parametrize("sql", REPARSE_CASES)
def test_rendered_sql_reparses_under_clickhouse_dialect(sql: str) -> None:
    """Every representative rewrite must produce valid ClickHouse SQL that
    round-trips through the sqlglot parser (no malformed output)."""
    import sqlglot

    out, _ = scope_and_render(sql, PID)
    sqlglot.parse_one(out, read="clickhouse")  # must not raise


def test_cte_shadow_is_rejected_through_scope_and_render() -> None:
    """A CTE shadowing a public table is rejected by the validator; that
    rejection must propagate through scope_and_render (no rewrite is rendered)."""
    with pytest.raises(SqlValidationError):
        scope_and_render("WITH spans AS (SELECT 1 AS x) SELECT x FROM spans", PID)


def test_bound_placeholder_renders_as_clickhouse_string_form() -> None:
    """Bound mode emits a ClickHouse String parameter placeholder for the scope,
    never the project_id value, and binds exactly one key."""
    import re

    out, binds = scope_and_render("SELECT count() FROM spans", PID)
    # ClickHouse String parameter placeholder: {scope_project_id : String}
    # (sqlglot renders a space after the colon; ClickHouse 24.3 accepts both).
    assert re.search(r"\{\s*scope_project_id\s*:\s*String\s*\}", out)
    # the project_id value never appears literally in the rendered SQL
    assert PID not in out
    # exactly one bind key, reserved for server-side scoping
    assert binds == {"scope_project_id": PID}


# ---------------------------------------------------------------------------
# Structural assertion on the injected scope filter (a wrong column or operator
# would otherwise be invisible to substring-only checks)
# ---------------------------------------------------------------------------
def test_injected_view_filter_is_project_scoped() -> None:
    import re

    rendered, _ = scope_and_render(
        "SELECT s.span_id FROM spans s JOIN traces t ON s.trace_id = t.trace_id", PID
    )
    # Each rewritten table must carry exactly `project_id = {scope_project_id:String}`
    # (correct column, `=` operator, reserved bound param) — not e.g. a different
    # column or a `!=`.
    pattern = re.compile(r"project_id\s*=\s*\{\s*scope_project_id\s*:\s*String\s*\}")
    assert len(pattern.findall(rendered)) == 2
    # and no other column is used as the scope filter
    assert "!=" not in rendered


# ---------------------------------------------------------------------------
# The CTE exemption must not be able to shield a public table name, even if a
# query reached the rewriter without the validator's CTE-shadow check.
# ---------------------------------------------------------------------------
def test_cte_named_after_a_public_table_cannot_exempt_it(monkeypatch: pytest.MonkeyPatch) -> None:
    import sqlglot

    from rest.services.sql import rewriter as rewriter_module

    # Stand in for a validator that let a shadowing CTE through. The rewriter is
    # the layer holding the tenant boundary; it must not rely on an invariant
    # enforced in another module.
    monkeypatch.setattr(
        rewriter_module,
        "validate",
        lambda sql: sqlglot.parse_one(sql, dialect="clickhouse"),
    )

    rendered, binds = scope_and_render("WITH spans AS (SELECT 1 AS x) SELECT x FROM spans", PID)

    # The reference was rewritten to the curated view rather than exempted, and
    # Layer 3 did not forgive a surviving bare table.
    assert "spans_public_v1" in rendered
    assert binds == {"scope_project_id": PID}


# ---------------------------------------------------------------------------
# Layer-3 has three invariants. The surviving-table branch is covered above via
# the _rewrite_table no-op; these cover the other two, because this module is
# the tenant-isolation boundary and a fail-closed path that never fails closed
# in a test is an assumption rather than a guarantee.
# ---------------------------------------------------------------------------
def test_layer3_rejects_an_injected_view_it_does_not_recognise(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from rest.services.sql import rewriter as rewriter_module

    real_build = rewriter_module._build_view_table

    def _wrong_view(view_name, alias_node, param_value, start, end):  # type: ignore[no-untyped-def]
        return real_build("somewhere_else_v1", alias_node, param_value, start, end)

    monkeypatch.setattr(rewriter_module, "_build_view_table", _wrong_view)

    with pytest.raises(SqlValidationError) as exc_info:
        scope_and_render("SELECT span_id FROM spans", PID)
    assert "unexpected anonymous table reference" in str(exc_info.value)


def test_layer3_rejects_a_blocked_function_in_the_rewritten_tree(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import sqlglot

    from rest.services.sql import rewriter as rewriter_module

    # A correct rewrite with a blocked function smuggled past Layer 1. Verification
    # re-scans the rewritten AST rather than trusting that Layer 1 saw this tree,
    # so it must still fire.
    monkeypatch.setattr(
        rewriter_module, "validate", lambda sql: sqlglot.parse_one(sql, dialect="clickhouse")
    )
    with pytest.raises(SqlValidationError) as exc_info:
        scope_and_render("SELECT sleep(1) FROM spans", PID)
    assert "blocked function" in str(exc_info.value)


# ---------------------------------------------------------------------------
# Time range. The curated views declare start_time (inclusive) and end_time
# (exclusive) and apply them inside the dedup subquery, so the window the
# rewriter passes decides which rows reach the dedup at all.
# ---------------------------------------------------------------------------
def _view_call(rendered: str, view: str) -> str:
    """Return the whole ``view(...)`` call, balancing parentheses.

    A bound can itself be a call such as ``toDateTime64('…', 3)``, so a lazy
    match to the first ``)`` truncates mid-argument.
    """
    start = rendered.index(view)
    depth = 0
    for i in range(start, len(rendered)):
        if rendered[i] == "(":
            depth += 1
        elif rendered[i] == ")":
            depth -= 1
            if depth == 0:
                return rendered[start : i + 1]
    raise AssertionError(f"{view} call not closed in {rendered}")


class TestTimeRange:
    def test_open_bounds_when_the_query_has_no_time_predicate(self) -> None:
        call = _view_call(scope_and_render("SELECT count() FROM spans", PID)[0], "spans_public_v1")
        # Sentinels sit outside the storable range, so an unbounded query still
        # sees a row with a bogus far-future or pre-epoch clock.
        assert "'1900-01-01 00:00:00.000'" in call
        assert "'2299-12-31 23:59:59.999'" in call

    def test_half_open_predicate_is_passed_through_exactly(self) -> None:
        rendered, _ = scope_and_render(
            "SELECT count() FROM spans WHERE span_start_time >= '2026-09-01'"
            " AND span_start_time < '2026-09-02'",
            PID,
        )
        call = _view_call(rendered, "spans_public_v1")
        # Each bound is normalised to an instant in the server's timezone.
        assert "start_time = toTimeZone(toDateTime64('2026-09-01', 3), timezone())" in call
        assert "end_time = toTimeZone(toDateTime64('2026-09-02', 3), timezone())" in call

    def test_relative_window_is_inlined_rather_than_bound(self) -> None:
        # A bound parameter carries a value; now() has none until the server runs
        # it, and this is the most common window shape in the product.
        rendered, binds = scope_and_render(
            "SELECT count() FROM spans WHERE span_start_time >= now() - INTERVAL 1 HOUR", PID
        )
        assert "NOW()" in _view_call(rendered, "spans_public_v1").upper()
        assert set(binds) == {"scope_project_id"}

    SHIFT = "+ toIntervalMillisecond(1)"

    @pytest.mark.parametrize(
        ("predicate", "side"),
        [
            ("span_start_time > '2026-09-01'", "start_time"),
            ("'2026-09-01' < span_start_time", "start_time"),
            ("span_start_time <= '2026-09-01'", "end_time"),
            ("'2026-09-01' >= span_start_time", "end_time"),
        ],
    )
    def test_an_exclusive_comparison_shifts_by_one_millisecond(
        self, predicate: str, side: str
    ) -> None:
        # The view's lower bound is inclusive and its upper bound subtracts a
        # millisecond, so both of these land on exactly what the caller asked for.
        call = _view_call(
            scope_and_render(f"SELECT count() FROM spans WHERE {predicate}", PID)[0],
            "spans_public_v1",
        )
        assert (
            f"{side} = toTimeZone(toDateTime64('2026-09-01' {self.SHIFT}, 3), timezone())" in call
        )

    def test_the_other_side_is_still_open(self) -> None:
        call = _view_call(
            scope_and_render("SELECT count() FROM spans WHERE span_start_time > '2026-09-01'", PID)[
                0
            ],
            "spans_public_v1",
        )
        assert (
            "end_time = toTimeZone(toDateTime64('2299-12-31 23:59:59.999', 3), timezone())" in call
        )

    def test_an_inclusive_comparison_is_not_shifted(self) -> None:
        # The shift is what makes the two spellings agree, so applying it to the
        # side that already matches would move the window by a millisecond.
        call = _view_call(
            scope_and_render(
                "SELECT count() FROM spans WHERE span_start_time >= '2026-09-01'"
                " AND span_start_time < '2026-09-02'",
                PID,
            )[0],
            "spans_public_v1",
        )
        assert self.SHIFT not in call

    def test_a_window_spelled_either_way_scopes_the_view_the_same(self) -> None:
        # The property the shift exists for. These describe the identical set of
        # instants, so they must reach the view as the identical window; before the
        # shift the second left both sides open and silently dropped rows whose
        # newer version sat outside it.
        inclusive = _view_call(
            scope_and_render(
                "SELECT count() FROM spans WHERE span_start_time >= '2026-09-01 00:00:00.000'"
                " AND span_start_time < '2026-09-15 00:00:00.000'",
                PID,
            )[0],
            "spans_public_v1",
        )
        exclusive = _view_call(
            scope_and_render(
                "SELECT count() FROM spans WHERE span_start_time > '2026-08-31 23:59:59.999'"
                " AND span_start_time <= '2026-09-14 23:59:59.999'",
                PID,
            )[0],
            "spans_public_v1",
        )
        assert self.SHIFT in exclusive and self.SHIFT not in inclusive
        assert "1900-01-01" not in exclusive and "2299-12-31" not in exclusive

    def test_a_relative_exclusive_bound_is_shifted_without_being_evaluated(self) -> None:
        call = _view_call(
            scope_and_render(
                "SELECT count() FROM spans WHERE span_start_time > now() - INTERVAL 1 HOUR", PID
            )[0],
            "spans_public_v1",
        )
        assert self.SHIFT in call
        assert "NOW()" in call.upper()

    def test_each_table_is_bounded_on_its_own_time_column(self) -> None:
        rendered, _ = scope_and_render(
            "SELECT s.span_id FROM spans AS s JOIN traces AS t ON s.trace_id = t.trace_id"
            " WHERE s.span_start_time >= '2026-09-01' AND t.trace_start_time >= '2026-08-01'",
            PID,
        )
        assert "'2026-09-01'" in _view_call(rendered, "spans_public_v1")
        assert "'2026-08-01'" in _view_call(rendered, "traces_public_v1")

    def test_a_nested_predicate_does_not_widen_the_outer_window(self) -> None:
        # The failure mode this guards: a global walk lets the subquery's 1999
        # bound reach the outer call and defeat the pruning the bounds exist for.
        rendered, _ = scope_and_render(
            "SELECT span_id FROM spans WHERE span_start_time >= '2026-09-01'"
            " AND trace_id IN (SELECT trace_id FROM traces WHERE trace_start_time >= '1999-01-01')",
            PID,
        )
        assert "'2026-09-01'" in _view_call(rendered, "spans_public_v1")
        assert "'1999-01-01'" in _view_call(rendered, "traces_public_v1")
        assert "'1999-01-01'" not in _view_call(rendered, "spans_public_v1")

    def test_an_ambiguous_unqualified_column_yields_open_bounds(self) -> None:
        # Two public tables in one scope and a bare column: guessing which table
        # it bounds would bound one view by the other's predicate.
        rendered, _ = scope_and_render(
            "SELECT s.span_id FROM spans AS s JOIN traces AS t ON s.trace_id = t.trace_id"
            " WHERE span_start_time >= '2026-09-01'",
            PID,
        )
        assert "'1900-01-01 00:00:00.000'" in _view_call(rendered, "spans_public_v1")

    def test_two_bounds_on_one_side_intersect(self) -> None:
        # The caller asked for both, so the effective bound is the later one. It
        # cannot be computed here when either side is an expression, so the
        # comparison goes to the server.
        call = _view_call(
            scope_and_render(
                "SELECT count() FROM spans WHERE span_start_time >= '2026-09-01'"
                " AND span_start_time >= '2026-09-05'",
                PID,
            )[0],
            "spans_public_v1",
        )
        assert "GREATEST(" in call.upper()

    def test_layer3_accepts_the_widened_view_call(self) -> None:
        # Verification checks every argument of the call. Pinned so that check
        # keeps accepting the exact call the rewriter builds.
        rendered, _ = scope_and_render(
            "SELECT count() FROM spans WHERE span_start_time >= '2026-09-01'", PID
        )
        call = _view_call(rendered, "spans_public_v1")
        assert "project_id = {scope_project_id: String}" in call
        assert "start_time = toTimeZone(toDateTime64('2026-09-01', 3), timezone())" in call
        assert (
            "end_time = toTimeZone(toDateTime64('2299-12-31 23:59:59.999', 3), timezone())" in call
        )

    def test_a_bound_naming_another_column_is_refused(self) -> None:
        # A view argument must be a constant. Rendering `t.trace_start_time` into
        # the call fails at execution with Code 456 or Code 47, so that side stays
        # open and the query runs.
        rendered, _ = scope_and_render(
            "SELECT s.span_id FROM spans AS s JOIN traces AS t ON s.trace_id = t.trace_id"
            " WHERE s.span_start_time >= t.trace_start_time",
            PID,
        )
        call = _view_call(rendered, "spans_public_v1")
        assert "trace_start_time" not in call
        assert "'1900-01-01 00:00:00.000'" in call

    def test_a_self_join_bound_on_the_other_side_is_refused(self) -> None:
        # Both references rewrite, and neither view call carries the other side's
        # column, which would fail with Code 47 on an unknown identifier.
        rendered, _ = scope_and_render(
            "SELECT c.span_id FROM spans AS c JOIN spans AS p ON c.parent_span_id = p.span_id"
            " WHERE c.span_start_time >= p.span_start_time",
            PID,
        )
        assert rendered.count("spans_public_v1") == 2
        head = rendered.partition(" WHERE ")[0]
        assert "p.span_start_time" not in head
        assert head.count("'1900-01-01 00:00:00.000'") == 2

    def test_a_scalar_subquery_bound_is_refused_rather_than_smuggled(self) -> None:
        # The bound is copied into the view call, and a copy spliced in during the
        # transform is never itself visited, so a `spans` inside it would survive
        # un-rewritten and Layer 3 would refuse the whole query.
        rendered, _ = scope_and_render(
            "SELECT count() FROM spans WHERE span_start_time >="
            " (SELECT max(span_start_time) - INTERVAL 1 DAY FROM spans)",
            PID,
        )
        assert "'1900-01-01 00:00:00.000'" in _view_call(rendered, "spans_public_v1")

    def test_bounds_of_mixed_kinds_combine(self) -> None:
        # Raw, these raise Code 386: no supertype for DateTime and String.
        rendered, _ = scope_and_render(
            "SELECT count() FROM spans WHERE span_start_time >= now() - INTERVAL 30 DAY"
            " AND span_start_time >= '2026-09-01'",
            PID,
        )
        call = _view_call(rendered, "spans_public_v1")
        assert "GREATEST(" in call.upper()
        assert call.upper().count("TOTIMEZONE(") >= 2


# ---------------------------------------------------------------------------
# Layer 3 on the view call's arguments. Each test breaks the rewrite in one way
# the name check alone would have let through, and expects the query refused.
# ---------------------------------------------------------------------------
def _bypass_layer1(monkeypatch: pytest.MonkeyPatch) -> None:
    import sqlglot

    monkeypatch.setattr(
        rewriter_mod, "validate", lambda sql: sqlglot.parse_one(sql, dialect="clickhouse")
    )


def _patch_view_arguments(monkeypatch: pytest.MonkeyPatch, change) -> None:  # type: ignore[no-untyped-def]
    """Build the real view call, then let *change* edit its argument list."""
    real_build = rewriter_mod._build_view_table

    def _build(view_name, alias_node, param_value, start, end):  # type: ignore[no-untyped-def]
        table = real_build(view_name, alias_node, param_value, start, end)
        table.this.set("expressions", change(list(table.this.expressions)))
        return table

    monkeypatch.setattr(rewriter_mod, "_build_view_table", _build)


def _argument(name: str, value: exp.Expression) -> exp.EQ:
    return exp.EQ(this=exp.Column(this=exp.Identifier(this=name)), expression=value)


class TestLayer3ViewCallArguments:
    def test_a_call_that_lost_a_bound_is_refused(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # ClickHouse would answer Code 456 at execution; the rewrite is wrong first.
        _patch_view_arguments(monkeypatch, lambda args: args[:2])
        with pytest.raises(SqlValidationError, match="missing an argument"):
            scope_and_render("SELECT count() FROM spans", PID)

    def test_a_repeated_tenant_argument_is_refused(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _patch_view_arguments(
            monkeypatch,
            lambda args: [*args, _argument("project_id", exp.Literal.string("someone-else"))],
        )
        with pytest.raises(SqlValidationError, match="unexpected arguments"):
            scope_and_render("SELECT count() FROM spans", PID)

    def test_an_undeclared_argument_is_refused(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # ClickHouse accepts and ignores an undeclared view argument, so only this
        # check notices a rewrite that emits one.
        _patch_view_arguments(
            monkeypatch, lambda args: [*args, _argument("tenant", exp.Literal.string("x"))]
        )
        with pytest.raises(SqlValidationError, match="unexpected arguments"):
            scope_and_render("SELECT count() FROM spans", PID)

    def test_a_call_scoped_to_another_value_is_refused(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The view name is right and every argument is present, but the tenant
        # argument is not the value this render bound. The name check passed this.
        real_build = rewriter_mod._build_view_table

        def _build(view_name, alias_node, param_value, start, end):  # type: ignore[no-untyped-def]
            return real_build(view_name, alias_node, exp.Literal.string("someone-else"), start, end)

        monkeypatch.setattr(rewriter_mod, "_build_view_table", _build)
        with pytest.raises(SqlValidationError, match="not scoped to the bound project"):
            scope_and_render("SELECT count() FROM spans", PID)

    def test_literal_mode_checks_the_literal_too(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(rewriter_mod, "USE_BOUND_PARAM", False)
        real_build = rewriter_mod._build_view_table

        def _build(view_name, alias_node, param_value, start, end):  # type: ignore[no-untyped-def]
            return real_build(view_name, alias_node, exp.Literal.string("other.proj"), start, end)

        monkeypatch.setattr(rewriter_mod, "_build_view_table", _build)
        with pytest.raises(SqlValidationError, match="not scoped to the bound project"):
            scope_and_render("SELECT count() FROM spans", PID)

    def test_the_scope_parameter_inside_a_bound_is_refused(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _bypass_layer1(monkeypatch)
        with pytest.raises(SqlValidationError, match="unverified time bound"):
            scope_and_render(
                "SELECT count() FROM spans WHERE span_start_time >= {scope_project_id:DateTime64(3)}",
                PID,
            )

    @pytest.mark.parametrize("name", ["scope_project_id", "SCOPE_other", "project_id"])
    def test_a_reserved_parameter_outside_the_view_call_is_refused(
        self, name: str, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _bypass_layer1(monkeypatch)
        with pytest.raises(SqlValidationError, match="reserved parameter"):
            scope_and_render(f"SELECT {{{name}:String}} AS p FROM spans", PID)

    def test_a_column_in_a_bound_is_refused_even_if_extraction_lets_it_through(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Verification has its own constant check, so a defect in extraction
        # cannot also blind the layer meant to catch it.
        monkeypatch.setattr(rewriter_mod, "_is_constant_bound", lambda node: True)
        with pytest.raises(SqlValidationError, match="unverified time bound"):
            scope_and_render(
                "SELECT s.span_id FROM spans AS s JOIN traces AS t ON s.trace_id = t.trace_id"
                " WHERE s.span_start_time >= t.trace_start_time",
                PID,
            )

    def test_a_bound_that_skipped_normalisation_is_refused(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Without the timezone normalisation a zoned bound shifts by its offset.
        monkeypatch.setattr(rewriter_mod, "_as_bound", lambda value: value.copy())
        with pytest.raises(SqlValidationError, match="unverified time bound"):
            scope_and_render("SELECT count() FROM spans WHERE span_start_time >= '2026-09-01'", PID)

    def test_bounds_combined_the_widening_way_are_refused(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        real_narrowest = rewriter_mod._narrowest
        swapped = {"greatest": "least", "least": "greatest"}
        monkeypatch.setattr(
            rewriter_mod, "_narrowest", lambda bounds, func: real_narrowest(bounds, swapped[func])
        )
        with pytest.raises(SqlValidationError, match="unverified time bound"):
            scope_and_render(
                "SELECT count() FROM spans WHERE span_start_time >= '2026-09-01'"
                " AND span_start_time >= '2026-09-05'",
                PID,
            )

    def test_a_callers_own_parameter_in_a_bound_is_accepted(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # A caller parameter is a value, like a literal, and the service binds it.
        # Layer 1 on this branch still refuses placeholders, so it is bypassed to
        # prove Layer 3 alone does not reject the shape.
        _bypass_layer1(monkeypatch)
        rendered, binds = scope_and_render(
            "SELECT count() FROM spans WHERE span_start_time >= {since:DateTime64(3)}", PID
        )
        assert "toDateTime64({since: DateTime64(3)}, 3)" in _view_call(rendered, "spans_public_v1")
        assert binds == {"scope_project_id": PID}
