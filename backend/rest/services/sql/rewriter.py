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
from sqlglot.optimizer.scope import build_scope

from rest.services.sql.errors import SqlValidationError
from rest.services.sql.schema import TABLE_VIEW_MAP
from rest.services.sql.validator import (
    is_blocked_function,
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

#: The arguments every injected view call carries, each exactly once. Layer 3
#: refuses a call with any other set: a missing bound fails at execution with
#: Code 456, and an extra or repeated argument means the rewrite went wrong.
_VIEW_ARGUMENTS: frozenset[str] = frozenset({"project_id", "start_time", "end_time"})

#: The column each curated view bounds its scan on. The views declare
#: ``start_time`` inclusive and ``end_time`` exclusive, applied INSIDE the dedup
#: subquery, so the bounds we pass decide which rows reach the dedup at all.
_TIME_COLUMN: dict[str, str] = {"spans": "span_start_time", "traces": "trace_start_time"}

#: Passed when the caller's query carries no bound we can express exactly. These
#: must sit outside the STORABLE range, not merely outside the plausible one: a
#: row at 1969 or 2150 is storable, and a sentinel inside the domain would hide
#: it from every unbounded query, which the views answered before they took a
#: range. ``2300-01-01`` is not usable as the ceiling because ``toDateTime64``
#: turns it into ``2299-12-31 00:00:00.000`` and would cut off that final day.
_OPEN_START = "1900-01-01 00:00:00.000"
_OPEN_END = "2299-12-31 23:59:59.999"


def _as_bound(value: exp.Expression) -> exp.Expression:
    """Normalise *value* into an instant the view reads the way the caller meant.

    Rendered as ``toTimeZone(toDateTime64(<value>, 3), timezone())``.

    Two reasons, both silent corruption without it. ClickHouse substitutes a view
    argument by rendering the value as text in the value's own timezone and
    parsing that text back in the server's, so a bound written as
    ``toDateTime('2026-09-01 09:00:00', 'Asia/Tokyo')`` reaches the view as
    09:00 UTC rather than the 00:00 UTC the caller meant. Verified on 25.2: the
    caller's own predicate matches 3 rows, the verbatim bound matches 1, this
    form matches 3. A positive offset drops rows from the start of the window and
    widens the end, and widening is the dedup hazard described above.

    It also gives ``greatest`` and ``least`` a common type. Raw bounds of mixed
    kinds raise ``Code: 386`` (no supertype for DateTime and String), and two raw
    strings compare as text, so ``greatest('2026-09-01T00:00:00', '2026-09-01
    12:00:00')`` returns the T form, which is the earlier instant, and the window
    silently widens.
    """
    return exp.Anonymous(
        this="toTimeZone",
        expressions=[
            exp.Anonymous(this="toDateTime64", expressions=[value.copy(), exp.Literal.number(3)]),
            exp.Anonymous(this="timezone", expressions=[]),
        ],
    )


def _next_millisecond(value: exp.Expression) -> exp.Expression:
    """The instant one millisecond after *value*.

    The view's own bounds are ``>= start_time`` and ``<= end_time - 1 ms``, so a
    caller's exclusive lower bound and inclusive upper bound both map onto them by
    shifting one millisecond. Written as an expression rather than a computed
    value because the bound may be relative, such as ``now() - INTERVAL 1 HOUR``,
    and has no value until the server evaluates it.

    Exact at any precision, because ``_as_bound`` truncates to milliseconds after
    the shift. For a caller bound of ``12:00:00.0005``, ``> X`` admits a
    ``DateTime64(3)`` column from ``12:00:00.001``, and the shift gives
    ``toDateTime64(12:00:00.0015, 3)``, which truncates to exactly that. On the
    upper side the view subtracts the millisecond again, so ``<= X`` reaches the
    view as ``<= 12:00:00.000``, which is what ``<= 12:00:00.0005`` admits.
    Verified against ClickHouse 25.2.
    """
    return exp.Add(
        this=value.copy(),
        expression=exp.Anonymous(this="toIntervalMillisecond", expressions=[exp.Literal.number(1)]),
    )


def _open(value: str) -> exp.Expression:
    """The sentinel for a side the caller did not usefully constrain."""
    return _as_bound(exp.Literal.string(value))


def _is_constant_bound(node: exp.Expression) -> bool:
    """True if *node* can legally be a view argument.

    A parameterised view takes constants. A bound reaching for a column or a
    subquery is refused here and leaves that side open, covering two failures
    that look different and share a cause:

    * ``WHERE s.span_start_time >= t.trace_start_time`` rendered a view argument
      naming another table's column, which fails with ``Code: 456`` because the
      substitution has no value, or ``Code: 47`` for an unknown identifier.
    * ``WHERE span_start_time >= (SELECT max(span_start_time) … FROM spans)``
      carried a whole subquery into the view call. That copy is spliced in during
      the transform and is never itself visited, so the ``spans`` inside it stays
      un-rewritten and Layer 3 correctly refuses the result.

    A scalar ``WITH`` alias is a column node too, so it loses pruning here. That
    is the conservative side of the trade.
    """
    return not any(isinstance(n, (exp.Column, exp.Select, exp.Subquery)) for n in node.walk())


def _is_time_column(node: exp.Expression, column: str, aliases: set[str], qualified: bool) -> bool:
    """True if *node* is the bounding column for the table being rewritten.

    *qualified* is set when the scope selects from more than one public table, in
    which case a bare column reference is ambiguous and is refused rather than
    guessed at. Guessing wrong here would bound one view by the other's predicate.
    """
    if not isinstance(node, exp.Column) or node.name.lower() != column:
        return False
    table = node.table.lower()
    if table:
        return table in aliases
    return not qualified


def _narrowest(bounds: list[exp.Expression], func: str) -> exp.Expression | None:
    """Combine several bounds on the same side into the one the caller implies.

    Two predicates on the same side intersect, so the effective bound is the
    greatest lower bound or the least upper bound. These cannot be compared here,
    because a bound may be an expression such as ``now() - INTERVAL 1 HOUR`` that
    only has a value at execution time, so the comparison is handed to the server.
    """
    if not bounds:
        return None
    if len(bounds) == 1:
        return bounds[0]
    return exp.Anonymous(this=func, expressions=[b.copy() for b in bounds])


def _extract_time_bounds(
    where: exp.Expression | None, column: str, aliases: set[str], qualified: bool
) -> tuple[exp.Expression | None, exp.Expression | None]:
    """Read the caller's time window out of one scope's WHERE clause.

    Only top-level ``AND`` conjuncts are read. A predicate under ``OR``, or one
    wrapping the column in a function, tells us nothing we can hand to the view
    without widening the window, and widening is not safe: a row admitted on a
    widened boundary enters the view's dedup, can win it as the newest version,
    and is then dropped by the caller's own filter, hiding an older version that
    was genuinely inside the window. Such predicates yield no bound, which leaves
    that side open and reproduces today's behaviour exactly.

    All four comparisons map onto the view's parameters. ``>=`` and ``<`` match
    them directly; ``>`` and ``<=`` are shifted by one millisecond, which is exact
    at any precision and needs no literal parsing. See ``_next_millisecond``.

    Reading them as no bound instead is not the neutral choice it looks like, and
    that is the whole reason they are mapped. A side left open while the other is
    bounded gives the view a window wider than the caller's, which is the hazard
    above: measured on ClickHouse 25.2, one window spelled ``>= A AND < B``
    returned a span whose older version sat inside it, and the identical window
    spelled ``> A - 1ms AND <= B - 1ms`` did not.

    The bound expression is passed through verbatim rather than bound as a
    parameter. A parameter carries a value, and the most common window in this
    product is relative (``now() - INTERVAL 1 HOUR``), which has no value until
    the server evaluates it. The expression has already passed Layer 1.
    """
    if where is None:
        return None, None

    starts: list[exp.Expression] = []
    ends: list[exp.Expression] = []

    def keep(side: list[exp.Expression], value: exp.Expression, *, exclusive: bool = False) -> None:
        if _is_constant_bound(value):
            side.append(_as_bound(_next_millisecond(value) if exclusive else value))

    def visit(node: exp.Expression) -> None:
        if isinstance(node, exp.And):
            visit(node.this)
            visit(node.expression)
            return
        if isinstance(node, exp.Paren):
            visit(node.this)
            return
        # col >= X, or the mirrored X <= col
        if isinstance(node, exp.GTE) and _is_time_column(node.this, column, aliases, qualified):
            keep(starts, node.expression)
        elif isinstance(node, exp.LTE) and _is_time_column(
            node.expression, column, aliases, qualified
        ):
            keep(starts, node.this)
        # col < X, or the mirrored X > col
        elif isinstance(node, exp.LT) and _is_time_column(node.this, column, aliases, qualified):
            keep(ends, node.expression)
        elif isinstance(node, exp.GT) and _is_time_column(
            node.expression, column, aliases, qualified
        ):
            keep(ends, node.this)
        # col > X, or the mirrored X < col. The view's lower bound is inclusive,
        # so an exclusive one becomes the next millisecond.
        elif isinstance(node, exp.GT) and _is_time_column(node.this, column, aliases, qualified):
            keep(starts, node.expression, exclusive=True)
        elif isinstance(node, exp.LT) and _is_time_column(
            node.expression, column, aliases, qualified
        ):
            keep(starts, node.this, exclusive=True)
        # col <= X, or the mirrored X >= col. The view's upper bound is exclusive
        # and subtracts the millisecond back off, so this lands on exactly X.
        elif isinstance(node, exp.LTE) and _is_time_column(node.this, column, aliases, qualified):
            keep(ends, node.expression, exclusive=True)
        elif isinstance(node, exp.GTE) and _is_time_column(
            node.expression, column, aliases, qualified
        ):
            keep(ends, node.this, exclusive=True)

    visit(where)
    return _narrowest(starts, "greatest"), _narrowest(ends, "least")


def _bounds_by_table(tree: exp.Expression) -> dict[int, tuple[exp.Expression, exp.Expression]]:
    """Map each public table node to the window of the scope that owns it.

    Extraction is per scope, never a query-wide walk. A global walk lets a
    subquery's predicate bound the outer view call: in
    ``WHERE t >= '2024-01-01' AND id IN (SELECT id FROM traces WHERE t >= '1999-01-01')``
    the outer call would be bounded at 1999, which is still tenant-scoped but
    defeats the pruning the bounds exist to provide.
    """
    bounds: dict[int, tuple[exp.Expression, exp.Expression]] = {}
    root = build_scope(tree)
    if root is None:
        return bounds

    for scope in root.traverse():
        select = scope.expression
        where_arg = select.args.get("where") if isinstance(select, exp.Expression) else None
        where = where_arg.this if isinstance(where_arg, exp.Where) else None

        public = [
            (name, source)
            for name, source in scope.sources.items()
            if isinstance(source, exp.Table)
            and isinstance(source.this, exp.Identifier)
            and source.name.lower() in TABLE_VIEW_MAP
        ]
        qualified = len(public) > 1

        for name, source in public:
            column = _TIME_COLUMN[source.name.lower()]
            aliases = {name.lower(), source.name.lower()}
            if source.alias:
                aliases.add(source.alias.lower())
            start, end = _extract_time_bounds(where, column, aliases, qualified)
            bounds[id(source)] = (
                start.copy() if start is not None else _open(_OPEN_START),
                end.copy() if end is not None else _open(_OPEN_END),
            )

    return bounds


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
    view_name: str,
    alias: exp.TableAlias,
    param_value: exp.Expression,
    start: exp.Expression,
    end: exp.Expression,
) -> exp.Table:
    """Build ``view_name(project_id = …, start_time = …, end_time = …) AS alias``.

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
                ),
                exp.EQ(
                    this=exp.Column(this=exp.Identifier(this="start_time", quoted=False)),
                    expression=start.copy(),
                ),
                exp.EQ(
                    this=exp.Column(this=exp.Identifier(this="end_time", quoted=False)),
                    expression=end.copy(),
                ),
            ],
        ),
        alias=alias,
    )


def _rewrite_table(
    node: exp.Table,
    cte_aliases: set[str],
    param_value: exp.Expression,
    bounds: dict[int, tuple[exp.Expression, exp.Expression]] | None = None,
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
    start, end = (bounds or {}).get(id(node), (_open(_OPEN_START), _open(_OPEN_END)))
    return _build_view_table(view_name, alias_node, param_value, start, end)


# ---------------------------------------------------------------------------
# Layer-3 post-rewrite verification
# ---------------------------------------------------------------------------


def _call_name(node: exp.Expression) -> str | None:
    """The lowercased name of a call the rewriter built, or None for anything else."""
    if isinstance(node, exp.Anonymous) and isinstance(node.this, str):
        return node.this.lower()
    return None


def _is_reserved_placeholder(node: exp.Expression) -> bool:
    """True for a bound parameter in the namespace reserved for tenant scoping.

    The same rule as the validator's, applied again because Layer 3 does not
    assume Layer 1 saw this tree.
    """
    if not isinstance(node, exp.Placeholder):
        return False
    var = node.this
    name = (var.name if isinstance(var, exp.Expression) else str(var or "")).lower()
    return name == "project_id" or name.startswith("scope_")


def _is_normalised_bound(node: exp.Expression) -> bool:
    """True if *node* is ``toTimeZone(toDateTime64(<value>, 3), timezone())``.

    The value inside is checked independently of ``_is_constant_bound``, so a
    defect in extraction cannot also blind verification: it must reference no
    column, subquery or table, and no reserved parameter. A caller's own
    ``{name:Type}`` parameter is allowed, since it is a value.
    """
    if _call_name(node) != "totimezone" or len(node.expressions) != 2:
        return False
    inner, zone = node.expressions
    if _call_name(zone) != "timezone" or zone.expressions:
        return False
    if _call_name(inner) != "todatetime64" or len(inner.expressions) != 2:
        return False
    value, precision = inner.expressions
    if not (isinstance(precision, exp.Literal) and precision.is_number and precision.this == "3"):
        return False
    return not any(
        isinstance(n, (exp.Column, exp.Select, exp.Subquery, exp.Table))
        or _is_reserved_placeholder(n)
        for n in value.walk()
    )


def _is_verified_bound(node: exp.Expression, combiner: str) -> bool:
    """True if *node* is one normalised bound, or several joined by *combiner*.

    The combiner is side-specific: several lower bounds intersect with
    ``greatest`` and several upper bounds with ``least``. The opposite function
    would widen the window, which the rewriter never does on purpose.
    """
    if _is_normalised_bound(node):
        return True
    return (
        _call_name(node) == combiner
        and len(node.expressions) >= 2
        and all(_is_normalised_bound(bound) for bound in node.expressions)
    )


def _verify_view_call(call: exp.Anonymous, param_value: exp.Expression) -> exp.Expression:
    """Check one injected view call's arguments, returning its tenant argument.

    Raises ``SqlValidationError`` unless the call carries exactly ``project_id``,
    ``start_time`` and ``end_time``, the tenant argument is the scope value this
    render bound, and both time bounds are in the normalised shape.
    """
    arguments: dict[str, exp.Expression] = {}
    for argument in call.expressions:
        name = (
            argument.this.name.lower()
            if isinstance(argument, exp.EQ)
            and isinstance(argument.this, exp.Column)
            and not argument.this.table
            else None
        )
        if name not in _VIEW_ARGUMENTS or name in arguments:
            raise SqlValidationError(
                "Post-rewrite verification failed: a view call has unexpected arguments"
            )
        arguments[name] = argument.expression
    if arguments.keys() != _VIEW_ARGUMENTS:
        raise SqlValidationError(
            "Post-rewrite verification failed: a view call is missing an argument"
        )
    if arguments["project_id"] != param_value:
        raise SqlValidationError(
            "Post-rewrite verification failed: a view call is not scoped to the bound project"
        )
    if not (
        _is_verified_bound(arguments["start_time"], "greatest")
        and _is_verified_bound(arguments["end_time"], "least")
    ):
        raise SqlValidationError(
            "Post-rewrite verification failed: a view call carries an unverified time bound"
        )
    return arguments["project_id"]


def _verify_rewritten_ast(
    tree: exp.Expression, cte_aliases: set[str], param_value: exp.Expression
) -> None:
    """Walk the rewritten AST and raise ``SqlValidationError`` if any security
    invariant is violated (fail-closed policy).

    Verification is purely AST-based — no substring matching.

    Invariants:
    1. No whitelisted physical table survived un-rewritten (``exp.Table`` with
       ``Identifier`` ``this`` whose name is in ``TABLE_VIEW_MAP`` and is not a
       CTE alias).
    2. Every injected table node names a known curated view (the ``Anonymous``
       ``this.this`` value must be in ``_VIEW_NAMES``).
    3. No blocked function was introduced: re-scan every node with the
       validator's public ``is_blocked_function`` helper.  The injected
       ``*_public_v1`` view-call ``Anonymous`` nodes are not blocked (their
       names are not in the blocklist), so they need no special exemption.
    4. Every injected view call carries exactly its three arguments, its tenant
       argument is *param_value*, and its time bounds are normalised constants.
    5. A reserved parameter appears nowhere except as a view call's tenant
       argument, so nothing else in the query can read or displace the scope.
    """
    # --- Invariant 4: view call arguments ------------------------------------
    # Collected in a pass of its own, so invariant 5 below knows every tenant
    # argument before it meets a placeholder, whatever order the walk takes.
    tenant_arguments: set[int] = set()
    for node in tree.walk():
        if (
            isinstance(node, exp.Table)
            and isinstance(node.this, exp.Anonymous)
            and _call_name(node.this) in _VIEW_NAMES
        ):
            tenant_arguments.add(id(_verify_view_call(node.this, param_value)))

    for node in tree.walk():
        # --- Invariant 5: reserved parameters only as tenant arguments ---------
        if _is_reserved_placeholder(node) and id(node) not in tenant_arguments:
            raise SqlValidationError(
                "Post-rewrite verification failed: a reserved parameter is used outside the scope"
            )

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
        # The injected *_public_v1 view-call Anonymous nodes are not blocked
        # functions (their names are not in the blocklist), so
        # is_blocked_function returns False for them — no special exemption is
        # needed.
        if is_blocked_function(node):
            raise SqlValidationError("Post-rewrite verification failed: blocked function detected")


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
    #
    # This is a flat, query-wide set, deliberately narrower in one respect than
    # the validator's scope-aware resolution: a public table name is removed from
    # it outright. Without that subtraction, a CTE named `spans` anywhere in the
    # query would exempt every `FROM spans` from rewriting -- and Layer 3 would
    # forgive the survivor, because it consults this same set. That query cannot
    # reach here today: validator check 6 rejects a CTE shadowing a public table.
    # But that is an invariant in another module with nothing tying the two
    # together, and the rewriter is the layer holding the tenant boundary. It
    # should not depend on being handed only well-formed input.
    cte_aliases: set[str] = {n.alias.lower() for n in tree.walk() if isinstance(n, exp.CTE)}
    cte_aliases -= set(TABLE_VIEW_MAP)

    # Step 4 — build the parameter-value expression.
    if USE_BOUND_PARAM:
        param_value: exp.Expression = _make_placeholder()
        bind_map: dict[str, str] = {"scope_project_id": project_id}
    else:
        if not PROJECT_ID_RE.fullmatch(project_id):
            raise SqlValidationError("project_id contains characters not permitted in literal mode")
        param_value = exp.Literal.string(project_id)
        bind_map = {}

    # Step 4b — read each table reference's window out of its own scope.
    # Computed before the transform, and keyed on node identity, which is why the
    # transform below runs with copy=False: the tree was already copied at step 2,
    # and a second copy would hand the callback nodes these keys do not match.
    bounds = _bounds_by_table(tree)

    # Step 5 — Layer-2 rewrite.
    # The lambda looks up ``_rewrite_table`` in module globals on every call,
    # so ``monkeypatch.setattr(rewriter, '_rewrite_table', noop)`` takes effect.
    rewritten = tree.transform(
        lambda node: (
            _rewrite_table(node, cte_aliases, param_value, bounds)
            if isinstance(node, exp.Table)
            else node
        ),
        copy=False,
    )

    # Step 6 — Layer-3 post-rewrite verification (AST-based, fail closed).
    _verify_rewritten_ast(rewritten, cte_aliases, param_value)

    # Step 7 — render.
    return rewritten.sql(dialect="clickhouse"), bind_map
