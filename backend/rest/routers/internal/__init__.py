"""Internal API endpoints for worker/service communication.

These endpoints are protected by X-Internal-Secret header and not exposed publicly.

Sub-routers are included in their historical order so path matching is unchanged.
"""

from fastapi import APIRouter

from rest.routers.internal.auth import verify_internal_secret
from rest.routers.internal.detectors import router as detectors_router
from rest.routers.internal.ingest import router as ingest_router
from rest.routers.internal.usage import router as usage_router

router = APIRouter(prefix="/internal", tags=["internal"])

router.include_router(usage_router)
router.include_router(detectors_router)
router.include_router(ingest_router)

__all__ = ["router", "verify_internal_secret"]
