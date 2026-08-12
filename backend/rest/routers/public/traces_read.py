"""Public, API-key-authenticated trace read endpoints (for the CLI).

`GET /api/v1/public/traces` (list) and `GET /api/v1/public/traces/{trace_id}`
(get). Reads are scoped to the project the API key belongs to — the client
never supplies a project id. Kept separate from the ingestion route so read and
write concerns stay decoupled; both reuse the shared API-key auth dependency.
"""

import asyncio
import logging
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query, Request, Response, status

from rest.projection import (
    FIELDS_PARAM_DESC,
    FULL,
    SKELETON,
    InvalidFieldsError,
    drop_span_tree_metadata,
    hydrate_span_io,
    resolve_span_fields,
)
from rest.rate_limit import (
    BUCKET_READ,
    is_request_rate_limit_exempt,
    key_export,
    key_read,
    limiter,
    resolve_limit,
)
from rest.retention import clamp_retention_window, enforce_retention_by_time
from rest.routers.public.deps import StampedAuth
from rest.routers.public.serialize import export_bundle, public_trace_detail
from rest.schemas.public import (
    PublicTraceDetailResponse,
    PublicTraceExportResponse,
    PublicTraceListResponse,
)
from rest.schemas.traces import FilterValuesResponse, MetadataKeysResponse
from rest.services.filters import columns as filter_columns
from rest.services.filters.translate import parse_filters_param
from rest.services.trace_discovery import get_trace_discovery_service
from rest.services.trace_reader import get_trace_reader_service
from rest.url_utils import build_trace_url
from shared.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/public/traces", tags=["Traces (Public)"])


@router.get("", response_model=PublicTraceListResponse, operation_id="list_traces")
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def list_traces(
    request: Request,
    response: Response,
    auth: StampedAuth,
    limit: int = Query(50, ge=1, le=200, description="Items per page"),
    start_after: datetime | None = Query(
        None,
        description="Only traces that started at or after this time (inclusive, ISO 8601)",
    ),
    end_before: datetime | None = Query(
        None,
        description="Only traces that started before this time (exclusive, ISO 8601)",
    ),
    name: str | None = Query(None, description="Filter by trace name (substring match)"),
    user_id: str | None = Query(None, description="Filter by the user id recorded on the trace"),
    search_query: str | None = Query(
        None, description="Search across trace_id, name, session_id, user_id"
    ),
    filters: str | None = Query(
        None,
        description=(
            "JSON array of typed filter predicates ({field, op, value}); the "
            "field catalog and per-field operators are defined in the schema"
        ),
    ),
):
    """List recent traces for the API key's project (newest first)."""
    # Parse + validate filters before the DB try-block so a bad predicate
    # surfaces as a 400 with an actionable message, not a 500.
    try:
        parsed_filters = parse_filters_param(filters)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from e
    start_after, end_before = clamp_retention_window(auth.billing_plan, start_after, end_before)
    try:
        service = get_trace_reader_service()
        result = service.list_traces(
            project_id=auth.project_id,
            limit=limit,
            start_after=start_after,
            end_before=end_before,
            name=name,
            user_id=user_id,
            search_query=search_query,
            filters=parsed_filters,
        )
    except Exception as e:
        logger.exception(f"Error listing traces: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list traces",
        ) from e

    for item in result["data"]:
        item["trace_url"] = build_trace_url(
            settings.traceroot_public_ui_url, auth.project_id, item["trace_id"]
        )
    return result


# Declared above the /{trace_id} route so the literal `filter-values` segment
# is matched here and never captured as a trace id.
@router.get(
    "/filter-values/{field}",
    response_model=FilterValuesResponse,
    operation_id="list_trace_filter_values",
)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def list_trace_filter_values(
    request: Request,
    response: Response,
    auth: StampedAuth,
    field: str,
    start_after: datetime | None = Query(
        None, description="Only consider spans starting at or after this timestamp"
    ),
    end_before: datetime | None = Query(
        None, description="Only consider spans starting before this timestamp"
    ),
):
    """Distinct values for an open-ended categorical filter field.

    The values-discovery companion to the typed ``filters`` parameter on the
    trace list: the filterable field catalog lives in the generated schema,
    while a field's current values are dynamic per project. Only fields the
    registry marks as distinct-query (model_name, environment) are listable;
    the field is resolved through the registry before it reaches SQL, so it can
    never be a raw client-supplied column name.

    Args:
        auth (StampedAuth): Resolved API-key context; scopes the read to its
            project and stamps the rate-limit identity.
        field (str): The categorical field to enumerate.
        start_after (datetime | None): Lower bound on span start time (active
            window).
        end_before (datetime | None): Upper bound on span start time (active
            window), symmetric with ``start_after`` so options match the list's
            window.

    Returns:
        FilterValuesResponse: Distinct values ordered by descending frequency.

    Raises:
        HTTPException: 400 if the field is unknown or not a distinct-query
            categorical, 500 on a reader failure.
    """
    start_after, end_before = clamp_retention_window(auth.billing_plan, start_after, end_before)
    column = filter_columns.get_column(field)
    if column is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown filter field: {field}",
        )
    if column.value_source != filter_columns.ValueSource.DISTINCT_QUERY:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Field '{field}' does not support distinct-value listing",
        )
    try:
        service = get_trace_reader_service()
        values = service.get_distinct_span_values(
            project_id=auth.project_id,
            column=column.name,
            start_after=start_after,
            end_before=end_before,
        )
    except Exception as e:
        logger.exception(f"Error listing filter values: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list filter values",
        ) from e
    return {"field": field, "values": values}


# Also declared above the /{trace_id} route, for the same segment-capture reason.
@router.get(
    "/metadata-keys",
    response_model=MetadataKeysResponse,
    operation_id="list_trace_metadata_keys",
)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def list_trace_metadata_keys(
    request: Request,
    response: Response,
    auth: StampedAuth,
    start_after: datetime | None = Query(
        None,
        description="Only consider traces and spans starting at or after this timestamp",
    ),
    end_before: datetime | None = Query(
        None, description="Only consider traces and spans starting before this timestamp"
    ),
):
    """Metadata keys seen on the window's traces and spans, by descending frequency.

    The key-discovery companion to the typed ``filters`` parameter's keyed
    ``metadata`` field: the key catalog is dynamic per project, so callers
    (agents, generated CLIs) list it here instead of guessing key names. Both
    scopes are covered — a key set on the trace and a key set on a span are
    disjoint key spaces, and a metadata filter matches either. The list only
    suggests: an unlisted key stays filterable by naming it.

    Args:
        auth (StampedAuth): Resolved API-key context; scopes the read to its
            project and stamps the rate-limit identity.
        start_after (datetime | None): Lower bound on trace and span start time
            (active window). An omitted bound is defaulted to a fixed lookback,
            never scanned all-time.
        end_before (datetime | None): Upper bound on trace and span start time
            (active window), symmetric with ``start_after``.

    Returns:
        MetadataKeysResponse: Keys with occurrence counts, by descending frequency.

    Raises:
        HTTPException: 500 on a reader failure.
    """
    start_after, end_before = clamp_retention_window(auth.billing_plan, start_after, end_before)
    try:
        service = get_trace_discovery_service()
        # Off the event loop, mirroring the internal twin: the key scan arrayJoins
        # over mapKeys on both tables' base rows — the heaviest discovery read.
        keys = await asyncio.to_thread(
            service.get_distinct_metadata_keys,
            project_id=auth.project_id,
            start_after=start_after,
            end_before=end_before,
        )
    except Exception as e:
        logger.exception(f"Error listing metadata keys: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list metadata keys",
        ) from e
    return {"keys": keys}


@router.get("/{trace_id}", response_model=PublicTraceDetailResponse, operation_id="get_trace")
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def get_trace(
    request: Request,
    response: Response,
    auth: StampedAuth,
    trace_id: str,
    fields: str | None = Query(None, description=FIELDS_PARAM_DESC),
):
    """Get a single trace for the key's project.

    Defaults to the lightweight `skeleton` projection (no per-span I/O); pass
    `fields=full` (or `fields=io,metadata`) for per-span input/output/metadata.

    Args:
        auth (StampedAuth): Resolved API-key context; scopes the read to its
            project and stamps the rate-limit identity.
        trace_id (str): Trace to fetch.
        fields (str | None): Comma-separated projection groups (e.g. ``io``,
            ``metadata``) or an alias (``skeleton``/``full``). ``None`` selects
            the default `skeleton` projection.

    Returns:
        PublicTraceDetailResponse: The trace with span skeletons, plus per-span
            I/O when the projection requests it.

    Raises:
        HTTPException: 400 if `fields` is invalid, 404 if the trace is missing
            or outside the key's project, 500 on a reader failure.
    """
    groups = _resolve_fields(fields, default=SKELETON)
    trace = _require_trace(auth.project_id, trace_id, groups, auth.billing_plan)
    return public_trace_detail(trace, auth.project_id)


@router.get(
    "/{trace_id}/export", response_model=PublicTraceExportResponse, operation_id="export_trace"
)
@limiter.limit(resolve_limit, key_func=key_export, exempt_when=is_request_rate_limit_exempt)
async def export_trace(
    request: Request,
    response: Response,
    auth: StampedAuth,
    trace_id: str,
    fields: str | None = Query(None, description=FIELDS_PARAM_DESC),
):
    """Export the V1 bundle (trace + spans + git_context + manifest) for the key's project.

    Defaults to the `full` projection — an export is explicit intent to take the
    complete trace, so per-span input/output/metadata are included unless the
    caller narrows `fields`. `bundle.trace` equals the `traces get` payload at the
    same projection.

    Rate limited on its own `export` bucket because it builds and serializes the
    full bundle.

    Args:
        auth (StampedAuth): Resolved API-key context; scopes the read to its
            project and stamps the rate-limit identity.
        trace_id (str): Trace to export.
        fields (str | None): Comma-separated projection groups or an alias
            (``skeleton``/``full``). ``None`` selects the default `full`
            projection.

    Returns:
        PublicTraceExportResponse: The V1 export bundle (manifest, trace, spans,
            git_context) at the requested projection.

    Raises:
        HTTPException: 400 if `fields` is invalid, 404 if the trace is missing
            or outside the key's project, 500 on a reader failure.
    """
    groups = _resolve_fields(fields, default=FULL)
    trace = _require_trace(auth.project_id, trace_id, groups, auth.billing_plan)
    return export_bundle(trace, auth.project_id)


def _resolve_fields(fields: str | None, *, default: frozenset[str]) -> frozenset[str]:
    """Resolve the `fields` projection, mapping a bad value to 400 Bad Request.

    Args:
        fields (str | None): Raw `fields` query value (comma-separated groups or
            an alias). ``None``/empty resolves to ``default``.
        default (frozenset[str]): Projection to use when `fields` is unset.

    Returns:
        frozenset[str]: The resolved set of projection groups.

    Raises:
        HTTPException: 400 Bad Request if `fields` names an unknown group.
    """
    try:
        return resolve_span_fields(fields, default=default)
    except InvalidFieldsError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from e


def _require_trace(
    project_id: str, trace_id: str, groups: frozenset[str], billing_plan: str
) -> dict:
    """Fetch a trace scoped to the project at the requested projection.

    Centralizing the read here keeps `get` and `export` consistent: a reader
    failure is a controlled 500 (matching `list_traces`), a missing/cross-project
    trace is a 404, and internal exception text is never leaked to clients. The
    bulk span-I/O query runs only when the projection requests `io`/`metadata`,
    so the default skeleton read keeps the #1040 lightweight behavior.

    Args:
        project_id (str): Project that owns the trace; scopes the read.
        trace_id (str): Trace to fetch.
        groups (frozenset[str]): Resolved projection groups; per-span I/O is
            hydrated only when ``io``/``metadata`` are present.

    Returns:
        dict: The trace detail dict, with per-span I/O merged in when requested.

    Raises:
        HTTPException: 404 if the trace is missing or outside the project, 500
            on a reader failure.
    """
    try:
        service = get_trace_reader_service()
        trace = service.get_trace(project_id=project_id, trace_id=trace_id)
        if trace:
            # The skeleton's span-path metadata subset exists for the dashboard's
            # live-tree repair; API clients build trees from parent_span_id and
            # their contract is `metadata: null` unless they ask for it. Clear it
            # first, then let the hydration below refill `metadata` with the real
            # blob for the projections that do request it.
            drop_span_tree_metadata(trace)
            hydrate_span_io(service, trace, project_id=project_id, trace_id=trace_id, groups=groups)
    except Exception as e:
        logger.exception(f"Error getting trace: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get trace",
        ) from e
    if not trace:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Trace not found",
        )
    enforce_retention_by_time(billing_plan, trace.get("trace_start_time"))
    return trace
