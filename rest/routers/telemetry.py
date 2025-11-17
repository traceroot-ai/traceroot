"""Telemetry router - HTTP interface for trace and log endpoints.

This router handles HTTP concerns only (validation, error codes, serialization).
All business logic is delegated to TelemetryLogic driver.
"""

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from slowapi import Limiter

from rest.config import GetLogByTraceIdRequest, ListTraceRawRequest
from rest.config.rate_limit import get_rate_limit_config
from rest.driver.telemetry_logic import TelemetryLogic

try:
    from rest.utils.ee.auth import get_user_credentials
except ImportError:
    from rest.utils.auth import get_user_credentials


class TelemetryRouter:
    """HTTP router for telemetry (trace and log) endpoints."""

    def __init__(
        self,
        local_mode: bool,
        limiter: Limiter,
    ):
        """Initialize telemetry router.

        Args:
            local_mode: Whether running in local mode
            limiter: Rate limiter instance
        """
        self.router = APIRouter()
        self.local_mode = local_mode
        self.limiter = limiter
        self.rate_limit_config = get_rate_limit_config()
        self.logger = logging.getLogger(__name__)

        # Inject driver (business logic layer)
        self.driver = TelemetryLogic(local_mode)

        # Set up routes
        self._setup_routes()

    def _setup_routes(self):
        """Set up API routes with rate limiting."""
        # Apply rate limiting to routes using configuration
        self.router.get("/list-traces")(
            self.limiter.limit(self.rate_limit_config.list_traces_limit
                               )(self.list_traces)
        )
        self.router.get("/get-logs-by-trace-id")(
            self.limiter.limit(self.rate_limit_config.get_logs_limit
                               )(self.get_logs_by_trace_id)
        )

    async def list_traces(
        self,
        request: Request,
        raw_req: ListTraceRawRequest = Depends(),
    ) -> dict[str,
              Any]:
        """HTTP handler for listing traces.

        This endpoint supports:
        - Direct trace ID lookup
        - Log-based search filtering
        - Normal trace filtering with pagination

        Args:
            request: FastAPI request object
            raw_req: Raw request data from query parameters

        Returns:
            Dictionary containing list of trace data

        Raises:
            HTTPException: If request validation fails or service error occurs
        """
        try:
            # Get user credentials
            _, _, user_sub = get_user_credentials(request)

            # Parse raw request to validated request
            req_data = raw_req.to_list_trace_request(request)

            # Delegate business logic to driver
            result = await self.driver.list_traces(
                request=request,
                req_data=req_data,
                user_sub=user_sub,
            )

            return result

        except ValueError as e:
            # Business validation error - return 400
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            # Unexpected error - log and return 500
            self.logger.error(f"Error listing traces: {e}")
            raise HTTPException(
                status_code=500,
                detail=f"Failed to list traces: {str(e)}"
            )

    async def get_logs_by_trace_id(
        self,
        request: Request,
        req_data: GetLogByTraceIdRequest = Depends(),
    ) -> dict[str,
              Any]:
        """HTTP handler for getting logs by trace ID.

        Args:
            request: FastAPI request object
            req_data: Request object containing trace ID and optional time range

        Returns:
            Dictionary containing trace logs

        Raises:
            HTTPException: If request validation fails or service error occurs
        """
        try:
            # Get user credentials
            _, _, user_sub = get_user_credentials(request)

            # Delegate business logic to driver
            result = await self.driver.get_logs_by_trace_id(
                request=request,
                trace_id=req_data.trace_id,
                start_time=req_data.start_time,
                end_time=req_data.end_time,
                user_sub=user_sub,
            )

            return result

        except ValueError as e:
            # Business validation error - return 400
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            # Unexpected error - log and return 500
            self.logger.error(f"Error getting logs for trace {req_data.trace_id}: {e}")
            raise HTTPException(status_code=500, detail=f"Failed to get logs: {str(e)}")
