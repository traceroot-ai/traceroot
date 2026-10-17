"""Alert evaluation for the worker's scheduler tick."""

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException

from rest.routers.internal.auth import verify_internal_secret
from rest.schemas.alerts import AlertEvaluationRequest, AlertEvaluationResponse
from rest.services.alert_evaluation import evaluate_alerts
from rest.services.widget_query import WidgetSpecError

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post(
    "/alert-evaluate",
    response_model=AlertEvaluationResponse,
    dependencies=[Depends(verify_internal_secret)],
)
async def evaluate_project_alerts(body: AlertEvaluationRequest):
    """Measure a batch of alert rules over one window.

    No retention clamp: the route resolves no principal, so there is no plan to
    clamp against, and the service's window bounds keep it inside any cutoff.
    """
    try:
        # Off the event loop: clickhouse-connect is synchronous.
        results = await asyncio.to_thread(
            evaluate_alerts,
            alerts=body.alerts,
            project_id=body.project_id,
            window_start=body.window_start,
            window_end=body.window_end,
        )
    except WidgetSpecError as e:
        raise HTTPException(
            status_code=422,
            detail={"step": e.step, "message": e.message},
        ) from e
    except Exception as e:
        logger.exception(f"Alert evaluation batch failed: {e}")
        raise HTTPException(status_code=500, detail="Alert evaluation failed") from e
    return AlertEvaluationResponse(results=results)
