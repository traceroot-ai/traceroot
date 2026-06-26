"""Project-scoped SQL AST rewriter + post-rewrite verification (Layer 2 + Layer 3).

Takes SQL that has passed Layer-1 validation and rewrites each whitelisted
logical table reference into its project-scoped, parameterised curated view,
then verifies the rewrite with a fail-closed AST walk.

Public interface
----------------
``USE_BOUND_PARAM : bool``
    When ``True`` (the default) the project_id value is placed in the returned
    bind map and the SQL carries the ClickHouse bound-parameter placeholder
    ``{scope_project_id:String}``.  When ``False`` the value is embedded as a
    SQL literal after passing ``PROJECT_ID_RE`` validation.

``PROJECT_ID_RE : re.Pattern``
    Literal-fallback guard — accepts only alphanumerics plus ``_``, ``:``,
    ``.``, and ``-``.

``scope_and_render(sql, project_id) -> (str, dict[str, str])``
    Validate → rewrite → verify → render.

Sqlglot empirical findings (confirmed by probing before implementation)
-----------------------------------------------------------------------
* ``{scope_project_id:String}`` is represented as
  ``Placeholder(this=Var(this='scope_project_id'),
                kind=DataType(this=Type.TEXT, nested=False, nullable=False))``
  and rendered by the ClickHouse dialect as ``{scope_project_id: String}``
  (sqlglot inserts a space after the colon).
* A parameterised-view table call such as
  ``spans_public_v1(project_id = {scope_project_id:String}) AS spans`` is a
  ``Table`` node whose ``this`` is ``Anonymous(this='spans_public_v1', ...)``.
  ``table.name`` returns ``''`` because ``table.this`` is not an
  ``exp.Identifier``; ``table.alias`` returns the alias string.
* ``tree.transform`` visits ``Table`` nodes inside JOINs, CTE bodies,
  subqueries, and both ``UNION``/``UNION ALL`` arms.
* ARRAY JOIN right-hand sides do NOT produce ``exp.Table`` nodes; they appear
  as ``Alias(Column(...))`` or ``Column(...)`` inside a ``Join``.

This module is pure: no database access, no network, no configuration
dependency, no I/O, no side effects.
"""

from __future__ import annotations

import re

import sqlglot.expressions as exp

from rest.services.sql.errors import SqlValidationError
from rest.services.sql.schema import TABLE_VIEW_MAP
from rest.services.sql.validator import (
    _SKIP_FUNC_TYPES,
    BLOCKED_FUNCTIONS,
    BLOCKED_PREFIXES,
    _func_name,
    validate,
)

# ---------------------------------------------------------------------------
# Public interface
# ---------------------------------------------------------------------------

#: When True (the default), the project_id value goes into the returned bind
#: map and the SQL carries the ClickHouse bound-parameter placeholder
#: ``{scope_project_id:String}``.  When False, the project_id is embedded as
#: a SQL literal after passing PROJECT_ID_RE validation.
USE_BOUND_PARAM: bool = True

#: Regex guard for the literal-fallback path.  Accepts only alphanumerics plus
#: ``_``, ``:``, ``.``, and ``-``.  Rejects quotes, semicolons, whitespace,
#: and empty strings.
PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9_:.\-]+$")

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

#: Curated view names from TABLE_VIEW_MAP, lowercased.  Used for Layer-3
#: verification to recognise injected view-call nodes and to exempt them from
#: the blocked-function re-scan.
_VIEW_NAMES: frozenset[str] = frozenset(v.lower() for v in TABLE_VIEW_MAP.values())


def _make_placeholder() -> exp.Placeholder:
    """Build the ``{scope_project_id:String}`` ClickHouse bound-parameter node.

    Rendered by the ClickHouse dialect as ``{scope_project_id: String}``
    (sqlglot adds a space after the colon).
    """
    return exp.Placeholder(
        this=exp.Var(this="scope_project_id"),
        kind=exp.DataType(this=exp.DataType.Type.TEXT, nested=False, nullable=False),
    )


def _build_view_table(
    view_name: str, alias: exp.TableAlias, param_value: exp.Expression
) -> exp.Table:
    """Build ``view_name(project_id = param_value) AS alias``.

    The resulting ``Table`` node has ``this=Anonymous(this=view_name, ...)``
    (not ``Identifier``), so Layer-3 verification can distinguish injected
    view-call nodes from surviving plain table references.

    *alias* is the ``exp.TableAlias`` node to attach.  The caller passes the
    user's original alias node (copied, including its ``quoted`` metadata) so a
    quoted or reserved-word alias survives the rewrite intact.
    """
    return exp.Table(
        this=exp.Anonymous(
            this=view_name,
            expressions=[
                exp.EQ(
                    this=exp.Column(this=exp.Identifier(this="project_id", quoted=False)),
                    expression=param_value.copy(),
                )
            ],
        ),
        alias=alias,
    )


def _rewrite_table(
    node: exp.Table,
    cte_aliases: set[str],
    param_value: exp.Expression,
) -> exp.Expression:
    """Rewrite a single whitelisted physical ``exp.Table`` to its curated view.

    Returns the replacement node on a match, or *node* unchanged otherwise.

    This function is module-level so that the Layer-3 fail-closed path can be
    exercised in tests by monkeypatching ``rewriter._rewrite_table``.  The
    lambda in ``scope_and_render`` looks up the name in module globals each
    time it is called, so ``monkeypatch.setattr(rewriter, '_rewrite_table', …)``
    takes effect immediately.
    """
    # Only rewrite simple Identifier-backed table references (not view calls,
    # not table functions).
    if not isinstance(node.this, exp.Identifier):
        return node
    table_name = node.name.lower()
    # CTE aliases are not physical tables; leave them unchanged.
    if table_name in cte_aliases:
        return node
    # Only rewrite tables in the whitelist.
    if table_name not in TABLE_VIEW_MAP:
        return node
    view_name = TABLE_VIEW_MAP[table_name]
    # Preserve the user's original alias node, including its quoting metadata, so
    # a quoted or reserved-word alias (e.g. ``FROM spans AS "weird alias"``)
    # survives the rewrite.  Fall back to the bare table name so that un-aliased
    # ``FROM spans`` becomes ``… AS spans``.
    original_alias = node.args.get("alias")
    if original_alias is not None:
        alias_node = original_alias.copy()
    else:
        alias_node = exp.TableAlias(this=exp.Identifier(this=table_name, quoted=False))
    return _build_view_table(view_name, alias_node, param_value)


# ---------------------------------------------------------------------------
# Layer-3 post-rewrite verification
# ---------------------------------------------------------------------------


def _verify_rewritten_ast(tree: exp.Expression, cte_aliases: set[str]) -> None:
    """Walk the rewritten AST and raise ``SqlValidationError`` if any security
    invariant is violated (fail-closed policy).

    Verification is purely AST-based — no substring matching.

    Invariants:
    1. No whitelisted physical table survived un-rewritten (``exp.Table`` with
       ``Identifier`` ``this`` whose name is in ``TABLE_VIEW_MAP`` and is not a
       CTE alias).
    2. Every injected table node names a known curated view (the ``Anonymous``
       ``this.this`` value must be in ``_VIEW_NAMES``).
    3. No blocked function was introduced: re-scan ``exp.Func`` /
       ``exp.Anonymous`` nodes against ``BLOCKED_FUNCTIONS`` /
       ``BLOCKED_PREFIXES``, exempting the ``*_public_v1`` view-call
       ``Anonymous`` nodes.
    """
    for node in tree.walk():
        # --- Invariant 1 & 2: Table node shape checks -------------------------
        if isinstance(node, exp.Table):
            if isinstance(node.this, exp.Identifier):
                # Plain table reference — must not be a whitelisted table name.
                table_name = node.name.lower()
                if table_name in TABLE_VIEW_MAP and table_name not in cte_aliases:
                    raise SqlValidationError(
                        "Post-rewrite verification failed: a whitelisted table was not rewritten"
                    )
            elif isinstance(node.this, exp.Anonymous):
                # Injected view-call node — must name a known curated view.
                fn_raw = node.this.this
                fn_name = fn_raw.lower() if isinstance(fn_raw, str) else str(fn_raw).lower()
                if fn_name not in _VIEW_NAMES:
                    raise SqlValidationError(
                        "Post-rewrite verification failed: "
                        "unexpected anonymous table reference introduced"
                    )

        # --- Invariant 3: Blocked-function re-scan ----------------------------
        if isinstance(node, exp.Func) and not isinstance(node, _SKIP_FUNC_TYPES):
            # Exempt the injected *_public_v1 view-call Anonymous nodes.
            if isinstance(node, exp.Anonymous):
                raw = node.name
                fn_name = raw.lower() if raw else ""
                if fn_name in _VIEW_NAMES:
                    continue
            name = _func_name(node)
            if name in BLOCKED_FUNCTIONS:
                raise SqlValidationError(
                    "Post-rewrite verification failed: blocked function detected"
                )
            if any(name.startswith(prefix) for prefix in BLOCKED_PREFIXES):
                raise SqlValidationError(
                    "Post-rewrite verification failed: blocked function prefix detected"
                )


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def scope_and_render(sql: str, project_id: str) -> tuple[str, dict[str, str]]:
    """Validate, scope, and render *sql* for *project_id*.

    Steps
    -----
    1. Layer-1 validate (``validate(sql)``).  Any ``SqlValidationError`` raised
       by the validator propagates unchanged.
    2. Copy the returned AST so the validator's tree is not mutated.
    3. Collect CTE aliases — table references whose name is a CTE alias must
       NOT be rewritten.
    4. Build the parameter-value node:
       - Bound mode: ``Placeholder({scope_project_id:String})``.
         ``bind_map = {"scope_project_id": project_id}``.
       - Literal mode: validate *project_id* with ``PROJECT_ID_RE``
         (raises ``SqlValidationError`` on failure), then
         ``exp.Literal.string(project_id)``.  ``bind_map = {}``.
    5. Layer-2 rewrite: ``tree.transform(_rewrite_table)`` — visits all
       ``exp.Table`` nodes in JOINs, CTE bodies, subqueries, and UNION arms.
       ARRAY JOIN right-hand sides are column/alias nodes, not ``exp.Table``,
       so they are untouched.
    6. Layer-3 post-rewrite AST verification (fail closed).
    7. Render with ``dialect="clickhouse"``.

    Returns
    -------
    ``(rendered_sql, bind_map)``

    In bound-parameter mode, *project_id* MUST NOT appear in *rendered_sql*;
    it appears only in *bind_map* under the key ``"scope_project_id"``.

    Raises
    ------
    ``SqlValidationError``
        On any policy violation (invalid SQL, blocked table/function, unsafe
        *project_id* in literal mode, or Layer-3 verification failure).
    """
    # Step 1 — Layer-1 validate.
    tree = validate(sql)
    # Step 2 — copy so we do not mutate the validator's returned tree.
    tree = tree.copy()

    # Step 3 — collect CTE aliases.
    cte_aliases: set[str] = {n.alias.lower() for n in tree.walk() if isinstance(n, exp.CTE)}

    # Step 4 — build the parameter-value expression.
    if USE_BOUND_PARAM:
        param_value: exp.Expression = _make_placeholder()
        bind_map: dict[str, str] = {"scope_project_id": project_id}
    else:
        if not PROJECT_ID_RE.fullmatch(project_id):
            raise SqlValidationError("project_id contains characters not permitted in literal mode")
        param_value = exp.Literal.string(project_id)
        bind_map = {}

    # Step 5 — Layer-2 rewrite.
    # The lambda looks up ``_rewrite_table`` in module globals on every call,
    # so ``monkeypatch.setattr(rewriter, '_rewrite_table', noop)`` takes effect.
    rewritten = tree.transform(
        lambda node: (
            _rewrite_table(node, cte_aliases, param_value) if isinstance(node, exp.Table) else node
        )
    )

    # Step 6 — Layer-3 post-rewrite verification (AST-based, fail closed).
    _verify_rewritten_ast(rewritten, cte_aliases)

    # Step 7 — render.
    return rewritten.sql(dialect="clickhouse"), bind_map
