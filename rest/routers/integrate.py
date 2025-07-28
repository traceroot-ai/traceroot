import os
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from slowapi import Limiter

try:
    from rest.client.ee.mongodb_client import TraceRootMongoDBClient
except ImportError:
    from rest.client.mongodb_client import TraceRootMongoDBClient
from rest.client.sqlite_client import TraceRootSQLiteClient
from rest.config import (DeleteIntegrateRequest, DeleteIntegrateResponse,
                         GetIntegrateResponse, IntegrateResponse)
from rest.config.rate_limit import get_rate_limit_config
from rest.typing import ResourceType, TokenResource

try:
    from rest.utils.ee.auth import (generate_traceroot_token,
                                    generate_user_credentials,
                                    get_user_credentials, hash_user_sub)
except ImportError:
    from rest.utils.auth import (generate_traceroot_token,
                                 generate_user_credentials,
                                 get_user_credentials, hash_user_sub)


class IntegrateRouter:
    r"""Integrate router for managing integration tokens.
    """

    def __init__(self, limiter: Limiter):
        self.router = APIRouter()

        # Choose client based on REMOTE_MODE environment variable
        self.local_mode = bool(os.getenv("TRACE_ROOT_LOCAL_MODE", False))
        if self.local_mode:
            self.db_client = TraceRootSQLiteClient()
        else:
            self.db_client = TraceRootMongoDBClient()

        self.limiter = limiter
        self.rate_limit_config = get_rate_limit_config()
        self._setup_routes()

    def _setup_routes(self):
        """Set up API routes"""
        # Apply rate limiting to routes using configuration
        self.router.post("")(self.limiter.limit(
            self.rate_limit_config.post_integrate_limit)(self.post_integrate))
        self.router.get("")(self.limiter.limit(
            self.rate_limit_config.get_integrate_limit)(self.get_integrate))
        self.router.delete("")(self.limiter.limit(
            self.rate_limit_config.delete_integrate_limit)(
                self.delete_integrate))

    async def post_integrate(
        self,
        request: Request,
        req_data: TokenResource,
    ) -> dict[str, Any]:
        r"""Post a integration token to MongoDB.

        Args:
            request (Request): FastAPI request object
            req_data (TokenResource): Request object
                containing token and resource_type.

        Returns:
            dict[str, Any]: Dictionary containing success status and token.
        """
        try:
            # Get user credentials (fake in local mode, real in remote mode)
            user_email, _, user_sub = get_user_credentials(request)

            if (req_data.token is None
                    and req_data.resource_type != ResourceType.TRACEROOT):
                raise HTTPException(
                    status_code=400,
                    detail=("Token is required for non-TraceRoot resources"))

            if (not self.local_mode
                    and req_data.resource_type == ResourceType.TRACEROOT):
                token = generate_traceroot_token()
                # Get user_sub for AWS role session
                user_credentials = generate_user_credentials(
                    user_sub, user_email)
                # Store the token in database
                await self.db_client.insert_traceroot_token(
                    token=token,
                    user_credentials=user_credentials,
                    delete_existing=True)
            elif (self.local_mode
                  and req_data.resource_type == ResourceType.TRACEROOT):
                # return a fake token for local mode, don't insert into DB
                token = "fake_traceroot_token_for_local_mode"
                return IntegrateResponse(success=True,
                                         token=token).model_dump()
            else:
                token = req_data.token

            # Store the token in database
            await self.db_client.insert_integration_token(
                user_email=user_email,
                token=token,
                token_type=req_data.resource_type.value)

            response = IntegrateResponse(success=True, token=token)
            return response.model_dump()

        except HTTPException:
            # Re-raise HTTP exceptions as they already have proper status codes
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    async def get_integrate(
        self,
        request: Request,
        resourceType: str,
    ) -> dict[str, Any]:
        r"""Get a integration token from MongoDB.

        Args:
            request (Request): FastAPI request object
            resourceType (str): The resource type to search for

        Returns:
            dict[str, Any]: Dictionary containing success status and token.
        """
        try:
            # Get user credentials (fake in local mode, real in remote mode)
            user_email, _, user_sub = get_user_credentials(request)

            # Get the token from database
            if resourceType != ResourceType.TRACEROOT:
                token = await self.db_client.get_integration_token(
                    user_email=user_email, token_type=resourceType)
            else:
                hashed_user_sub = hash_user_sub(user_sub)
                token = await self.db_client.get_traceroot_token(
                    hashed_user_sub=hashed_user_sub)

            response = GetIntegrateResponse(success=True, token=token)
            return response.model_dump()

        except HTTPException:
            # Re-raise HTTP exceptions as they already have proper status codes
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    async def delete_integrate(
        self,
        request: Request,
        req_data: DeleteIntegrateRequest,
    ) -> dict[str, Any]:
        r"""Delete a integration token from MongoDB.

        Args:
            request (Request): FastAPI request object
            req_data (DeleteIntegrateRequest): Request object
                containing resource_type.

        Returns:
            dict[str, Any]: Dictionary containing success status.
        """
        try:
            # Get user credentials (fake in local mode, real in remote mode)
            user_email, _, user_sub = get_user_credentials(request)

            if req_data.resource_type != ResourceType.TRACEROOT:
                # Delete the token from database
                success = await self.db_client.delete_integration_token(
                    user_email=user_email, token_type=req_data.resource_type)
            else:
                hashed_user_sub = hash_user_sub(user_sub)
                # Delete the token from database
                success = await self.db_client.delete_traceroot_token(
                    hashed_user_sub=hashed_user_sub)

            response = DeleteIntegrateResponse(success=success)
            return response.model_dump()

        except HTTPException:
            # Re-raise HTTP exceptions as they already have proper status codes
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
