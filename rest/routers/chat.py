"""Chat router - HTTP interface for AI chat and agent endpoints.

This router handles HTTP concerns only (validation, error codes, serialization).
All business logic is delegated to ChatLogic driver.
"""

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from slowapi import Limiter

from rest.config import (
    ChatRequest,
    CodeRequest,
    ConfirmActionRequest,
    GetChatHistoryRequest,
    GetChatMetadataHistoryRequest,
    GetChatMetadataRequest,
)
from rest.config.rate_limit import get_rate_limit_config
from rest.driver.chat_logic import ChatLogic

try:
    from rest.utils.ee.auth import get_user_credentials
except ImportError:
    from rest.utils.auth import get_user_credentials


class ChatRouterClass:
    """HTTP router for chat and AI agent endpoints."""

    def __init__(
        self,
        local_mode: bool,
        limiter: Limiter,
    ):
        """Initialize chat router.

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
        self.driver = ChatLogic(local_mode)

        # Set up routes
        self._setup_routes()

    def _setup_routes(self):
        """Set up API routes with rate limiting."""
        # Apply rate limiting to routes using configuration
        self.router.post("/post-chat")(
            self.limiter.limit(self.rate_limit_config.post_chat_limit)(self.post_chat)
        )
        self.router.get("/get-chat-metadata-history")(
            self.limiter.limit(self.rate_limit_config.get_chat_metadata_history_limit
                               )(self.get_chat_metadata_history)
        )
        self.router.get("/get-chat-metadata")(
            self.limiter.limit(self.rate_limit_config.get_chat_metadata_limit
                               )(self.get_chat_metadata)
        )
        self.router.get("/get-chat-history")(
            self.limiter.limit(self.rate_limit_config.get_chat_history_limit
                               )(self.get_chat_history)
        )
        self.router.get("/get-line-context-content")(
            self.limiter.limit(self.rate_limit_config.get_line_context_content_limit
                               )(self.get_line_context_content)
        )
        self.router.post("/confirm-github-action")(
            self.limiter.limit("60/minute")(self.confirm_github_action)
        )

    async def post_chat(
        self,
        request: Request,
        req_data: ChatRequest,
    ) -> dict[str,
              Any]:
        """HTTP handler for chat requests.

        This endpoint:
        - Routes user messages to appropriate AI agents
        - Handles GitHub action confirmations
        - Coordinates trace/log/code fetching

        Args:
            request: FastAPI request object
            req_data: Chat request data

        Returns:
            Dictionary containing chatbot response

        Raises:
            HTTPException: If request validation fails or service error occurs
        """
        try:
            # Get user credentials
            user_email, _, user_sub = get_user_credentials(request)

            # Delegate business logic to driver
            result = await self.driver.post_chat(
                request=request,
                req_data=req_data,
                user_email=user_email,
                user_sub=user_sub,
            )

            return result

        except ValueError as e:
            # Business validation error - return 400
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            # Unexpected error - log and return 500
            self.logger.error(f"Error in post_chat: {e}")
            raise HTTPException(
                status_code=500,
                detail=f"Failed to process chat: {str(e)}"
            )

    async def get_chat_history(
        self,
        request: Request,
        req_data: GetChatHistoryRequest = Depends(),
    ) -> dict[str,
              Any]:
        """HTTP handler for getting chat history.

        Args:
            request: FastAPI request object
            req_data: Request containing chat ID

        Returns:
            Dictionary containing chat history

        Raises:
            HTTPException: If request validation fails or service error occurs
        """
        try:
            # Get user credentials (validates authentication)
            _, _, _ = get_user_credentials(request)

            # Delegate business logic to driver
            result = await self.driver.get_chat_history(chat_id=req_data.chat_id, )

            return result

        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            self.logger.error(f"Error getting chat history: {e}")
            raise HTTPException(
                status_code=500,
                detail=f"Failed to get chat history: {str(e)}"
            )

    async def get_chat_metadata_history(
        self,
        request: Request,
        req_data: GetChatMetadataHistoryRequest = Depends(),
    ) -> dict[str,
              Any]:
        """HTTP handler for getting chat metadata history.

        Args:
            request: FastAPI request object
            req_data: Request containing trace ID

        Returns:
            Dictionary containing chat metadata history

        Raises:
            HTTPException: If request validation fails or service error occurs
        """
        try:
            # Get user credentials (validates authentication)
            _, _, _ = get_user_credentials(request)

            # Delegate business logic to driver
            result = await self.driver.get_chat_metadata_history(
                trace_id=req_data.trace_id,
            )

            return result

        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            self.logger.error(f"Error getting chat metadata history: {e}")
            raise HTTPException(
                status_code=500,
                detail=f"Failed to get chat metadata history: {str(e)}"
            )

    async def get_chat_metadata(
        self,
        request: Request,
        req_data: GetChatMetadataRequest = Depends(),
    ) -> dict[str,
              Any]:
        """HTTP handler for getting chat metadata.

        Args:
            request: FastAPI request object
            req_data: Request containing chat ID

        Returns:
            Dictionary containing chat metadata, or empty dict if not found

        Raises:
            HTTPException: If request validation fails or service error occurs
        """
        try:
            # Get user credentials (validates authentication)
            _, _, _ = get_user_credentials(request)

            # Delegate business logic to driver
            result = await self.driver.get_chat_metadata(chat_id=req_data.chat_id, )

            return result

        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            self.logger.error(f"Error getting chat metadata: {e}")
            raise HTTPException(
                status_code=500,
                detail=f"Failed to get chat metadata: {str(e)}"
            )

    async def get_line_context_content(
        self,
        request: Request,
        req_data: CodeRequest = Depends(),
    ) -> dict[str,
              Any]:
        """HTTP handler for getting file line context from GitHub URL.

        This is called to show code in the UI.

        Args:
            request: FastAPI request object
            req_data: Request containing GitHub URL

        Returns:
            Dictionary of CodeResponse.model_dump()

        Raises:
            HTTPException: If URL is invalid or file cannot be retrieved
        """
        try:
            # Get user credentials
            user_email, _, _ = get_user_credentials(request)

            # Delegate business logic to driver
            result = await self.driver.get_line_context_content(
                url=req_data.url,
                user_email=user_email,
            )

            return result

        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            self.logger.error(f"Error getting line context: {e}")
            raise HTTPException(
                status_code=500,
                detail=f"Failed to get line context: {str(e)}"
            )

    async def confirm_github_action(
        self,
        request: Request,
        req_data: ConfirmActionRequest,
    ) -> dict[str,
              Any]:
        """HTTP handler for confirming or rejecting a pending GitHub action.

        Args:
            request: FastAPI request object
            req_data: Confirmation request data

        Returns:
            Confirmation response with result

        Raises:
            HTTPException: If action not found or execution fails
        """
        try:
            # Get user credentials
            user_email, _, user_sub = get_user_credentials(request)

            # Delegate business logic to driver
            result = await self.driver.confirm_github_action(
                req_data=req_data,
                user_email=user_email,
                user_sub=user_sub,
            )

            return result

        except HTTPException:
            # Re-raise HTTP exceptions from driver
            raise
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            self.logger.error(f"Error confirming GitHub action: {e}")
            raise HTTPException(
                status_code=500,
                detail=f"Failed to confirm action: {str(e)}"
            )
