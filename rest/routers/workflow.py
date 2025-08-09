import os
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from slowapi import Limiter

try:
    from rest.client.ee.mongodb_client import TraceRootMongoDBClient
except ImportError:
    from rest.client.mongodb_client import TraceRootMongoDBClient
from rest.client.sqlite_client import TraceRootSQLiteClient
from rest.config import (DeleteWorkflowRequest, DeleteWorkflowResponse,
                         GetWorkflowResponse, WorkflowCheckbox, WorkflowRequest,
                         WorkflowResponse)
from rest.config.rate_limit import get_rate_limit_config

try:
    from rest.utils.ee.auth import get_user_credentials
except ImportError:
    from rest.utils.auth import get_user_credentials


class WorkflowRouter:
    r"""Workflow router for managing workflow configurations.
    """

    def __init__(self, limiter: Limiter):
        self.router = APIRouter()
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
            self.rate_limit_config.post_integrate_limit)(self.post_workflow))
        self.router.get("")(self.limiter.limit(
            self.rate_limit_config.get_integrate_limit)(self.get_workflow))
        self.router.delete("")(self.limiter.limit(
            self.rate_limit_config.delete_integrate_limit)(
                self.delete_workflow))

    async def post_workflow(
        self,
        request: Request,
        req_data: WorkflowRequest,
    ) -> dict[str, Any]:
        r"""Enable a workflow checkbox for a user.

        Args:
            request (Request): FastAPI request object
            req_data (WorkflowRequest): Request object
                containing checkbox_type.

        Returns:
            dict[str, Any]: Dictionary containing success status.
        """
        try:
            # Get user credentials (fake in local mode, real in remote mode)
            user_email, _, _ = get_user_credentials(request)

            # Enable the specified workflow checkbox
            success = await self.db_client.insert_workflow(
                user_email=user_email,
                checkbox_type=req_data.checkbox_type)

            response = WorkflowResponse(success=success)
            return response.model_dump()

        except HTTPException:
            # Re-raise HTTP exceptions as they already have proper status codes
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    async def get_workflow(
        self,
        request: Request,
    ) -> dict[str, Any]:
        r"""Get workflow configuration for a user.

        Args:
            request (Request): FastAPI request object

        Returns:
            dict[str, Any]: Dictionary containing success status and workflow configuration.
        """
        try:
            # Get user credentials (fake in local mode, real in remote mode)
            user_email, _, _ = get_user_credentials(request)

            # Get the workflow configuration from database
            workflow = await self.db_client.get_workflow(user_email=user_email)
            
            # If no workflow found, return default configuration
            if workflow is None:
                workflow = WorkflowCheckbox()

            response = GetWorkflowResponse(success=True, workflow=workflow)
            return response.model_dump()

        except HTTPException:
            # Re-raise HTTP exceptions as they already have proper status codes
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    async def delete_workflow(
        self,
        request: Request,
        req_data: DeleteWorkflowRequest,
    ) -> dict[str, Any]:
        r"""Disable a workflow checkbox for a user.

        Args:
            request (Request): FastAPI request object
            req_data (DeleteWorkflowRequest): Request object
                containing checkbox_type.

        Returns:
            dict[str, Any]: Dictionary containing success status.
        """
        try:
            # Get user credentials (fake in local mode, real in remote mode)
            user_email, _, _ = get_user_credentials(request)

            # Disable the specified workflow checkbox
            success = await self.db_client.delete_workflow(
                user_email=user_email,
                checkbox_type=req_data.checkbox_type)

            response = DeleteWorkflowResponse(success=success)
            return response.model_dump()

        except HTTPException:
            # Re-raise HTTP exceptions as they already have proper status codes
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
