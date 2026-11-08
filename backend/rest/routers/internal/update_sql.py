"""A bounded SQL tool for the background update agent.

The update's numbers are precomputed; the agent may still want to look closer
at one entity. This is the only query path it gets, and it is bounded by
construction: the query must bound time on every table, the bounds may span at
most one day, and the number of rows returned is capped. A raw scan of the
whole window is refused before it reaches ClickHouse.

It runs through the same project-scoped, read-only SQL service as the public
SQL endpoint, so the tenant scope and the curated schema are unchanged.
"""

import re
from datetime import datetime

import sqlglot
import sqlglot.expressions as exp
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from rest.routers.internal.auth import verify_internal_secret
from rest.services.sql.errors import SqlExecutionError, SqlValidationError
from rest.services.sql.rewriter import _OPEN_END, _OPEN_START, _VIEW_NAMES, scope_and_render
from rest.services.sql.service import SqlQueryService

router = APIRouter(prefix="/update-sql")

# The widest time range one query may cover, and the most rows it may return.
MAX_RANGE_SECONDS = 24 * 3600
# All the tables of one query together: a join of two day-long reads is allowed.
MAX_TOTAL_SECONDS = 2 * MAX_RANGE_SECONDS
MAX_ROWS = 200

_BOUNDS = re.compile(
    r"start_time = toTimeZone\(toDateTime64\('([^']+)'(?: \+ toIntervalMillisecond\(1\))?, 3\), timezone\(\)\), "
    r"end_time = toTimeZone\(toDateTime64\('([^']+)'(?: \+ toIntervalMillisecond\(1\))?, 3\), timezone\(\)\)"
)


class UpdateSqlRequest(BaseModel):
    project_id: str = Field(min_length=1, max_length=200)
    query: str = Field(min_length=1, max_length=4000)
    max_rows: int = Field(default=MAX_ROWS, ge=1)


class UpdateSqlResponse(BaseModel):
    columns: list[str]
    rows: list[list]
    truncated: bool
    note: str = f"At most {MAX_ROWS} rows and {MAX_RANGE_SECONDS // 3600} hours of time per query."


def check_bounded(rendered: str) -> None:
    """Refuse a rendered query unless every table read is bounded and the total range is small.

    Each table in the rewritten query is a call to a curated view carrying its own
    start and end. Every call is checked, not just the first match, and the ranges
    of all calls add up: a UNION of one-day reads, or a subquery over three months,
    is as much a scan as one wide read.
    """
    tree = sqlglot.parse_one(rendered, dialect="clickhouse")
    total = 0.0
    calls = 0
    for node in tree.find_all(exp.Anonymous):
        if str(node.this).lower() not in _VIEW_NAMES:
            continue
        calls += 1
        text = node.sql(dialect="clickhouse")
        if _OPEN_START in text or _OPEN_END in text:
            raise HTTPException(
                status_code=422,
                detail="Every table needs a time range: filter span_start_time or "
                f"trace_start_time to at most {MAX_RANGE_SECONDS // 3600} hours per table.",
            )
        match = _BOUNDS.search(text)
        if match is None:
            raise HTTPException(
                status_code=422,
                detail="Every time range must be written as constant timestamps.",
            )
        try:
            start, end = (datetime.fromisoformat(value) for value in match.groups())
        except ValueError as exc:
            raise HTTPException(
                status_code=422, detail="A time range holds a timestamp that cannot be read."
            ) from exc
        try:
            seconds = (end - start).total_seconds()
        except TypeError as exc:  # one bound has a UTC offset and the other does not
            raise HTTPException(
                status_code=422,
                detail="Time ranges must not mix timestamps with and without an offset.",
            ) from exc
        # Each read must be a real, bounded range by itself. An inverted one would
        # otherwise cancel a wide read in the sum below.
        if seconds <= 0 or seconds > MAX_RANGE_SECONDS:
            raise HTTPException(
                status_code=422,
                detail="Each time range must be positive and at most "
                f"{MAX_RANGE_SECONDS // 3600} hours.",
            )
        total += seconds
    if calls == 0:
        raise HTTPException(status_code=422, detail="Query reads no table.")
    if total > MAX_TOTAL_SECONDS:
        raise HTTPException(
            status_code=422,
            detail=f"The time ranges of all the tables add up to more than {MAX_TOTAL_SECONDS // 3600} hours.",
        )


@router.post("", response_model=UpdateSqlResponse, dependencies=[Depends(verify_internal_secret)])
def run_update_sql(body: UpdateSqlRequest) -> UpdateSqlResponse:
    try:
        rendered, _ = scope_and_render(body.query, body.project_id)
    except SqlValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    check_bounded(rendered)
    try:
        result = SqlQueryService().run(
            body.query, body.project_id, max_rows=min(body.max_rows, MAX_ROWS)
        )
    except SqlExecutionError as exc:
        raise HTTPException(
            status_code=422 if exc.is_client_error else 500, detail=str(exc)
        ) from exc
    return UpdateSqlResponse(
        columns=[c.name for c in result.columns],
        rows=[[_plain(v) for v in row] for row in result.rows],
        truncated=result.truncated,
    )


def _plain(value):
    """JSON-safe cell: numbers, text and booleans as they are, anything else as text."""
    if isinstance(value, datetime):
        return value.isoformat()
    if value is None or isinstance(value, (int, float, str, bool)):
        return value
    return str(value)
