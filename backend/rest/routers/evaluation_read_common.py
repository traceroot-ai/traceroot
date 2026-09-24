"""Shared handler bodies for the evaluation read surfaces.

The public evaluation read routes (an API key, or a user login plus project_id)
and any internal project-scoped mirror expose the same reads over the same response schemas; only the auth
source differs. Each router resolves the project, then delegates here, so the
proxy and error-mapping semantics cannot drift between the two surfaces.

Evaluation runs and datasets live in Postgres/Prisma, so every read is
delegated to the Next.js internal ``project-evaluations`` route (secret-authed,
keyed by the resolved project id) through the shared internal read proxy,
which owns the passthrough (400/403/404) and fail-closed (503) rules. The
retention window is resolved inside that route from the project's own
workspace, so neither surface's credential decides how far back a read may
reach. Ids are never logged.
"""

import logging
from typing import Any, TypeVar

from pydantic import BaseModel, ValidationError
from pydantic_core import PydanticSerializationError

from rest.routers.internal_read_proxy import post_internal_read, service_error
from rest.schemas.eval import (
    GetDatasetVersionResponse,
    ListDatasetsResponse,
    ListDatasetVersionsResponse,
    PublicDataset,
)

logger = logging.getLogger(__name__)

_Model = TypeVar("_Model", bound=BaseModel)

_SERVICE = "Evaluation"
_INTERNAL_PATH = "/api/internal/project-evaluations"
# These reads can touch many rows: an unpaged version read returns every case. The gateway's forward allowed 30 s for
# the same work, so keep that bound rather than the catalog reads' 10 s.
_TIMEOUT_SECONDS = 30.0


async def _read(payload: dict[str, Any], model: type[_Model], what: str) -> _Model:
    """Post one read to the internal route and validate its body against the contract.

    Args:
        payload (dict[str, Any]): The camelCase read, including ``read`` and ``projectId``.
        model (type[_Model]): The public response model the body must satisfy.
        what (str): What was read, for the log line (never an id).

    Returns:
        _Model: The validated response.

    Raises:
        HTTPException: 400/403/404 passed through; 503 (fail closed) on any upstream
            ambiguity, including a body outside the contract or one JSON can't carry.
    """
    data = await post_internal_read(
        _INTERNAL_PATH, payload, service=_SERVICE, timeout=_TIMEOUT_SECONDS
    )
    try:
        validated = model.model_validate(data)
        # Serialized here too: a string JSON output can't carry (a lone UTF-16 surrogate in
        # stored case text) must fail closed now, not escape as a 500 once the response is
        # being written.
        validated.model_dump_json()
    except (ValidationError, PydanticSerializationError) as e:
        logger.error(f"Evaluation service returned {what} outside the contract")
        raise service_error(_SERVICE) from e
    return validated


async def list_datasets_page(
    project_id: str, limit: int, cursor: str | None, name: str | None
) -> ListDatasetsResponse:
    """List the project's datasets, newest first, via the internal route.

    Args:
        project_id (str): The project the caller's credential resolved to.
        limit (int): Datasets per page (sent explicitly so both sides agree).
        cursor (str | None): Opaque cursor from a previous page.
        name (str | None): Case-insensitive substring of the dataset name.

    Returns:
        ListDatasetsResponse: One page of datasets and the next cursor (null at the end).
    """
    payload: dict[str, Any] = {"read": "datasets", "projectId": project_id, "limit": limit}
    if cursor:
        payload["cursor"] = cursor
    if name:
        payload["name"] = name
    return await _read(payload, ListDatasetsResponse, "a dataset list")


async def get_dataset_detail(project_id: str, dataset_id: str) -> PublicDataset:
    """Read one dataset by the id the SDK addresses it by, via the internal route.

    Args:
        project_id (str): The project the caller's credential resolved to.
        dataset_id (str): The dataset's client id, or its row id for a UI dataset.

    Returns:
        PublicDataset: The dataset and its current published version (null until one is).

    Raises:
        HTTPException: 404 passed through when the dataset is not in the project.
    """
    payload = {"read": "dataset", "projectId": project_id, "datasetId": dataset_id}
    return await _read(payload, PublicDataset, "a dataset")


async def list_dataset_versions_page(
    project_id: str, dataset_id: str, limit: int, cursor: str | None
) -> ListDatasetVersionsResponse:
    """List a dataset's versions, newest first, via the internal route.

    Args:
        project_id (str): The project the caller's credential resolved to.
        dataset_id (str): The dataset's client id, or its row id.
        limit (int): Versions per page.
        cursor (str | None): Opaque cursor from a previous page.

    Returns:
        ListDatasetVersionsResponse: One page of versions with case counts.

    Raises:
        HTTPException: 404 passed through when the dataset is not in the project.
    """
    payload: dict[str, Any] = {
        "read": "dataset_versions",
        "projectId": project_id,
        "datasetId": dataset_id,
        "limit": limit,
    }
    if cursor:
        payload["cursor"] = cursor
    return await _read(payload, ListDatasetVersionsResponse, "a version list")


async def get_dataset_version_page(
    project_id: str, version_id: str, limit: int | None, cursor: str | None
) -> GetDatasetVersionResponse:
    """Read one immutable dataset version and its test cases, via the internal route.

    Args:
        project_id (str): The project the caller's credential resolved to.
        version_id (str): The dataset version to read.
        limit (int | None): Test cases per page. None, with no cursor, reads the whole
            version, which is what the released SDKs' single-request pull relies on.
        cursor (str | None): Opaque cursor from a previous page.

    Returns:
        GetDatasetVersionResponse: The version and its cases, whole or one page.

    Raises:
        HTTPException: 404 passed through when the version is not in the project.
    """
    payload: dict[str, Any] = {
        "read": "dataset_version",
        "projectId": project_id,
        "versionId": version_id,
    }
    if limit is not None:
        payload["limit"] = limit
    if cursor:
        payload["cursor"] = cursor
    return await _read(payload, GetDatasetVersionResponse, "a dataset version")
