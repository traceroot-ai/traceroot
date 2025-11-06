import os
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from slowapi import Limiter

try:
    from rest.dao.ee.mongodb_dao import TraceRootMongoDBClient
except ImportError:
    from rest.dao.mongodb_dao import TraceRootMongoDBClient

from rest.dao.sqlite_dao import TraceRootSQLiteClient


class VerifyRouter:
    r"""Verify router for validating tokens and retrieving credentials.

    In self-hosted mode, this validates tokens stored in SQLite and returns
    local Jaeger configuration. In cloud mode, this would use MongoDB and
    return AWS credentials.
    """

    def __init__(self, limiter: Limiter):
        self.router = APIRouter()
        self.local_mode = os.getenv("REST_LOCAL_MODE", "false").lower() == "true"

        # Choose client based on REST_LOCAL_MODE environment variable
        if self.local_mode:
            self.db_client = TraceRootSQLiteClient()
        else:
            self.db_client = TraceRootMongoDBClient()

        self._setup_routes()

    def _setup_routes(self):
        """Set up API routes"""
        # Apply rate limiting to routes using configuration
        self.router.get("/credentials")(self.get_credentials)

    async def get_credentials(
        self,
        request: Request,
        token: str,
    ) -> dict[str,
              Any]:
        """
        Verify a TraceRoot token and return configuration for the SDK.

        Args:
            request: FastAPI request object
            token: The TraceRoot token to verify

        Returns:
            Configuration dict containing otlp_endpoint and other settings

        Raises:
            HTTPException: If token is invalid or not found
        """
        if not token:
            raise HTTPException(status_code=400, detail="Token parameter is required")

        # Query credentials from database
        credentials = await self.db_client.get_traceroot_credentials_by_token(token)

        if not credentials:
            raise HTTPException(status_code=401, detail="Invalid token")

        return credentials


def generate_user_credentials(hashed_user_sub: str, user_email: str) -> dict[str, Any]:
    """Legacy function - kept for backwards compatibility"""
