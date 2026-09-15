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

from rest.services.sql.errors import SqlExecutionError
from rest.services.sql.rewriter import scope_and_render
from shared.config import settings

if TYPE_CHECKING:  # pragma: no cover - import cycle only matters for type checkers
    from db.clickhouse.client import ClickHouseClient

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SqlColumn:
    """One column of a result, named and typed as ClickHouse reported it."""

    name: str
    type: str


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
#: which must surface as a server error. Told apart by ``_missing_parameters``.
_UNKNOWN_QUERY_PARAMETER = 456
_MISSING_PARAMETER = "Query uses a parameter that was not supplied."

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


def _missing_parameters(query: str, supplied: dict[str, Any]) -> bool:
    """True if the caller's query names a placeholder the caller did not supply.

    Parsed only on the failure path that needs it, so a successful query pays
    nothing. The query already passed Layer 1, so it parses; if it somehow does
    not, the answer is False and the failure stays a server error.
    """
    try:
        tree = sqlglot.parse_one(query, dialect="clickhouse")
    except SqlglotError:
        return False
    names = {
        placeholder.this.name
        if isinstance(placeholder.this, exp.Expression)
        else str(placeholder.this)
        for placeholder in tree.find_all(exp.Placeholder)
    }
    return bool(names - supplied.keys())


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
            if _error_code(str(exc)) == _UNKNOWN_QUERY_PARAMETER and _missing_parameters(
                query, caller_params
            ):
                message, is_client_error = _MISSING_PARAMETER, True
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
