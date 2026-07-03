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
from sqlglot.optimizer.scope import build_scope

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
        # NOTE: `uniq` is intentionally absent. sqlglot normalises `uniq()` to
        # exp.ApproxDistinct (sql_name "APPROX_DISTINCT"), which is not in this
        # allowlist, so `uniq()` is rejected. `uniqExact` keeps its name and is
        # allowed. To support `uniq`, add "approx_distinct" here deliberately.
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
        # --- F5: common analytics functions (date bucketing, string, agg, window).
        # These are the lowercased names `_func_name` yields. Most match the
        # ClickHouse spelling, but a few sqlglot MODELLED functions canonicalise
        # to a different name (documented per line); a per-function test pins each
        # so a sqlglot upgrade that changes normalisation fails loudly.
        "tostartofminute",
        "tostartofhour",
        "tostartofday",
        "tostartofinterval",
        "toyyyymm",
        "tohour",
        "time_to_str",  # ClickHouse formatDateTime() -> exp.TimeToStr
        "concat",
        "any_value",  # ClickHouse any() -> exp.AnyValue
        "arg_max",  # ClickHouse argMax() -> exp.ArgMax
        "arg_min",  # ClickHouse argMin() -> exp.ArgMin
        "grouparray",  # exp.AnonymousAggFunc, name preserved
        "stddevpop",  # exp.AnonymousAggFunc, name preserved
        "stddevsamp",  # exp.AnonymousAggFunc, name preserved
        "row_number",  # ClickHouse row_number() -> exp.RowNumber
        "rank",
        "dense_rank",
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

# Bound-parameter namespace reserved for server-side project scoping. User SQL
# may use its own {name:Type} placeholders, but never one in this namespace: a
# {scope_*:Type} placeholder could collide with (or attempt to override) the
# scope bind the rewriter/service injects. Enforced as defense-in-depth here at
# Layer 1, independent of how the service later merges the bind map.
_RESERVED_PARAM_PREFIX = "scope_"


# Func node types that preserve the user-written name in ``node.name``. Every
# other ``exp.Func`` is a modelled subclass (Count, Sum, Quantile, …) whose
# ``node.name`` is the *argument* text, not the function name.
_NAME_PRESERVING_FUNC_TYPES = (exp.Anonymous, exp.AnonymousAggFunc, exp.ParameterizedAgg)


def _func_name(node: exp.Func) -> str:
    """Return the lowercased canonical name for a function node.

    For ``exp.Anonymous``, ``exp.AnonymousAggFunc``, and ``exp.ParameterizedAgg``
    sqlglot preserves the original user-written name in ``node.name`` (these are
    NOT subclasses of one another, so all three are listed explicitly).

    For every other (modelled) subclass, ``node.name`` returns the *first
    argument's* text — e.g. ``count(*)`` is ``exp.Count(this=Star())`` whose
    ``name`` is ``"*"`` — so it must NOT be used as the function name. We use
    ``sql_name()`` instead, a stable canonical identifier (``COUNT``, ``SUM``,
    ``QUANTILE``, …). This makes ``count(*)``, ``count()`` and ``count(col)`` all
    resolve to ``count``.
    """
    if isinstance(node, _NAME_PRESERVING_FUNC_TYPES):
        return (node.name or "").lower()
    return node.sql_name().lower()


def is_blocked_function(node: exp.Expression) -> bool:
    """Return ``True`` if *node* is a callable function blocked by the policy.

    A node is blocked when it is a real function call (an ``exp.Func`` that is
    not one of the structural skip-types such as ``CAST`` / ``CASE``) whose
    canonical name is in ``BLOCKED_FUNCTIONS`` or starts with a
    ``BLOCKED_PREFIXES`` entry.  Non-function nodes and skip-types return
    ``False``.

    This is the public surface other gateway stages (e.g. the rewriter's
    post-rewrite re-scan) use, so they do not depend on the validator's private
    helpers.
    """
    if not isinstance(node, exp.Func) or isinstance(node, _SKIP_FUNC_TYPES):
        return False
    name = _func_name(node)
    return name in BLOCKED_FUNCTIONS or any(name.startswith(p) for p in BLOCKED_PREFIXES)


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

    public_table_names = set(PUBLIC_TABLES)  # {"spans", "traces"}

    # 6. CTE shadow: reject any CTE whose alias matches a public table name.
    for node in tree.walk():
        if isinstance(node, exp.CTE) and node.alias.lower() in public_table_names:
            raise SqlValidationError("A CTE may not shadow a reserved public table name")

    # 5b (scope-aware). Build a set of exp.Table node identities that are
    # legitimate CTE references — i.e. the CTE they name is visible IN THE
    # SAME SCOPE where the table reference appears.
    #
    # The flat-global-set approach (used before this fix) allowed an attacker to
    # smuggle a real table name past the whitelist by defining a same-named CTE
    # in a DIFFERENT scope (subquery, UNION arm).  sqlglot's build_scope() gives
    # per-scope CTE visibility via scope.cte_sources (dict: alias → CTE node),
    # which is exactly what we need.
    #
    # Fail CLOSED: if scope resolution fails for any reason, reject the query
    # rather than falling back to the insecure flat-set approach.
    try:
        root_scope = build_scope(tree)
    except Exception as exc:
        raise SqlValidationError("SQL could not be analyzed for table access") from exc

    if root_scope is None:
        raise SqlValidationError("SQL could not be analyzed for table access")

    # Mark every exp.Table node whose name is visible as a CTE in its own scope.
    cte_ref_ids: set[int] = set()
    for scope in root_scope.traverse():
        for table in scope.tables:
            if table.name.lower() in scope.cte_sources:
                cte_ref_ids.add(id(table))

    # Walk the full AST (including subqueries, CTEs, window bodies) for all
    # remaining policy checks.
    for node in tree.walk():
        # 8/9. SETTINGS and FORMAT clauses, at any nesting level. Checked on
        #      exp.Query (not just exp.Select): these modifiers can attach to a
        #      set-operation root (exp.Union) or a Subquery — e.g.
        #      `A UNION ALL (B) SETTINGS …` or `(A UNION ALL B) FORMAT JSON` —
        #      which an exp.Select-only check would miss.
        if isinstance(node, exp.Query):
            if node.args.get("settings"):
                raise SqlValidationError("SETTINGS clause is not allowed")
            if node.args.get("format"):
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

            # CTE alias references are allowed only when the CTE is visible
            # in this table's own scope (scope-aware; see cte_ref_ids above).
            if id(node) in cte_ref_ids:
                continue

            # Must be a known public table.
            if table_name not in public_table_names:
                raise SqlValidationError("Table is not in the allowed public schema")

        # 7. project_id as a column reference (SELECT project_id / WHERE project_id = …)
        #    or as an output alias (… AS project_id). Both use the same generic
        #    wording so the error never names the reserved tenant-scoping column
        #    (keeps messages sanitized / avoids confirming internal schema).
        if isinstance(node, exp.Column) and node.name.lower() == "project_id":
            raise SqlValidationError("Access to a restricted column is not allowed")

        if isinstance(node, exp.Alias) and node.alias.lower() == "project_id":
            raise SqlValidationError("Access to a restricted column is not allowed")

        # 11. Reserved bound-parameter names ({name:Type}). ClickHouse
        #     bound-parameter names parse as Placeholder(this=Var(name)).
        #     User SQL may use its OWN placeholders (a legitimate product
        #     feature — the request's `parameters` payload binds them), but never
        #     a name reserved for server-side project scoping: the exact tenant
        #     key `project_id` or anything in the `scope_` namespace. Blocking
        #     these here (Layer 1, case-insensitive) means a user placeholder can
        #     never collide with or override the scope bind, independent of how
        #     the service later merges the bind map.
        if isinstance(node, exp.Placeholder):
            var = node.this
            param_name = var.name if isinstance(var, exp.Expression) else str(var or "")
            lowered = param_name.lower()
            if lowered == "project_id" or lowered.startswith(_RESERVED_PARAM_PREFIX):
                raise SqlValidationError("Bound parameters may not use a reserved name")

        # 10. Function gate — allowlist-primary.
        if isinstance(node, exp.Func) and not isinstance(node, _SKIP_FUNC_TYPES):
            # Blocklist wins over allowlist.
            if is_blocked_function(node):
                raise SqlValidationError("Function is blocked by the security policy")

            if _func_name(node) not in ALLOWED_FUNCTIONS:
                raise SqlValidationError("Function is not in the allowed list")

    return tree  # type: ignore[return-value]
