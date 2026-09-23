"""Evaluation read endpoints: the listings, the run summary and the dataset reads
(internal, not public).

Thin internal mirrors of the public evaluation reads so the in-app agent's
registry-bound tools can dispatch here with service auth. Payload shapes are
shared with the public surface (rest.schemas.eval) by design — one registry
definition serves both. Params must stay a superset of the public twins
(enforced by tests/rest/test_public_internal_parity.py), and the handler
bodies live in rest.routers.evaluation_read_common so behavior cannot drift
between the surfaces.

Mounted under ``/internal`` (the prefix the ingress fixed-404s off the load
balancer) and gated on the internal secret alone, like the alert and dashboard
mirrors: the only intended caller is the in-cluster agent, and the
``/api/v1/projects`` surface would let anyone reach a tenant's runs with just a
caller-supplied ``x-user-id`` header. No rate limiting — secret-authed internal
traffic is exempt by definition.

No ``ProjectAccess`` either: its internal-secret branch grants an enterprise
plan (rest.routers.deps), which would widen the retention window. Retention is
resolved by the Next.js read from the project's own workspace, so this mirror
refuses exactly the runs the public route refuses.
"""

from fastapi import APIRouter, Depends, Query

from rest.routers.evaluation_read_common import (
    get_dataset_detail,
    get_dataset_version_page,
    list_dataset_versions_page,
    list_datasets_page,
    list_evaluation_runs_page,
    list_evaluations_page,
    read_run_summary,
)
from rest.routers.internal import verify_internal_secret
from rest.schemas.eval import (
    EvalRunStatus,
    GetDatasetVersionResponse,
    ListDatasetsResponse,
    ListDatasetVersionsResponse,
    ListEvaluationRunsResponse,
    ListEvaluationsResponse,
    PublicDataset,
    ReadRunResponse,
)

router = APIRouter(
    prefix="/internal/projects/{project_id}",
    tags=["internal"],
    dependencies=[Depends(verify_internal_secret)],
)


# The listing reads carry no retention gate on either surface, like the dataset reads
# below: they report identity and standing, not the results a retention window bounds.
# Registered before the run read so they win for their own exact paths.


@router.get("/evaluations", response_model=ListEvaluationsResponse)
async def list_evaluations(
    project_id: str,
    limit: int = Query(50, ge=1, le=200, description="Evaluations per page"),
    cursor: str | None = Query(
        None, min_length=1, max_length=64, description="Opaque cursor from a previous page"
    ),
    name: str | None = Query(
        None, min_length=1, max_length=200, description="Case-insensitive substring of the name"
    ),
) -> ListEvaluationsResponse:
    """List the project's evaluations, newest first, each with its run count and latest run."""
    return await list_evaluations_page(project_id, limit, cursor, name)


@router.get("/evaluation-runs", response_model=ListEvaluationRunsResponse)
async def list_evaluation_runs(
    project_id: str,
    limit: int = Query(50, ge=1, le=200, description="Runs per page"),
    cursor: str | None = Query(
        None, min_length=1, max_length=64, description="Opaque cursor from a previous page"
    ),
    evaluation_id: str | None = Query(
        None, min_length=1, max_length=64, description="Only this evaluation's runs"
    ),
    # Named `run_status` with a `status` alias exactly as the public twin is, so the
    # parity test compares the same parameter on both surfaces.
    run_status: EvalRunStatus | None = Query(
        None, alias="status", description="Only runs in this status"
    ),
) -> ListEvaluationRunsResponse:
    """List evaluation runs, newest first, optionally one evaluation's or one status's."""
    return await list_evaluation_runs_page(project_id, limit, cursor, evaluation_id, run_status)


@router.get("/evaluation-runs/{run_id}", response_model=ReadRunResponse)
async def read_run(project_id: str, run_id: str) -> ReadRunResponse:
    """Read one run's own summary."""
    return await read_run_summary(project_id, run_id)


# The dataset reads carry no retention gate on either surface: datasets are authored
# catalog data, not time-windowed telemetry.


@router.get("/datasets", response_model=ListDatasetsResponse)
async def list_datasets(
    project_id: str,
    limit: int = Query(50, ge=1, le=200, description="Datasets per page"),
    cursor: str | None = Query(
        None, min_length=1, max_length=64, description="Opaque cursor from a previous page"
    ),
    name: str | None = Query(
        None, min_length=1, max_length=200, description="Case-insensitive substring of the name"
    ),
) -> ListDatasetsResponse:
    """List the project's datasets, newest first."""
    return await list_datasets_page(project_id, limit, cursor, name)


@router.get("/datasets/{dataset_id}", response_model=PublicDataset)
async def get_dataset(project_id: str, dataset_id: str) -> PublicDataset:
    """Read one dataset and its current published version."""
    return await get_dataset_detail(project_id, dataset_id)


@router.get("/datasets/{dataset_id}/versions", response_model=ListDatasetVersionsResponse)
async def list_dataset_versions(
    project_id: str,
    dataset_id: str,
    limit: int = Query(50, ge=1, le=200, description="Versions per page"),
    cursor: str | None = Query(
        None, min_length=1, max_length=64, description="Opaque cursor from a previous page"
    ),
) -> ListDatasetVersionsResponse:
    """List a dataset's versions, newest first, with case counts."""
    return await list_dataset_versions_page(project_id, dataset_id, limit, cursor)


@router.get("/dataset-versions/{version_id}", response_model=GetDatasetVersionResponse)
async def get_dataset_version(
    project_id: str,
    version_id: str,
    limit: int | None = Query(
        None,
        ge=1,
        le=1000,
        description="Test cases per page. Omit it, with no cursor, for the whole version.",
    ),
    cursor: str | None = Query(
        None, min_length=1, max_length=64, description="Opaque cursor from a previous page"
    ),
) -> GetDatasetVersionResponse:
    """Read one dataset version and its test cases, whole or a page at a time."""
    return await get_dataset_version_page(project_id, version_id, limit, cursor)
