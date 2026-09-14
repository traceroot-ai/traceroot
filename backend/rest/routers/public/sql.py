"""Public SQL endpoints: run a query, or ask what can be queried.

``POST /api/v1/public/sql`` runs one read-only query against the caller's own
trace data. ``GET /api/v1/public/sql/schema`` returns the curated analytical
schema, which is the whole surface a caller may write SQL against.

The project is resolved from the credential and never read from the request. A
body cannot name a project, because the request model forbids unknown keys, and
a parameter cannot be called ``project_id`` or ``scope_*``, because both the
validator and the execution service refuse those names. Those are three
independent refusals of the same thing, which is deliberate: the tenant boundary
should not rest on any single one of them holding.
"""

import logging
from collections import Counter
from functools import partial
from typing import Any

import anyio
from fastapi import APIRouter, HTTPException, Request, Response, status

from rest.rate_limit import (
    BUCKET_SQL,
    is_request_rate_limit_exempt,
    key_sql,
    limiter,
    resolve_limit,
)
from rest.routers.public.deps import DualStampedAuth
from rest.schemas.eval import ErrorResponse
from rest.schemas.public import (
    SqlColumn,
    SqlRequest,
    SqlResponse,
    SqlSchemaColumn,
    SqlSchemaResponse,
    SqlSchemaTable,
)
from rest.services.sql.errors import SqlExecutionError, SqlValidationError
from rest.services.sql.schema import PUBLIC_TABLES
from rest.services.sql.service import SqlQueryService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/public/sql", tags=["SQL (Public)"])

#: Returned when something fails in a way the caller had no part in. Deliberately
#: identical for every such case: an error surface that varies with the internal
#: failure is an oracle, and these responses are the one place a rewritten query
#: could otherwise become visible.
_GENERIC_FAILURE = "Query execution failed."

#: Returned when there is no free slot for another query right now.
_BUSY = "Too many queries are running. Retry shortly."

#: How many queries one process runs at once, and how many of those one project
#: may hold. Both are per process, so the fleet-wide figure scales with workers.
_MAX_CONCURRENT_QUERIES = 16
_MAX_CONCURRENT_QUERIES_PER_PROJECT = 4


class _QueryGate:
    """Admits a query only while this process and its project both have room.

    Queries run on their own worker threads rather than the pool every other
    synchronous handler and dependency shares. A query can hold its thread for
    the full execution cap, so a burst the rate limit allows would otherwise
    starve requests that have nothing to do with SQL. Excess is refused rather
    than queued, and the per-project share stops one tenant holding every slot.

    Claiming and releasing both happen on the event loop with no await between
    the check and the update, so the counts cannot race.
    """

    def __init__(self, total: int, per_project: int) -> None:
        self.total = total
        self.per_project = per_project
        self.in_flight: Counter[str] = Counter()
        # Sized to the gate, so it never makes a query wait. Its job is to keep
        # these threads out of the shared pool's accounting.
        self.limiter = anyio.CapacityLimiter(total)

    def try_claim(self, project_id: str) -> bool:
        if self.in_flight.total() >= self.total:
            return False
        if self.in_flight[project_id] >= self.per_project:
            return False
        self.in_flight[project_id] += 1
        return True

    def release(self, project_id: str) -> None:
        self.in_flight[project_id] -= 1
        if self.in_flight[project_id] <= 0:
            del self.in_flight[project_id]


_gate = _QueryGate(_MAX_CONCURRENT_QUERIES, _MAX_CONCURRENT_QUERIES_PER_PROJECT)

#: Declared so the published contract matches what the route actually returns.
#: The CLI generates its client from this spec, so an undocumented 400 or 500 is
#: an error shape a generated client has no type for.
_SQL_ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {
    400: {
        "model": ErrorResponse,
        "description": "The query breaks the read-only contract, or asked for more than the "
        "server allows",
    },
    401: {"model": ErrorResponse, "description": "Authentication failed"},
    429: {
        "model": ErrorResponse,
        "description": "Rate limit exceeded, or too many queries are already running",
    },
    500: {"model": ErrorResponse, "description": "Query execution failed"},
}


@router.post("", response_model=SqlResponse, operation_id="run_sql", responses=_SQL_ERROR_RESPONSES)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_SQL, key_func=key_sql, exempt_when=is_request_rate_limit_exempt
)
async def run_sql(
    request: Request,
    response: Response,
    auth: DualStampedAuth,
    body: SqlRequest,
) -> SqlResponse:
    """Run one read-only SQL query scoped to the caller's project.

    Args:
        auth (DualStampedAuth): Resolved credential context. Its ``project_id``
            is the only project this query can ever see.
        body (SqlRequest): The query, optional parameter values, and an optional
            row cap that the service clamps down to the server ceiling.

    Returns:
        SqlResponse: Columns, rows, and whether more rows matched than were
            returned.

    Raises:
        HTTPException: 400 when the query breaks the read-only contract or asks
            for more than the server allows, 429 when no query slot is free,
            500 when execution fails for a reason the caller cannot act on.
    """
    if not _gate.try_claim(auth.project_id):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=_BUSY,
            headers={"Retry-After": "1"},
        )
    try:
        service = SqlQueryService()
        # Offloaded to a worker thread. The ClickHouse driver is synchronous, and a
        # blocking call made directly inside an async handler runs on the event loop
        # itself: one query held for the full execution cap would stall every other
        # request this worker is serving, including requests that have nothing to do
        # with SQL. The thread comes from the gate's own lane rather than the pool
        # shared with other handlers, for the reason given on _QueryGate.
        result = await anyio.to_thread.run_sync(
            partial(
                service.run,
                body.query,
                auth.project_id,
                parameters=body.parameters,
                max_rows=body.max_rows,
            ),
            limiter=_gate.limiter,
        )
    except SqlValidationError as exc:
        # Validation messages are written to be safe to return: they never echo
        # the SQL, the project, or an internal view name.
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except SqlExecutionError as exc:
        if exc.is_client_error:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=_GENERIC_FAILURE
        ) from exc
    except Exception as exc:
        # Nothing else should reach here. If it does, the caller learns nothing
        # from it, and the detail goes to the log instead.
        logger.exception("unexpected failure running public sql")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=_GENERIC_FAILURE
        ) from exc
    finally:
        _gate.release(auth.project_id)

    return SqlResponse(
        columns=[SqlColumn(name=c.name, type=c.type) for c in result.columns],
        rows=result.rows,
        row_count=result.row_count,
        truncated=result.truncated,
        elapsed_ms=result.elapsed_ms,
        statistics=result.statistics,
    )


@router.get(
    "/schema",
    response_model=SqlSchemaResponse,
    operation_id="get_sql_schema",
    responses={
        401: {"model": ErrorResponse, "description": "Authentication failed"},
        429: {"model": ErrorResponse, "description": "Rate limit exceeded"},
    },
)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_SQL, key_func=key_sql, exempt_when=is_request_rate_limit_exempt
)
async def get_sql_schema(
    request: Request,
    response: Response,
    auth: DualStampedAuth,
) -> SqlSchemaResponse:
    """Return the curated tables and columns available to public SQL.

    Read from the same contract the validator and the rewriter derive from, so
    what this advertises and what a query may reference cannot drift apart.
    """
    return SqlSchemaResponse(
        tables=[
            SqlSchemaTable(
                name=table.name,
                columns=[SqlSchemaColumn(name=c.name, type=c.type) for c in table.columns],
            )
            for table in PUBLIC_TABLES.values()
        ]
    )
