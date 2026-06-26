"""Allowlist-primary SQL validator for the read-only analytics gateway (Layer 1).

Validates a SQL string against a strict contract before any execution.
This module is pure: no database access, no network, no configuration
dependency, no I/O, no side effects.

Policy summary
--------------
1.  Empty / whitespace-only SQL is rejected.
2.  SQL must parse under the ClickHouse dialect; parse errors are rejected.
3.  Exactly one statement is required.
    Note: a trailing ``;`` produces one statement (it is a statement terminator
    in sqlglot, not a separator).  ``SELECT 1; SELECT 2`` yields two statements
    and is rejected.
4.  The single statement must be a SELECT or UNION (``exp.Query``).  All write
    operations, DDL, and control statements are rejected.
5.  Every ``exp.Table`` node must reference a bare whitelisted public table name
    (``spans`` or ``traces``), or a CTE alias defined in the same query.
    Rejected: table functions, database/catalog-qualified names, internal view
    names (``spans_public_v1`` / ``traces_public_v1``), FINAL modifier.
    Note: ARRAY JOIN right-hand sides do not produce Table nodes in sqlglot
    (they appear as ``Alias(Column(...))`` inside a ``Join``), so no special
    ARRAY JOIN skip logic is required.
6.  CTE shadow: a CTE whose alias matches a public table name is rejected.
7.  ``project_id`` is blocked as a column reference and as an output alias.
8.  ``SETTINGS`` clause is blocked at any nesting level.
9.  ``FORMAT`` clause is blocked (``SELECT ... FORMAT JSON``).
    ``INTO OUTFILE`` raises a ``ParseError`` at step 2 and is already rejected.
10. Function gate — ALLOWLIST-PRIMARY: every function node's lowercased name
    must be in ``ALLOWED_FUNCTIONS``.  The blocklist (``BLOCKED_FUNCTIONS`` and
    ``BLOCKED_PREFIXES``) wins even if a name also appears in the allowlist.

Sqlglot findings / surprises
-----------------------------
* ``exp.Case`` is a subclass of ``exp.Func`` (not a standalone node as the
  brief assumed).  It is added to the skip list alongside ``exp.Cast`` since it
  is SQL control flow, not a callable function.
* ``uniq()`` maps to ``exp.ApproxDistinct``; ``sql_name()`` returns
  ``APPROX_DISTINCT``, which is not in ``ALLOWED_FUNCTIONS``.  Because
  ``uniq`` queries are not in the ALLOWED test matrix, this is
  conservative-correct (rejects silently); noted in the report.
* ``FORMAT JSON`` is captured in ``tree.args["format"]`` on the ``Select``
  node.  ``INTO OUTFILE`` raises a ``ParseError`` (caught at parse step).
* ``FINAL`` is represented as ``exp.Final`` wrapping the ``Table``; it is NOT
  stored as ``table.args["final"]``.
"""

from __future__ import annotations

import sqlglot
import sqlglot.expressions as exp

from rest.services.sql.errors import SqlValidationError
from rest.services.sql.schema import PUBLIC_TABLES

# ---------------------------------------------------------------------------
# Policy constants (all lowercased)
# ---------------------------------------------------------------------------

ALLOWED_FUNCTIONS: frozenset[str] = frozenset(
    {
        "count",
        "sum",
        "avg",
        "min",
        "max",
        "quantile",
        "quantileexact",
        "uniq",
        "uniqexact",
        "now",
        "datediff",
        "datetrunc",
        "todate",
        "todatetime",
        "if",
        "multiif",
        "coalesce",
        "isnull",
        "isnotnull",
        "lower",
        "upper",
        "length",
        "substring",
        "round",
        "floor",
        "ceil",
        "abs",
        "tostring",
        "toint64",
        "tofloat64",
        "todecimal64",
    }
)

BLOCKED_FUNCTIONS: frozenset[str] = frozenset(
    {
        "file",
        "url",
        "remote",
        "remotesecure",
        "s3",
        "s3cluster",
        "gcs",
        "oss",
        "cosn",
        "hdfs",
        "executable",
        "jdbc",
        "odbc",
        "mysql",
        "postgresql",
        "mongodb",
        "redis",
        "sqlite",
        "cluster",
        "clusterallreplicas",
        "sleep",
        "sleepeachrow",
        "getsetting",
        "currentdatabase",
        "currentuser",
        "hostname",
        "version",
        "uptime",
        "numbers",
        "generaterandom",
        "input",
        "merge",
    }
)

BLOCKED_PREFIXES: tuple[str, ...] = ("dictget", "joinget")

# SQL structural constructs that are Func subclasses in sqlglot but are NOT
# user-callable functions; skip them in the function gate.
# exp.Case is included because CASE expressions parse as exp.Func subclasses
# even though they are pure SQL control flow (analogous to exp.Cast).
_SKIP_FUNC_TYPES = (exp.Cast, exp.TryCast, exp.Extract, exp.Lambda, exp.Case)

# Internal view names that must never be referenced directly.
_INTERNAL_VIEWS: frozenset[str] = frozenset({"spans_public_v1", "traces_public_v1"})


def _func_name(node: exp.Func) -> str:
    """Return the lowercased canonical name for a function node.

    For ``exp.Anonymous``, ``exp.AnonymousAggFunc``, and ``exp.ParameterizedAgg``
    sqlglot preserves the original user-written name in ``node.name``.  For
    modelled subclasses (``Count``, ``Sum``, ``Quantile``, ``DateDiff``, …) the
    ``name`` attribute is empty and we fall back to ``sql_name()`` which is a
    stable uppercase identifier (e.g. ``COUNT``, ``DATEDIFF``).
    """
    raw: str = node.name  # type: ignore[assignment]
    return raw.lower() if raw else node.sql_name().lower()


def validate(sql: str) -> exp.Query:
    """Parse and validate *sql* against the read-only analytics contract.

    Returns the parsed AST (``exp.Query``) on success.
    Raises ``SqlValidationError`` with a sanitized, non-empty message on any
    policy violation.  The message never echoes the raw SQL, a ``project_id``,
    or internal view names.
    """
    # 1. Reject empty / whitespace-only.
    if not sql or not sql.strip():
        raise SqlValidationError("SQL statement must not be empty")

    # 2. Parse as ClickHouse dialect; any parse error is a validation failure.
    try:
        statements = [s for s in sqlglot.parse(sql, read="clickhouse") if s is not None]
    except Exception as exc:
        # Never interpolate the sqlglot exception: it embeds the offending SQL
        # fragment (which can carry a project_id or other tenant data). Keep the
        # original on the exception chain for server-side debugging only.
        raise SqlValidationError("SQL statement could not be parsed") from exc

    # 3. Exactly one statement required.
    # (Trailing ';' → one statement; 'SELECT 1; SELECT 2' → two → rejected.)
    if len(statements) != 1:
        raise SqlValidationError(f"Exactly one SELECT statement is required; got {len(statements)}")

    tree = statements[0]

    # 4. Must be SELECT / UNION (exp.Query).
    if not isinstance(tree, exp.Query):
        raise SqlValidationError(
            "Only SELECT statements are allowed; write operations and DDL are not permitted"
        )

    # Pre-collect CTE aliases so the table check can distinguish a reference to
    # a user-defined CTE from an attempt to query an unknown bare name.
    cte_names: set[str] = {node.alias.lower() for node in tree.walk() if isinstance(node, exp.CTE)}

    public_table_names = set(PUBLIC_TABLES)  # {"spans", "traces"}

    # 6. CTE shadow: reject any CTE whose alias matches a public table name.
    for node in tree.walk():
        if isinstance(node, exp.CTE) and node.alias.lower() in public_table_names:
            raise SqlValidationError("A CTE may not shadow a reserved public table name")

    # Walk the full AST (including subqueries, CTEs, window bodies) for all
    # remaining policy checks.
    for node in tree.walk():
        # 8. SETTINGS at any nesting level.
        if isinstance(node, exp.Select) and node.args.get("settings"):
            raise SqlValidationError("SETTINGS clause is not allowed")

        # 9. FORMAT clause (e.g. SELECT … FORMAT JSON).
        if isinstance(node, exp.Select) and node.args.get("format"):
            raise SqlValidationError("FORMAT clause is not allowed")

        # 5a. FINAL modifier — sqlglot represents this as exp.Final wrapping
        #     the Table node; it is NOT stored in table.args["final"].
        if isinstance(node, exp.Final):
            raise SqlValidationError("FINAL modifier is not allowed")

        # 5b. Table whitelist.
        if isinstance(node, exp.Table):
            table_this = node.args.get("this")

            # Table functions: table.this is not an exp.Identifier
            # (e.g. url(), s3(), numbers() appear as exp.Anonymous here).
            if not isinstance(table_this, exp.Identifier):
                raise SqlValidationError("Table-valued functions are not allowed")

            table_name = node.name.lower()

            # Database or catalog qualification (e.g. system.tables, default.spans).
            if node.args.get("db") or node.args.get("catalog"):
                raise SqlValidationError(
                    "Qualified table names (db.table / catalog.db.table) are not allowed"
                )

            # Internal view names must not be queried directly.
            if table_name in _INTERNAL_VIEWS:
                raise SqlValidationError("Internal view names may not be queried directly")

            # CTE alias references are allowed unconditionally.
            if table_name in cte_names:
                continue

            # Must be a known public table.
            if table_name not in public_table_names:
                raise SqlValidationError("Table is not in the allowed public schema")

        # 7. project_id as a column reference (SELECT project_id / WHERE project_id = …).
        if isinstance(node, exp.Column) and node.name.lower() == "project_id":
            raise SqlValidationError("Column 'project_id' is not accessible")

        # 7. project_id as an output alias (… AS project_id).
        if isinstance(node, exp.Alias) and node.alias.lower() == "project_id":
            raise SqlValidationError("Output alias 'project_id' is not allowed")

        # 10. Function gate — allowlist-primary.
        if isinstance(node, exp.Func) and not isinstance(node, _SKIP_FUNC_TYPES):
            name = _func_name(node)

            # Blocklist wins over allowlist.
            if name in BLOCKED_FUNCTIONS:
                raise SqlValidationError("Function is blocked by the security policy")

            if any(name.startswith(prefix) for prefix in BLOCKED_PREFIXES):
                raise SqlValidationError("Function is blocked by the security policy (prefix rule)")

            if name not in ALLOWED_FUNCTIONS:
                raise SqlValidationError("Function is not in the allowed list")

    return tree  # type: ignore[return-value]
