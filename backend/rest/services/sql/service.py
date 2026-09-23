"""Execution for the SQL Gateway: run a validated, scoped query and shape it.

This is the seam between the layers that decide what a query is allowed to be
and the database that answers it. It validates and scopes through
``scope_and_render``, caps the rows the caller can receive, executes as the
read-only account, and turns whatever ClickHouse says into either a result or an
error that reveals nothing about the query's rewritten form.

Two constraints here are not obvious and were both learned the expensive way.

**The service sends no per-query settings.** Under ``readonly = 1`` the
read-only account returns ``Code: 164`` for *any* settings override, including
one stricter than the profile it already has. Execution-time, result-row,
result-byte and memory caps therefore live on the account's settings profile in
a hardened deployment, and on the client handle in the self-host fallback where
no read-only account exists. Sending them from here breaks every query.

**The row cap is a wrapper, not a clause the caller can influence.** The cap is
applied as ``SELECT * FROM (<rewritten>) LIMIT n+1`` around the whole rewritten
query. An inner ``LIMIT`` the caller wrote still applies to the inner query, and
the outer one still decides how many rows leave this process, so the effective
count is ``min(caller's limit, cap)``. The extra row is the truncation sentinel:
if it comes back, more rows existed than the caller may have.

**A result with no rows carries no column metadata.** The driver reports neither
names nor types for one, and an empty answer is the ordinary answer to a
time-windowed query over a quiet day, so the response would not say what it was
empty of: a CSV rendering loses its header row, and nothing reading the JSON can
learn the shape of the answer. The projection is therefore derived from the
caller's own statement in that case, which is the only reason this module reads
SQL on the success path at all.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import sqlglot
import sqlglot.expressions as exp
from clickhouse_connect.driver.exceptions import ClickHouseError
from sqlglot.errors import SqlglotError
from sqlglot.optimizer.qualify import qualify
from sqlglot.optimizer.scope import build_scope

from rest.services.sql.errors import SqlExecutionError
from rest.services.sql.rewriter import scope_and_render
from rest.services.sql.schema import PUBLIC_TABLES
from shared.config import settings

if TYPE_CHECKING:  # pragma: no cover - import cycle only matters for type checkers
    from db.clickhouse.client import ClickHouseClient

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SqlColumn:
    """One column of a result, named and typed as ClickHouse reported it.

    ``type`` is ``None`` only for a result that came back with no rows and so no
    metadata, and whose expression the curated schema cannot type on its own.
    """

    name: str
    type: str | None


@dataclass(frozen=True)
class SqlResult:
    """A completed query, already trimmed to what the caller may receive."""

    columns: list[SqlColumn]
    rows: list[list[Any]]
    row_count: int
    truncated: bool
    elapsed_ms: int
    statistics: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Error classification
# ---------------------------------------------------------------------------

#: The raw text for these quotes the caller's own SQL back, as in "In scope
#: SELECT toDateTime('...')", so the sentence returned is fixed and derived from
#: nothing in it.
_BAD_LITERAL = "Query contains a value that cannot be parsed as the type it is used as."

#: ClickHouse puts its numeric error code at the head of the message, as in
#: ``Code: 241. DB::Exception: Memory limit (total) exceeded ...``.
_CODE_RE = re.compile(r"\bCode:\s*(\d+)")

#: Codes the caller can act on, each mapped to a sentence that describes the
#: problem without quoting anything about the query.
#:
#: Keyed on the code rather than on words in the message, because the codes are
#: a stable interface and the prose is not. The important half of this design is
#: the default: a code that is not here is opaque by construction, so a future
#: ClickHouse release cannot introduce a message that leaks a view name simply
#: because nobody had seen it yet. A substring scrub gets that backwards.
_CLIENT_ERRORS: dict[int, str] = {
    159: "Query exceeded the maximum execution time.",
    160: "Query was estimated to take longer than the maximum execution time.",
    241: "Query exceeded the maximum memory allowed.",
    396: "Query result exceeded the maximum size allowed.",
    158: "Query result exceeded the maximum number of rows allowed.",
    43: "Query uses an argument of the wrong type for that function.",
    53: "Query compares or combines values of incompatible types.",
    47: "Query references a column that does not exist in the public schema.",
    386: "Query combines values that have no common type.",
    # A literal the caller wrote that the type it is used as cannot hold, such as
    # toDateTime('2026-09-17 19:01:56.000'), which ClickHouse parses only without
    # the fractional part. Measured on 25.2: 6 for most conversions, 38 and 41 for
    # the date and datetime ones. These sit beside 43, 53 and 47 above, which are
    # the same kind of fact, that the caller's SQL is wrong in a way they can see
    # and fix. The rewriter's own rendered literals are fixed sentinels that parse,
    # and a caller's bound expression is passed through verbatim, so a parse
    # failure in one is still the caller's literal.
    6: _BAD_LITERAL,
    38: _BAD_LITERAL,
    41: _BAD_LITERAL,
}

# Deliberately absent, so they surface as server errors and alert:
#
# * 60, unknown table. Layer 1 refuses every table outside the curated schema, so
#   a table ClickHouse cannot find means the curated views are missing.
# * 62, syntax error. Layer 1 refuses anything sqlglot cannot parse, and what
#   runs is rendered from the AST, so a syntax error means the rendered SQL
#   diverged from what ClickHouse accepts.
#
# Blaming the caller for either would send them to debug a query that was fine,
# while a deployment defect reached production without a single 5xx.

#: Code 456 has two causes that need opposite answers. A placeholder in the
#: caller's own query with no supplied value is the caller's to fix. A view
#: argument the rewriter did not supply is a rewriter and view signature skew,
#: which must surface as a server error. Told apart by the name ClickHouse
#: reports, so a query that omits its own parameter cannot mask a skew.
_UNKNOWN_QUERY_PARAMETER = 456

#: ClickHouse names the missing substitution in the message, as in
#: ``Substitution `min_ms` is not set``. Read only to compare against the caller's
#: own placeholders, never to build the message returned. If the wording ever
#: changes, the match fails and the failure stays a server error, which is the
#: safe direction: a deployment defect keeps alerting, and the only cost is a
#: caller seeing a generic message for their own missing parameter.
_MISSING_SUBSTITUTION_RE = re.compile(r"[Ss]ubstitution\s+[`'\"]?([A-Za-z_][A-Za-z0-9_]*)")
_MISSING_PARAMETER = "Query uses a parameter that was not supplied."

#: A value ClickHouse cannot parse as the type the caller declared is also the
#: caller's to fix, and the code alone cannot say so. There is one code per type
#: family, from 38 and 41 through 376, 457, 467, 675 and 691, the set grows with
#: every type ClickHouse adds, and 27 and 130 are generic parse codes a server
#: defect could reach as well. What every one of them carries is the clause
#: ClickHouse appends on the substitution path, which names the parameter, so
#: blame follows that name exactly as it does for 456: a name the caller did not
#: supply, or wording that stops matching, leaves the failure a server error.
_BAD_VALUE_RE = re.compile(r"for query parameter\s+[`'\"]?([A-Za-z_][A-Za-z0-9_]*)")
_BAD_PARAMETER_VALUE = "Query supplied a parameter value that its declared type cannot hold."

_UNEXPECTED = "Query execution failed."

#: Parameter names the caller may not supply. ``scope_project_id`` is the scope
#: bind, and the prefix reserves room for the bounds the rewriter may add later.
#: Layer 1 refuses these inside the SQL; this refuses them in the payload, so
#: neither half depends on the other having done it.
_RESERVED_PARAM_PREFIX = "scope_"

#: A parameter name is sent to the server as ``param_<name>`` in the request, so
#: a name carrying a separator could add a request field of its own rather than a
#: value. Restricting names to identifiers removes the question instead of
#: relying on the driver to encode them. Checked with ``fullmatch``: under
#: ``match`` a ``$`` anchor also matches just before a trailing newline, so
#: ``"abc\n"`` would pass as an identifier.
_PARAM_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _scrubbed(parameters: dict[str, Any] | None) -> dict[str, Any]:
    """Return the caller's parameters, refusing reserved and malformed names."""
    if not parameters:
        return {}
    for name in parameters:
        if not isinstance(name, str) or not _PARAM_NAME_RE.fullmatch(name):
            raise SqlExecutionError(
                "Query parameter names must be plain identifiers.", is_client_error=True
            )
        lowered = name.lower()
        if lowered == "project_id" or lowered.startswith(_RESERVED_PARAM_PREFIX):
            raise SqlExecutionError(
                "Query parameters may not use a reserved name.", is_client_error=True
            )
    return dict(parameters)


def classify_ch_error(raw: str) -> tuple[str, bool]:
    """Map a raw ClickHouse error to a safe message and a blame assignment.

    Returns ``(message, is_client_error)``. Anything unrecognised is reported as
    a generic failure the caller cannot act on, which is the behaviour that
    makes new and unknown codes safe without anyone revisiting this table.
    """
    code = _error_code(raw)
    if code in _CLIENT_ERRORS:
        return _CLIENT_ERRORS[code], True
    return _UNEXPECTED, False


def _error_code(raw: str) -> int | None:
    match = _CODE_RE.search(raw or "")
    return int(match.group(1)) if match else None


def _caller_parameter_missing(raw: str, query: str, supplied: dict[str, Any]) -> bool:
    """True if the substitution ClickHouse names is the caller's own and unsupplied.

    Matching the reported name, rather than asking whether any caller parameter is
    missing, is what keeps a caller who omits their own parameter from masking a
    view argument the rewriter failed to supply. Everything here runs only on the
    failure path, so a successful query pays nothing.
    """
    match = _MISSING_SUBSTITUTION_RE.search(raw or "")
    if match is None:
        return False
    name = match.group(1)
    if name in supplied:
        return False
    return name in _placeholder_names(query)


def _caller_parameter_unparseable(raw: str, supplied: dict[str, Any]) -> bool:
    """True if ClickHouse refused the value of a parameter the caller supplied.

    The rewriter binds only ``scope_project_id``, a String, which no value fails
    to parse as, and the scrub refuses that name from the payload. So a reported
    name that is in the caller's own parameters came from the caller's own value.
    """
    match = _BAD_VALUE_RE.search(raw or "")
    return match is not None and match.group(1) in supplied


def _placeholder_names(query: str) -> set[str]:
    """The ``{name:Type}`` placeholders the caller wrote.

    The query already passed Layer 1, so it parses; if it somehow does not, the
    set is empty and the failure stays a server error.
    """
    try:
        tree = sqlglot.parse_one(query, dialect="clickhouse")
    except SqlglotError:
        return set()
    return {
        placeholder.this.name
        if isinstance(placeholder.this, exp.Expression)
        else str(placeholder.this)
        for placeholder in tree.find_all(exp.Placeholder)
    }


# ---------------------------------------------------------------------------
# Describing a result the driver did not describe
# ---------------------------------------------------------------------------

#: The curated schema in the shape sqlglot's qualifier wants. It is what lets a
#: ``SELECT *`` expand to the columns the views actually project, and it is the
#: same contract ``GET /sql/schema`` publishes, so the two cannot disagree.
_CURATED_SCHEMA: dict[str, dict[str, str]] = {
    name: {column.name: column.type for column in table.columns}
    for name, table in PUBLIC_TABLES.items()
}


def _name_projections(node: exp.Expression) -> exp.Expression:
    """Give every unnamed projection the text the caller wrote as its name.

    The qualifier invents ``_col_0`` for an expression with no alias, which is a
    name nobody wrote and ClickHouse never returns. The expression's own text is
    at least the caller's own words, and it is what they would see rendered as a
    CSV header. It is not always what ClickHouse would have called the column:
    the server names an unaliased expression by its canonical form, so
    ``duration_ms * 2`` comes back as ``multiply(duration_ms, 2)`` when there are
    rows behind it. Aliasing the expression is how a caller pins either one.
    """
    if isinstance(node, exp.Select):
        node.set(
            "expressions",
            [
                projection
                if projection.output_name
                else exp.alias_(projection, projection.sql(dialect="clickhouse"), quoted=True)
                for projection in node.expressions
            ],
        )
    return node


def _widened_by_array_join(tree: exp.Expression) -> bool:
    """True if a ``*`` in *tree* stands for more columns than the schema names.

    ARRAY JOIN puts its own aliases in the row, and the curated schema describes
    only the view's columns, so expanding a star from the schema alongside one
    would name a projection shorter than the answer. It is the one construct the
    gateway allows that widens a row this way; everything else a star can stand
    for is a curated column or resolved from a subquery's own projection.
    """
    return any(join.args.get("kind") == "ARRAY" for join in tree.find_all(exp.Join)) and any(
        select.is_star for select in tree.find_all(exp.Select)
    )


def _projected_columns(query: str) -> list[SqlColumn]:
    """Describe the caller's projection, for a result that described nothing.

    Reads the caller's own SQL rather than the rewritten form: the rewrite
    replaces each logical table with a curated view whose name is not in the
    public schema, and the caller's statement has already passed Layer 1, so it
    parses and names nothing outside that schema. Nothing here reaches the
    database or learns anything the caller did not already write.

    Types are the half only ClickHouse settles, with one exception that is not a
    guess: a projection that resolves to a curated column carries that column's
    declared type. Anything computed comes back with no type at all, because a
    type invented here would be trusted by whatever builds a schema from the
    answer, and an absent one cannot be.

    Returns an empty list if any part of the projection cannot be resolved,
    which leaves the response as it was rather than describing it wrongly.
    """
    try:
        return _resolve_projection(query)
    except Exception:
        # Broad on purpose. This runs after a query has already succeeded, and
        # failing to describe the answer must never turn it into an error.
        logger.debug("could not derive the projection of an empty result", exc_info=True)
        return []


def _resolve_projection(query: str) -> list[SqlColumn]:
    """The work behind ``_projected_columns``, free to raise on anything odd."""
    tree = sqlglot.parse_one(query, dialect="clickhouse")
    if _widened_by_array_join(tree):
        return []
    qualified = qualify(
        tree.transform(_name_projections),
        schema=_CURATED_SCHEMA,
        dialect="clickhouse",
        quote_identifiers=False,
    )

    # A set operation takes its column names from its first arm, as ClickHouse
    # does. Its types are the common type across every arm, which nothing here
    # can work out, so the arm's own types are deliberately not read.
    root = qualified
    while isinstance(root, exp.SetOperation):
        root = root.this
    if not isinstance(root, exp.Select):
        return []

    sources: dict[str, str] = {}
    if root is qualified:
        scope = build_scope(qualified)
        if scope is not None:
            sources = {
                alias: source.name
                for alias, source in scope.sources.items()
                if isinstance(source, exp.Table) and source.name in PUBLIC_TABLES
            }

    columns: list[SqlColumn] = []
    for projection in root.expressions:
        if not projection.output_name or projection.is_star:
            # One projection nobody can name leaves the whole list unreliable,
            # and a list that does not match the answer is worse than none.
            return []
        inner = projection.this if isinstance(projection, exp.Alias) else projection
        ch_type: str | None = None
        if isinstance(inner, exp.Column):
            table = sources.get(inner.table)
            if table is not None:
                ch_type = _CURATED_SCHEMA[table].get(inner.name)
        columns.append(SqlColumn(name=projection.output_name, type=ch_type))
    return columns


class SqlQueryService:
    """Runs public SQL for one project and returns rows the caller may see."""

    def __init__(
        self,
        client: ClickHouseClient | None = None,
        *,
        max_rows_ceiling: int | None = None,
    ) -> None:
        self._client = client
        # One below the server's row cap, because the sentinel row is fetched on
        # top of the ceiling. At the cap itself the sentinel trips Code 396 and a
        # large query fails instead of coming back truncated.
        self._ceiling = max_rows_ceiling or max(settings.clickhouse.sql_max_result_rows - 1, 1)

    def _resolve_client(self) -> ClickHouseClient:
        if self._client is not None:
            return self._client
        # Imported here so constructing the service never reaches for a database
        # connection, which keeps the unit tests free of one.
        from db.clickhouse.client import get_readonly_clickhouse_client

        self._client = get_readonly_clickhouse_client()
        return self._client

    def _effective_max(self, max_rows: int | None) -> int:
        if max_rows is None:
            return self._ceiling
        if not isinstance(max_rows, int) or isinstance(max_rows, bool) or max_rows < 1:
            raise SqlExecutionError(
                "max_rows must be a positive whole number.", is_client_error=True
            )
        # The ceiling is the server's, so asking for more than it does not raise
        # it. A caller asking for fewer rows than the ceiling gets what it asked.
        return min(max_rows, self._ceiling)

    def run(
        self,
        query: str,
        project_id: str,
        *,
        parameters: dict[str, Any] | None = None,
        max_rows: int | None = None,
    ) -> SqlResult:
        """Validate, scope, execute and shape one query.

        Raises ``SqlValidationError`` before touching the database if the query
        violates the read-only contract, and ``SqlExecutionError`` if the
        database refuses or fails it.
        """
        effective_max = self._effective_max(max_rows)
        caller_params = _scrubbed(parameters)

        # Layers 1 to 3. Raises SqlValidationError, which the caller maps to 400.
        scoped_sql, bind_params = scope_and_render(query, project_id)

        # The scope bind goes on last and wins outright. The scrub above already
        # refuses these names, so the ordering is the second of two independent
        # reasons a caller cannot displace the tenant scope.
        merged_params = {**caller_params, **bind_params}

        wrapped = f"SELECT * FROM (\n{scoped_sql}\n) LIMIT {effective_max + 1}"

        client = self._resolve_client()
        started = time.perf_counter()
        try:
            # No settings argument. See the module docstring: readonly = 1
            # refuses every per-query override, stricter ones included.
            result = client.query(wrapped, parameters=merged_params)
        except ClickHouseError as exc:
            message, is_client_error = classify_ch_error(str(exc))
            if _error_code(str(exc)) == _UNKNOWN_QUERY_PARAMETER and _caller_parameter_missing(
                str(exc), query, caller_params
            ):
                message, is_client_error = _MISSING_PARAMETER, True
            elif _caller_parameter_unparseable(str(exc), caller_params):
                message, is_client_error = _BAD_PARAMETER_VALUE, True
            # The raw text may name the curated views, so it is logged and never
            # returned. Nothing derived from it reaches the caller except the
            # sentence chosen above.
            logger.warning("public sql execution failed", exc_info=exc)
            raise SqlExecutionError(message, is_client_error=is_client_error) from exc
        elapsed_ms = int((time.perf_counter() - started) * 1000)

        rows = [list(row) for row in result.result_rows]
        truncated = len(rows) > effective_max
        if truncated:
            del rows[effective_max:]

        columns = [
            # The driver reports types as objects whose str() is a Python repr with a
            # memory address. The ClickHouse type name is the contract.
            SqlColumn(name=name, type=ch_type.name)
            for name, ch_type in zip(result.column_names, result.column_types, strict=False)
        ]
        if not columns:
            # Only when the driver said nothing. See the module docstring: a
            # result with no rows carries no metadata, and the caller's own
            # statement is what says which columns the answer is empty of.
            columns = _projected_columns(query)

        return SqlResult(
            columns=columns,
            rows=rows,
            row_count=len(rows),
            truncated=truncated,
            elapsed_ms=elapsed_ms,
            statistics=_statistics(result),
        )


def _statistics(result: Any) -> dict[str, Any]:
    """Best-effort read counters, which the driver does not always populate."""
    summary = getattr(result, "summary", None) or {}
    stats: dict[str, Any] = {}
    for key, out in (("read_rows", "rows_read"), ("read_bytes", "bytes_read")):
        value = summary.get(key)
        if value is not None:
            try:
                stats[out] = int(value)
            except (TypeError, ValueError):
                continue
    return stats
