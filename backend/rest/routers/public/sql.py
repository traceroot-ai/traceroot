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

from fastapi import APIRouter, HTTPException, Request, Response, status

from rest.rate_limit import (
    BUCKET_SQL,
    is_request_rate_limit_exempt,
    key_sql,
    limiter,
    resolve_limit,
)
from rest.routers.public.deps import DualStampedAuth
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


@router.post("", response_model=SqlResponse, operation_id="run_sql")
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
            for more than the server allows, 500 when execution fails for a
            reason the caller cannot act on.
    """
    service = SqlQueryService()
    try:
        result = service.run(
            body.query,
            auth.project_id,
            parameters=body.parameters,
            max_rows=body.max_rows,
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

    return SqlResponse(
        columns=[SqlColumn(name=c.name, type=c.type) for c in result.columns],
        rows=result.rows,
        row_count=result.row_count,
        truncated=result.truncated,
        elapsed_ms=result.elapsed_ms,
        statistics=result.statistics,
    )


@router.get("/schema", response_model=SqlSchemaResponse, operation_id="get_sql_schema")
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
