"""Evaluation read endpoints (internal service-to-service, not public).

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

from fastapi import APIRouter, Depends

from rest.routers.evaluation_read_common import read_run_summary
from rest.routers.internal import verify_internal_secret
from rest.schemas.eval import ReadRunResponse

router = APIRouter(
    prefix="/internal/projects/{project_id}",
    tags=["internal"],
    dependencies=[Depends(verify_internal_secret)],
)


@router.get("/evaluation-runs/{run_id}", response_model=ReadRunResponse)
async def read_run(project_id: str, run_id: str) -> ReadRunResponse:
    """Read one run's own summary."""
    return await read_run_summary(project_id, run_id)
