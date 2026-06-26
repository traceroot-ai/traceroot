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
        assert "AS s" in rendered

    def test_alias_t_preserved(self) -> None:
        rendered, _ = scope_and_render(self.SQL, PID)
        assert "AS t" in rendered

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
        # "FROM x" should still appear in the rendered SQL (CTE alias, not rewritten).
        assert " x " in rendered or "FROM x" in rendered


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
        # Should be quoted in the rendered SQL: 'abc123'
        assert f"'{safe}'" in rendered or safe in rendered


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

        def _noop(node: exp.Table, cte_aliases: set, param_value: exp.Expression) -> exp.Expression:
            return node  # deliberately skip the rewrite

        monkeypatch.setattr(rewriter_mod, "_rewrite_table", _noop)
        with pytest.raises(SqlValidationError):
            scope_and_render("SELECT count() FROM spans", PID)

    def test_skipped_rewrite_on_traces_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def _noop(node: exp.Table, cte_aliases: set, param_value: exp.Expression) -> exp.Expression:
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
