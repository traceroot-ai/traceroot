"""Evaluation read endpoints: the run summary and the dataset reads (internal, not public).

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
    read_run_summary,
)
from rest.routers.internal import verify_internal_secret
from rest.schemas.eval import (
    GetDatasetVersionResponse,
    ListDatasetsResponse,
    ListDatasetVersionsResponse,
    PublicDataset,
    ReadRunResponse,
)

router = APIRouter(
    prefix="/internal/projects/{project_id}",
    tags=["internal"],
    dependencies=[Depends(verify_internal_secret)],
)


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
