import asyncio
import logging
from collections import deque
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from slowapi import Limiter

from rest.agent.agents.code_agent import CodeAgent
from rest.agent.agents.general_agent import GeneralAgent
from rest.agent.agents.single_rca_agent import SingleRCAAgent
from rest.agent.router import ChatRouter
from rest.cache import Cache, CacheType
from rest.service.provider import ObservabilityProvider
from rest.tools.github import GitHubClient

try:
    from rest.dao.ee.mongodb_dao import TraceRootMongoDBClient
except ImportError:
    from rest.dao.mongodb_dao import TraceRootMongoDBClient

from rest.agent.context.tree import SpanNode, build_heterogeneous_tree
from rest.agent.summarizer.chatbot_output import summarize_chatbot_output
from rest.agent.summarizer.github import SeparateIssueAndPrInput, separate_issue_and_pr
from rest.agent.summarizer.title import summarize_title
from rest.config import (
    ChatbotResponse,
    ChatHistoryResponse,
    ChatMetadata,
    ChatMetadataHistory,
    ChatRequest,
    CodeRequest,
    GetChatHistoryRequest,
    GetChatMetadataHistoryRawRequest,
    GetChatMetadataRequest,
    GetLogByTraceIdRequest,
    GetLogByTraceIdResponse,
    GetLogsByTimeRangeRequest,
    GetLogsByTimeRangeResponse,
    ListTraceRawRequest,
    ListTraceRequest,
    ListTraceResponse,
    Trace,
    TraceLogs,
)
from rest.config.rate_limit import get_rate_limit_config
from rest.dao.sqlite_dao import TraceRootSQLiteClient
from rest.typing import (
    ActionStatus,
    ActionType,
    ChatMode,
    ChatModel,
    MessageType,
    Operation,
    Provider,
    Reference,
    ReferenceWithTrace,
    ResourceType,
)
from rest.utils.trace import collect_spans_latency_recursively

try:
    from rest.service.trace.ee.aws_trace_client import AWSTraceClient
except ImportError:
    from rest.service.trace.aws_trace_client import AWSTraceClient

try:
    from rest.utils.ee.auth import get_user_credentials, hash_user_sub
except ImportError:
    from rest.utils.auth import get_user_credentials, hash_user_sub

from rest.agent.summarizer.github import is_github_related, set_github_related
from rest.utils.github import parse_github_url


class ExploreRouter:
    r"""Explore router."""

    def __init__(
        self,
        local_mode: bool,
        limiter: Limiter,
    ):
        self.router = APIRouter()
        self.local_mode = local_mode
        self.single_rca_agent = SingleRCAAgent()
        self.code_agent = CodeAgent()
        self.general_agent = GeneralAgent()
        self.chat_router = ChatRouter()
        self.logger = logging.getLogger(__name__)

        # Choose client based on REST_LOCAL_MODE environment variable
        if self.local_mode:
            self.db_client = TraceRootSQLiteClient()
        else:
            self.db_client = TraceRootMongoDBClient()

        # Create default observability provider
        if self.local_mode:
            self.default_observe_provider = ObservabilityProvider.create_jaeger_provider()
        else:
            self.default_observe_provider = ObservabilityProvider.create_aws_provider()

        self.github = GitHubClient()
        self.limiter = limiter
        self.rate_limit_config = get_rate_limit_config()
        self.cache = Cache()
        self._setup_routes()

    async def get_observe_provider(
        self,
        request: Request,
        trace_provider: str | None = None,
        log_provider: str | None = None,
        trace_region: str | None = None,
        log_region: str | None = None,
    ) -> ObservabilityProvider:
        """Get observability provider based on request.

        For local mode, always use the default Jaeger provider.
        For non-local mode, fetch provider configuration from request params and MongoDB.

        Args:
            request: FastAPI request object
            trace_provider: Override trace provider (if None, read from query params)
            log_provider: Override log provider (if None, read from query params)
            trace_region: Override trace region (if None, read from query params)
            log_region: Override log region (if None, read from query params)

        Returns:
            ObservabilityProvider instance
        """
        if self.local_mode:
            return self.default_observe_provider

        # Extract provider parameters from request query params if not provided
        query_params = request.query_params
        if trace_provider is None:
            trace_provider = query_params.get("trace_provider", "aws")
        if log_provider is None:
            log_provider = query_params.get("log_provider", "aws")
        if trace_region is None:
            trace_region = query_params.get("trace_region")
        if log_region is None:
            log_region = query_params.get("log_region")

        # Get user email to fetch MongoDB config
        user_email, _, _ = get_user_credentials(request)

        # Prepare configurations
        trace_config: dict[str, Any] = {}
        log_config: dict[str, Any] = {}

        # For Tencent, fetch credentials from MongoDB
        if trace_provider == "tencent":
            trace_provider_config = await self.db_client.get_trace_provider_config(
                user_email
            )
            if trace_provider_config and trace_provider_config.get("tencentTraceConfig"):
                tencent_config = trace_provider_config["tencentTraceConfig"]
                trace_config = {
                    "region": trace_region or tencent_config.get("region",
                                                                 "ap-hongkong"),
                    "secret_id": tencent_config.get("secretId"),
                    "secret_key": tencent_config.get("secretKey"),
                    "apm_instance_id": tencent_config.get("apmInstanceId"),
                }
            else:
                # Fallback to region only if no MongoDB config
                trace_config = {"region": trace_region or "ap-hongkong"}
        elif trace_provider == "aws":
            trace_config = {"region": trace_region}
        elif trace_provider == "jaeger":
            # Fetch jaeger config from MongoDB if available
            trace_provider_config = await self.db_client.get_trace_provider_config(
                user_email
            )
            if trace_provider_config and trace_provider_config.get("jaegerTraceConfig"):
                jaeger_config = trace_provider_config["jaegerTraceConfig"]
                trace_config = {"url": jaeger_config.get("endpoint")}
            else:
                trace_config = {}

        if log_provider == "tencent":
            log_provider_config = await self.db_client.get_log_provider_config(user_email)
            if log_provider_config and log_provider_config.get("tencentLogConfig"):
                tencent_config = log_provider_config["tencentLogConfig"]
                log_config = {
                    "region": log_region or tencent_config.get("region",
                                                               "ap-hongkong"),
                    "secret_id": tencent_config.get("secretId"),
                    "secret_key": tencent_config.get("secretKey"),
                    "cls_topic_id": tencent_config.get("clsTopicId"),
                }
            else:
                # Fallback to region only if no MongoDB config
                log_config = {"region": log_region or "ap-hongkong"}
        elif log_provider == "aws":
            log_config = {"region": log_region}
        elif log_provider == "jaeger":
            # Fetch jaeger config from MongoDB if available
            log_provider_config = await self.db_client.get_log_provider_config(user_email)
            if log_provider_config and log_provider_config.get("jaegerLogConfig"):
                jaeger_config = log_provider_config["jaegerLogConfig"]
                log_config = {"url": jaeger_config.get("endpoint")}
            else:
                log_config = {}

        # Create and return the provider
        return ObservabilityProvider.create(
            trace_provider=trace_provider,
            log_provider=log_provider,
            trace_config=trace_config,
            log_config=log_config,
        )

    def _setup_routes(self):
        r"""Set up API routes"""
        # Apply rate limiting to routes using configuration
        self.router.get("/list-traces")(
            self.limiter.limit(self.rate_limit_config.list_traces_limit
                               )(self.list_traces)
        )
        self.router.get("/get-logs-by-trace-id")(
            self.limiter.limit(self.rate_limit_config.get_logs_limit
                               )(self.get_logs_by_trace_id)
        )
        self.router.get("/get-logs-by-time-range")(
            self.limiter.limit(self.rate_limit_config.get_logs_limit
                               )(self.get_logs_by_time_range)
        )
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
        self.router.get("/chat/{chat_id}/reasoning")(
            self.limiter.limit("1200/minute")(self.get_chat_reasoning)
        )
        self.router.get("/get-line-context-content")(
            self.limiter.limit(self.rate_limit_config.get_line_context_content_limit
                               )(self.get_line_context_content)
        )

    async def get_line_context_content(
        self,
        request: Request,
        req_data: CodeRequest = Depends(),
    ) -> dict[str,
              Any]:
        """Get file line context content from GitHub URL.
        This is called to show the code in the UI.

        Args:
            req_data (CodeRequest): Request containing GitHub URL

        Returns:
            dict[str, Any]: Dictionary of CodeResponse.model_dump().

        Raises:
            HTTPException: If URL is invalid or file cannot be
                retrieved
        """
        # Get user credentials (fake in local mode, real in remote mode)
        user_email, _, _ = get_user_credentials(request)
        github_token = await self.get_github_token(user_email)

        owner, repo, ref, file_path, line_num = parse_github_url(req_data.url)
        return await self.github.get_file_with_context(
            owner=owner,
            repo=repo,
            file_path=file_path,
            ref=ref,
            line_num=line_num,
            github_token=github_token,
            cache=self.cache,
            line_context_len=4,
        )

    async def list_traces(
        self,
        request: Request,
        raw_req: ListTraceRawRequest = Depends(),
    ) -> dict[str,
              Any]:
        r"""Get trace data with optional timestamp filtering or trace ID.

        Args:
            request (Request): FastAPI request object
            raw_req (ListTraceRawRequest): Raw request data from
                query parameters

        Returns:
            dict[str, Any]: Dictionary containing list of trace data.
        """
        _, _, user_sub = get_user_credentials(request)
        log_group_name = hash_user_sub(user_sub)

        # Convert raw request to proper ListTraceRequest
        # with correct list parsing
        req_data: ListTraceRequest = raw_req.to_list_trace_request(request)
        start_time = req_data.start_time
        end_time = req_data.end_time
        categories = req_data.categories.copy()  # Make a copy to modify
        values = req_data.values.copy()
        operations = req_data.operations.copy()
        trace_id = req_data.trace_id

        # Decode pagination token
        pagination_state = None
        if req_data.pagination_token:
            from rest.utils.pagination import decode_pagination_token
            try:
                pagination_state = decode_pagination_token(req_data.pagination_token)
            except ValueError as e:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid pagination token: {str(e)}"
                )

        # If trace_id is provided, fetch that specific trace directly
        if trace_id:
            try:
                observe_provider = await self.get_observe_provider(request)

                # Use the new get_trace_by_id method which handles everything
                trace = await observe_provider.trace_client.get_trace_by_id(
                    trace_id=trace_id,
                    categories=categories,
                    values=values,
                    operations=[Operation(op)
                                for op in operations] if operations else None,
                )

                # If trace not found, return empty list
                if trace is None:
                    resp = ListTraceResponse(traces=[])
                    return resp.model_dump()

                resp = ListTraceResponse(traces=[trace])
                return resp.model_dump()

            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))
            except Exception as e:
                self.logger.error(f"Error fetching trace by ID {trace_id}: {e}")
                raise HTTPException(
                    status_code=500,
                    detail=f"Failed to fetch trace: {str(e)}"
                )

        keys = (
            start_time,
            end_time,
            tuple(categories),
            tuple(values),
            tuple(operations),
            log_group_name,
            req_data.pagination_token or 'first_page'
        )

        # Extract service names, service environment, and log search
        # values from categories/values/operations
        service_name_values = []
        service_name_operations = []
        service_environment_values = []
        service_environment_operations = []
        log_search_values = []
        log_search_operations = []

        # Create lists to hold remaining categories/values/operations
        # after extraction
        remaining_categories = []
        remaining_values = []
        remaining_operations = []

        # Process each category/value/operation triplet
        for i, category in enumerate(categories):
            if i < len(values) and i < len(operations):
                value = values[i]
                operation = operations[i]

                if category == "service_name":
                    service_name_values.append(value)
                    service_name_operations.append(operation)
                elif category == "service_environment":
                    service_environment_values.append(value)
                    service_environment_operations.append(operation)
                elif category == "log":
                    log_search_values.append(value)
                    log_search_operations.append(operation)
                else:
                    # Keep non-service categories
                    remaining_categories.append(category)
                    remaining_values.append(value)
                    remaining_operations.append(operation)
            else:
                # Keep categories without corresponding values/operations
                remaining_categories.append(category)

        # Update categories/values/operations with remaining items
        categories = remaining_categories
        values = remaining_values
        operations = remaining_operations

        # Convert operations to Operation enum
        operations = [Operation(op) for op in operations]
        service_name_operations = [Operation(op) for op in service_name_operations]
        service_environment_operations = [
            Operation(op) for op in service_environment_operations
        ]

        cached_result: tuple | None = await self.cache[CacheType.TRACE].get(keys)
        if cached_result:
            traces, next_state = cached_result
            next_pagination_token = None
            if next_state:
                from rest.utils.pagination import encode_pagination_token
                next_pagination_token = encode_pagination_token(next_state)
            resp = ListTraceResponse(
                traces=traces,
                next_pagination_token=next_pagination_token,
                has_more=next_pagination_token is not None
            )
            return resp.model_dump()

        try:
            observe_provider = await self.get_observe_provider(request)

            # Check if this is log-search pagination (from "load more" click)
            is_log_search_pagination = (
                pagination_state and pagination_state.get('type') == 'log_search'
            )

            # If log search is active OR we're continuing log-search pagination
            if log_search_values or is_log_search_pagination:
                # For pagination continuation, retrieve search term from pagination state
                if is_log_search_pagination and not log_search_values:
                    # Extract search term from cache key (stored in pagination state)
                    # We can re-query or store it in pagination state
                    # For now, we'll store it in pagination state
                    log_search_values = [pagination_state.get('search_term', '')]

                # Get trace provider from request
                trace_provider = request.query_params.get("trace_provider", "aws")

                traces, next_state = await self._get_traces_by_log_search_paginated(
                    request=request,
                    observe_provider=observe_provider,
                    start_time=start_time,
                    end_time=end_time,
                    log_group_name=log_group_name,
                    log_search_values=log_search_values,
                    categories=categories,
                    values=values,
                    operations=operations,
                    pagination_state=pagination_state,
                    trace_provider=trace_provider,
                )
            else:
                # Normal pagination flow for non-log-filtered requests
                traces, next_state = \
                    await observe_provider.trace_client.get_recent_traces(
                        start_time=start_time,
                        end_time=end_time,
                        log_group_name=log_group_name,
                        service_name_values=service_name_values,
                        service_name_operations=service_name_operations,
                        service_environment_values=service_environment_values,
                        service_environment_operations=service_environment_operations,
                        categories=categories,
                        values=values,
                        operations=operations,
                        pagination_state=pagination_state,
                    )

            # Encode next pagination token
            next_pagination_token = None
            if next_state:
                from rest.utils.pagination import encode_pagination_token
                next_pagination_token = encode_pagination_token(next_state)

            # Cache the result for 10 minutes
            await self.cache[CacheType.TRACE].set(keys, (traces, next_state))
            resp = ListTraceResponse(
                traces=traces,
                next_pagination_token=next_pagination_token,
                has_more=next_pagination_token is not None
            )
            return resp.model_dump()
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    async def get_chat_history(
        self,
        request: Request,
        req_data: GetChatHistoryRequest = Depends(),
    ) -> dict[str,
              Any]:
        # Get user credentials (fake in local mode, real in remote mode)
        _, _, _ = get_user_credentials(request)

        history: list[dict[str,
                           Any]
                      ] = await self.db_client.get_chat_history(chat_id=req_data.chat_id)
        chat_history = ChatHistoryResponse(history=[])
        for item in history:
            # For user only shows the user message
            # without the context information
            if item["role"] == "user":
                if "user_message" in item:
                    message = item["user_message"]
                else:
                    message = item["content"]
            else:
                message = item["content"]
            # Reference is only for assistant message
            if item["role"] == "assistant" and "reference" in item:
                # Check if references have trace_id field (for multi-trace scenarios)
                reference = []
                for ref in item["reference"]:
                    if "trace_id" in ref and ref["trace_id"]:
                        reference.append(ReferenceWithTrace(**ref))
                    else:
                        reference.append(Reference(**ref))
            else:
                reference = []

            # Skip chunk messages except the first one
            # For now chunk_id is only used for user message
            # where we cut the user message + context into chunks
            chunk_id = 0
            if "chunk_id" in item and item["chunk_id"] > 0:
                continue
            if "chunk_id" in item:
                chunk_id = int(item["chunk_id"])
            if "action_type" in item:
                action_type = item["action_type"]
            else:
                action_type = None
            if "status" in item:
                status = item["status"]
            else:
                status = None
            chat_history.history.append(
                ChatbotResponse(
                    time=item["timestamp"],
                    message=message,
                    reference=reference,
                    message_type=item["role"],
                    chat_id=item["chat_id"],
                    chunk_id=chunk_id,
                    action_type=action_type,
                    status=status,
                )
            )
        return chat_history.model_dump()

    async def get_logs_by_trace_id(
        self,
        request: Request,
        req_data: GetLogByTraceIdRequest = Depends(),
    ) -> dict[str,
              Any]:
        r"""Get trace logs by trace ID.

        Args:
            req_data (GetLogByTraceIdRequest): Request object
                containing trace ID.

        Returns:
            dict[str, Any]: Dictionary containing trace logs
                for the given trace ID.
        """
        _, _, user_sub = get_user_credentials(request)
        log_group_name = hash_user_sub(user_sub)

        try:
            observe_provider = await self.get_observe_provider(request)

            # Optimization: If start_time/end_time not provided, fetch trace
            # to get timestamps which allows for much faster log queries
            log_start_time = req_data.start_time
            log_end_time = req_data.end_time

            if log_start_time is None or log_end_time is None:
                trace = await observe_provider.trace_client.get_trace_by_id(
                    trace_id=req_data.trace_id,
                    categories=None,
                    values=None,
                    operations=None,
                )
                if trace:
                    # Check if this is a LimitExceeded trace
                    if (
                        trace.service_name == "LimitExceeded" and trace.start_time == 0.0
                        and trace.end_time == 0.0
                    ):
                        # For LimitExceeded traces, fetch timestamps from logs
                        try:
                            log_client = observe_provider.log_client
                            (
                                earliest,
                                latest,
                            ) = await log_client.get_log_timestamps_by_trace_id(
                                trace_id=req_data.trace_id,
                                log_group_name=log_group_name,
                                start_time=req_data.start_time,
                                end_time=req_data.end_time,
                            )
                            if earliest and latest:
                                log_start_time = earliest
                                log_end_time = latest
                        except Exception as e:
                            print(
                                f"Failed to get log timestamps for "
                                f"LimitExceeded trace {req_data.trace_id}: {e}"
                            )
                    else:
                        # Normal trace with valid timestamps
                        log_start_time = datetime.fromtimestamp(
                            trace.start_time,
                            tz=timezone.utc
                        )
                        log_end_time = datetime.fromtimestamp(
                            trace.end_time,
                            tz=timezone.utc
                        )

            # Try to get cached logs
            keys = (req_data.trace_id, log_start_time, log_end_time, log_group_name)
            cached_logs: TraceLogs | None = await self.cache[CacheType.LOG].get(keys)
            if cached_logs:
                resp = GetLogByTraceIdResponse(
                    trace_id=req_data.trace_id,
                    logs=cached_logs
                )
                return resp.model_dump()

            logs: TraceLogs = await observe_provider.log_client.get_logs_by_trace_id(
                trace_id=req_data.trace_id,
                start_time=log_start_time,
                end_time=log_end_time,
                log_group_name=log_group_name,
            )
            # Cache the logs for 10 minutes
            await self.cache[CacheType.LOG].set(keys, logs)
            resp = GetLogByTraceIdResponse(trace_id=req_data.trace_id, logs=logs)
            return resp.model_dump()
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    async def get_logs_by_time_range(
        self,
        request: Request,
        req_data: GetLogsByTimeRangeRequest = Depends(),
    ) -> dict[str,
              Any]:
        r"""Get logs by time range without requiring a trace ID.

        This is used in log mode where we fetch logs independently of traces.

        Args:
            request (Request): FastAPI request object
            req_data (GetLogsByTimeRangeRequest): Request object
                containing time range and optional search term.

        Returns:
            dict[str, Any]: Dictionary containing logs for the given time range.
        """
        _, _, user_sub = get_user_credentials(request)
        log_group_name = hash_user_sub(user_sub)

        # Decode pagination token
        pagination_state = None
        if req_data.pagination_token:
            from rest.utils.pagination import decode_pagination_token
            try:
                pagination_state = decode_pagination_token(req_data.pagination_token)
            except ValueError as e:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid pagination token: {str(e)}"
                )

        try:
            observe_provider = await self.get_observe_provider(request)

            logs, has_more, next_state = \
                await observe_provider.log_client.get_logs_by_time_range(
                    start_time=req_data.start_time,
                    end_time=req_data.end_time,
                    log_group_name=log_group_name,
                    log_search_term=req_data.log_search_term,
                    pagination_state=pagination_state,
                )

            # Encode next pagination token
            next_pagination_token = None
            if next_state:
                from rest.utils.pagination import encode_pagination_token
                next_pagination_token = encode_pagination_token(next_state)

            resp = GetLogsByTimeRangeResponse(
                logs=logs,
                has_more=has_more,
                next_pagination_token=next_pagination_token,
            )
            return resp.model_dump()
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    async def get_chat_metadata_history(
        self,
        request: Request,
        raw_req: GetChatMetadataHistoryRawRequest = Depends(),
    ) -> dict[str,
              Any]:
        # Get user credentials (fake in local mode, real in remote mode)
        _, _, _ = get_user_credentials(request)

        # Convert raw request to proper request with parsed list parameters
        req_data = raw_req.to_chat_metadata_history_request(request)

        chat_metadata_history: ChatMetadataHistory = await (
            self.db_client.get_chat_metadata_history(
                trace_id=req_data.trace_id,
                trace_ids=req_data.trace_ids
            )
        )
        return chat_metadata_history.model_dump()

    async def get_chat_metadata(
        self,
        request: Request,
        req_data: GetChatMetadataRequest = Depends(),
    ) -> dict[str,
              Any]:
        # Get user credentials (fake in local mode, real in remote mode)
        _, _, _ = get_user_credentials(request)
        chat_metadata: ChatMetadata | None = await (
            self.db_client.get_chat_metadata(chat_id=req_data.chat_id)
        )
        if chat_metadata is None:
            return {}
        return chat_metadata.model_dump()

    async def get_chat_reasoning(
        self,
        request: Request,
        chat_id: str,
    ) -> dict[str,
              Any]:
        """Get reasoning/thinking data for a specific chat."""
        # Get user credentials (fake in local mode, real in remote mode)
        _, _, _ = get_user_credentials(request)

        try:
            # Query for reasoning data from the database
            # Look for records with is_streaming=True for the given chat_id
            reasoning_records = await self.db_client.get_chat_reasoning(chat_id=chat_id)

            return {"chat_id": chat_id, "reasoning": reasoning_records}

        except Exception as e:
            self.logger.error(f"Error fetching reasoning for chat {chat_id}: {e}")
            raise HTTPException(status_code=500, detail="Failed to fetch reasoning data")

    async def get_github_token(self, user_email: str) -> str | None:
        return await self.db_client.get_integration_token(
            user_email=user_email,
            token_type=ResourceType.GITHUB.value,
        )

    async def post_chat(
        self,
        request: Request,
        req_data: ChatRequest,
    ) -> dict[str,
              Any]:
        # Get basic information ###############################################
        user_email, _, user_sub = get_user_credentials(request)
        log_group_name = hash_user_sub(user_sub)
        trace_id = req_data.trace_id
        trace_ids = req_data.trace_ids if req_data.trace_ids else (
            [trace_id] if trace_id else []
        )
        span_ids = req_data.span_ids
        start_time = req_data.start_time
        end_time = req_data.end_time
        model = req_data.model
        message = req_data.message
        chat_id = req_data.chat_id
        req_data.service_name
        mode = req_data.mode
        # TODO: For other model testing
        req_data.model
        provider = req_data.provider

        if model == ChatModel.AUTO:
            model = ChatModel.GPT_4O
        # Still use the GPT-4o model for main model for now
        elif provider == Provider.CUSTOM:
            model = ChatModel.GPT_4O

        if req_data.time.tzinfo:
            orig_time = req_data.time.astimezone(timezone.utc)
        else:
            orig_time = req_data.time.replace(tzinfo=timezone.utc)

        # Get OpenAI token ####################################################
        openai_token = await self.db_client.get_integration_token(
            user_email=user_email,
            token_type=ResourceType.OPENAI.value,
        )

        if openai_token is None and self.single_rca_agent.local_mode:
            response = ChatbotResponse(
                time=orig_time,
                message=(
                    "OpenAI token is not found, please "
                    "add it in the settings page."
                ),
                reference=[],
                message_type=MessageType.ASSISTANT,
                chat_id=chat_id,
            )
            return response.model_dump()

        # Get whether it's the first chat #####################################
        first_chat: bool = False
        if await self.db_client.get_chat_metadata(chat_id=chat_id) is None:
            first_chat = True

        # Get the title and GitHub related information ########################
        title, github_related = await asyncio.gather(
            summarize_title(
                user_message=message,
                client=self.single_rca_agent.chat_client,
                openai_token=openai_token,
                model=ChatModel.GPT_4_1_MINI,  # Use GPT-4.1-mini for title
                first_chat=first_chat,
                user_sub=user_sub,
            ),
            is_github_related(
                user_message=message,
                client=self.single_rca_agent.chat_client,
                openai_token=openai_token,
                model=ChatModel.GPT_4O,
                user_sub=user_sub,
            ))

        # Get the title of the chat if it's the first chat ####################
        if first_chat and title is not None:
            await self.db_client.insert_chat_metadata(
                metadata={
                    "chat_id": chat_id,
                    "timestamp": orig_time,
                    "chat_title": title,
                    "trace_id": trace_id,  # Keep for backward compatibility
                    "trace_ids": trace_ids,  # Store multiple trace IDs
                    "user_id": user_sub,
                }
            )

        # Get whether the user message is related to GitHub ###################
        set_github_related(github_related)
        is_github_issue: bool = False
        is_github_pr: bool = False
        source_code_related: bool = False
        source_code_related = github_related.source_code_related
        # For now only allow issue and PR creation for agent and non-local mode
        if mode == ChatMode.AGENT:
            is_github_issue = github_related.is_github_issue
            is_github_pr = github_related.is_github_pr

        # Route the query to appropriate agent #################################
        # Always use router to decide which agent to use
        # Provide context to help router make better decisions
        # TODO: remove the github code related and only use the route query
        router_output = await self.chat_router.route_query(
            user_message=message,
            chat_mode=mode,
            model=ChatModel.GPT_4O,
            user_sub=user_sub,
            openai_token=openai_token,
            has_trace_context=bool(trace_ids),  # Check if any traces are selected
            is_github_issue=is_github_issue,
            is_github_pr=is_github_pr,
            source_code_related=source_code_related,
        )

        # Insert routing decision to MongoDB for tracking/analytics
        await self.db_client.insert_chat_routing_record(
            {
                "chat_id": chat_id,
                "timestamp": orig_time,
                "user_message": message,
                "agent_type": router_output.agent_type,
                "reasoning": router_output.reasoning,
                "chat_mode": mode.value,
                "trace_id": trace_id or "",  # Keep for backward compatibility
                "trace_ids": trace_ids,  # Store multiple trace IDs
                "user_sub": user_sub,
            }
        )

        # Route to GeneralAgent if router decides (no trace context needed)
        if router_output.agent_type == "general":
            # Fetch chat history for general agent
            chat_history = await self.db_client.get_chat_history(chat_id=chat_id)
            response = await self.general_agent.chat(
                chat_id=chat_id,
                user_message=message,
                model=model,
                db_client=self.db_client,
                timestamp=orig_time,
                user_sub=user_sub,
                chat_history=chat_history,
                openai_token=openai_token,
                trace_id=trace_id,
            )
            return response.model_dump()

        # Get the traces (multiple if trace_ids provided) #####################
        observe_provider = await self.get_observe_provider(
            request,
            trace_provider=req_data.trace_provider,
            log_provider=req_data.log_provider,
            trace_region=req_data.trace_region,
            log_region=req_data.log_region,
        )

        # Fetch all traces in parallel
        selected_traces: dict[str, Trace] = {}
        fetch_tasks = []
        for tid in trace_ids:
            fetch_tasks.append(
                observe_provider.trace_client.get_trace_by_id(
                    trace_id=tid,
                    categories=None,
                    values=None,
                    operations=None,
                )
            )

        fetched_traces = await asyncio.gather(*fetch_tasks, return_exceptions=True)
        for tid, trace in zip(trace_ids, fetched_traces):
            if not isinstance(trace, Exception) and trace is not None:
                selected_traces[tid] = trace

        # Keep single trace for backward compatibility
        selected_trace: Trace | None = selected_traces.get(trace_id) if trace_id else None
        spans_latency_dict: dict[str, float] = {}

        # Compute the span latencies recursively ##############################
        if selected_trace:
            collect_spans_latency_recursively(
                selected_trace.spans,
                spans_latency_dict,
            )
            # Then select spans latency by span_ids
            # if span_ids is not empty
            if len(span_ids) > 0:
                selected_spans_latency_dict: dict[str, float] = {}
                for span_id, latency in spans_latency_dict.items():
                    if span_id in span_ids:
                        selected_spans_latency_dict[span_id] = latency
                spans_latency_dict = selected_spans_latency_dict

        # Get the logs for all traces ########################################
        # Fetch logs for each trace in parallel
        all_logs: dict[str, TraceLogs] = {}
        log_fetch_tasks = []
        log_trace_ids = []

        for tid, trace in selected_traces.items():
            # Determine log start/end times for this trace
            trace_start_time = None
            trace_end_time = None

            # Check if this is a LimitExceeded trace (start_time = 0)
            if (
                trace.service_name == "LimitExceeded" and trace.start_time == 0.0
                and trace.end_time == 0.0
            ):
                # For LimitExceeded traces, fetch timestamps from logs
                try:
                    earliest, latest = \
                        await observe_provider.log_client.get_log_timestamps_by_trace_id(
                            trace_id=tid,
                            log_group_name=log_group_name,
                            start_time=start_time,
                            end_time=end_time,
                        )
                    if earliest and latest:
                        trace_start_time = earliest
                        trace_end_time = latest
                        # Update the trace object
                        trace.start_time = earliest.timestamp()
                        trace.end_time = latest.timestamp()
                        trace.duration = latest.timestamp() - earliest.timestamp()
                        if trace.spans and len(trace.spans) > 0:
                            placeholder_span = trace.spans[0]
                            placeholder_span.start_time = earliest.timestamp()
                            placeholder_span.end_time = latest.timestamp()
                            placeholder_span.duration = latest.timestamp(
                            ) - earliest.timestamp()
                except Exception as e:
                    print(
                        f"Failed to get log timestamps for LimitExceeded trace {tid}: {e}"
                    )
            else:
                # Normal trace with valid timestamps
                trace_start_time = datetime.fromtimestamp(
                    trace.start_time,
                    tz=timezone.utc
                )
                trace_end_time = datetime.fromtimestamp(trace.end_time, tz=timezone.utc)

            log_start_time = trace_start_time if trace_start_time else start_time
            log_end_time = trace_end_time if trace_end_time else end_time

            # Check cache
            keys = (tid, log_start_time, log_end_time, log_group_name)
            cached_logs: TraceLogs | None = await self.cache[CacheType.LOG].get(keys)
            if cached_logs:
                all_logs[tid] = cached_logs
            else:
                # Create task to fetch logs
                log_fetch_tasks.append(
                    observe_provider.log_client.get_logs_by_trace_id(
                        trace_id=tid,
                        start_time=log_start_time,
                        end_time=log_end_time,
                        log_group_name=log_group_name,
                    )
                )
                log_trace_ids.append((tid, keys))

        # Fetch all logs in parallel
        if log_fetch_tasks:
            fetched_logs = await asyncio.gather(*log_fetch_tasks, return_exceptions=True)
            for (tid, cache_keys), logs_result in zip(log_trace_ids, fetched_logs):
                if not isinstance(logs_result, Exception):
                    all_logs[tid] = logs_result
                    # Cache the logs for 10 minutes
                    await self.cache[CacheType.LOG].set(cache_keys, logs_result)

        # Keep single logs for backward compatibility
        logs: TraceLogs | None = all_logs.get(trace_id) if trace_id else None

        # Get GitHub token
        github_token = await self.get_github_token(user_email)

        # Only fetch the source code if it's source code related ##############
        github_tasks: list[tuple[str, str, str, str]] = []
        log_entries_to_update: list = []
        github_task_keys: set[tuple[str, str, str, str]] = set()
        # Track unique files and map them to log entries
        unique_file_tasks: dict = {}  # key -> (task, [log_entries])
        print(f"logs: {logs}")
        if source_code_related:
            for log in logs.logs:
                for span_id, span_logs in log.items():
                    for log_entry in span_logs:
                        if log_entry.git_url:
                            owner, repo_name, ref, file_path, line_number = \
                                parse_github_url(log_entry.git_url)
                            # Create task for this GitHub file fetch
                            # notice that there is no await here
                            if is_github_pr:
                                line_context_len = 200
                            else:
                                line_context_len = 5

                            # Create unique key by file only (not line number)
                            # The cache will handle different line requests efficiently
                            file_key = (owner, repo_name, file_path, ref)

                            # Only create task if we haven't seen this file before
                            if file_key not in unique_file_tasks:
                                # Fetch file once - first line/context we encounter
                                task = self.github.get_file_with_context(
                                    owner=owner,
                                    repo=repo_name,
                                    file_path=file_path,
                                    ref=ref,
                                    line_num=line_number,
                                    github_token=github_token,
                                    cache=self.cache,
                                    line_context_len=line_context_len,
                                )
                                unique_file_tasks[file_key] = (task, [])
                                github_task_keys.add((owner, repo_name, file_path, ref))

                            # Add log entry with its specific line info
                            unique_file_tasks[file_key][1].append(
                                (line_number,
                                 line_context_len,
                                 log_entry)
                            )

            # Convert unique tasks to lists for batch processing
            file_keys_list = []
            for file_key, (task, entries) in unique_file_tasks.items():
                print(f"file_key: {file_key}")
                github_tasks.append(task)
                log_entries_to_update.append(entries)
                file_keys_list.append(file_key)

            # Process unique file tasks in batches of 20 to avoid overwhelming API
            batch_size = 20
            for i in range(0, len(github_tasks), batch_size):
                batch_tasks = github_tasks[i:i + batch_size]
                batch_log_entries_list = log_entries_to_update[i:i + batch_size]
                batch_file_keys = file_keys_list[i:i + batch_size]

                time = datetime.now().astimezone(timezone.utc)
                await self.db_client.insert_chat_record(
                    message={
                        "chat_id": chat_id,
                        "timestamp": time,
                        "role": MessageType.GITHUB.value,
                        "content": "Fetching GitHub file content... ",
                        "trace_id": trace_id,
                        "chunk_id": i // batch_size,
                        "action_type": ActionType.GITHUB_GET_FILE.value,
                        "status": ActionStatus.PENDING.value,
                    }
                )

                # Execute batch in parallel
                batch_results = await asyncio.gather(*batch_tasks, return_exceptions=True)

                # Process results and update log entries
                num_failed = 0
                num_success = 0
                for file_key, entries_with_lines, code_response in zip(
                    batch_file_keys, batch_log_entries_list, batch_results
                ):
                    # Handle exceptions gracefully
                    if isinstance(code_response, Exception):
                        num_failed += 1
                        continue

                    # If error message is not None, skip the log entry
                    if code_response["error_message"]:
                        num_failed += 1
                        continue

                    # The first fetch cached the full file content
                    # Now update all log entries for this file
                    owner, repo_name, file_path, ref = file_key

                    # Update all log entries that reference this file
                    # (possibly at different lines)
                    for line_number, line_context_len, log_entry in entries_with_lines:
                        # Get line-specific context from cache
                        # (file is now cached, so this will be fast)
                        line_response = await self.github.get_file_with_context(
                            owner=owner,
                            repo=repo_name,
                            file_path=file_path,
                            ref=ref,
                            line_num=line_number,
                            github_token=github_token,
                            cache=self.cache,
                            line_context_len=line_context_len,
                        )

                        if not line_response["error_message"]:
                            log_entry.line = line_response["line"]
                            # For now disable the context as it may hallucinate
                            # on the case such as count number of error logs
                            if not is_github_pr:
                                log_entry.lines_above = None
                                log_entry.lines_below = None
                            else:
                                log_entry.lines_above = line_response["lines_above"]
                                log_entry.lines_below = line_response["lines_below"]
                    num_success += 1

                time = datetime.now().astimezone(timezone.utc)
                await self.db_client.insert_chat_record(
                    message={
                        "chat_id":
                        chat_id,
                        "timestamp":
                        time,
                        "role":
                        MessageType.GITHUB.value,
                        "content":
                        "Finished fetching GitHub file content for "
                        f"{num_success} times. Failed to "
                        f"fetch {num_failed} times.",
                        "trace_id":
                        trace_id,
                        "chunk_id":
                        i // batch_size,
                        "action_type":
                        ActionType.GITHUB_GET_FILE.value,
                        "status":
                        ActionStatus.SUCCESS.value,
                    }
                )

        chat_history = await self.db_client.get_chat_history(chat_id=chat_id)

        # Build trees for all traces #########################################
        trees: dict[str, SpanNode] = {}
        for tid, trace in selected_traces.items():
            trace_logs = all_logs.get(tid)
            if not trace_logs or not trace.spans:
                continue

            # For LimitExceeded traces, reassign all logs to the placeholder span
            if trace.service_name == "LimitExceeded":
                # Get the placeholder span ID
                placeholder_span_id = trace.spans[0].id

                # Reassign all logs to the placeholder span ID
                reassigned_logs = []
                for log_dict in trace_logs.logs:
                    # Create new dict with all logs under placeholder span ID
                    all_log_entries = []
                    for span_id, log_entries in log_dict.items():
                        all_log_entries.extend(log_entries)

                    if all_log_entries:
                        reassigned_logs.append({placeholder_span_id: all_log_entries})

                # Build tree with reassigned logs
                trees[tid] = build_heterogeneous_tree(trace.spans[0], reassigned_logs)
            else:
                # Normal trace - build tree normally
                trees[tid] = build_heterogeneous_tree(trace.spans[0], trace_logs.logs)

        # If span_ids specified, filter trees to those spans
        if len(span_ids) > 0:
            target_set = set(span_ids)
            for tid, tree in trees.items():
                # Use BFS to find the first span matching any of target span_ids
                queue = deque([tree])
                while queue:
                    current = queue.popleft()
                    # Check if current node matches any target span
                    if current.span_id in target_set:
                        trees[tid] = current
                        break
                    # Add children to queue for next level
                    for child in current.children_spans:
                        queue.append(child)

        # Keep single node for backward compatibility
        node: SpanNode | None = trees.get(trace_id) if trace_id else None

        # Route based on router's decision
        if router_output.agent_type == "code" and (is_github_issue or is_github_pr):
            issue_response: ChatbotResponse | None = None
            pr_response: ChatbotResponse | None = None
            issue_message: str = message
            pr_message: str = message
            if is_github_issue and is_github_pr:
                separate_issue_and_pr_output: SeparateIssueAndPrInput = \
                    await separate_issue_and_pr(
                        user_message=message,
                        client=self.single_rca_agent.chat_client,
                        openai_token=openai_token,
                        model=model,
                        user_sub=user_sub,
                    )
                issue_message = separate_issue_and_pr_output.issue_message
                pr_message = separate_issue_and_pr_output.pr_message
            if is_github_issue:
                issue_response = await self.code_agent.chat(
                    trace_id=trace_id,
                    trace_ids=trace_ids,
                    chat_id=chat_id,
                    user_message=issue_message,
                    model=model,
                    db_client=self.db_client,
                    chat_history=chat_history,
                    timestamp=orig_time,
                    tree=node,
                    trees=trees,
                    user_sub=user_sub,
                    openai_token=openai_token,
                    github_token=github_token,
                    github_file_tasks=github_task_keys,
                    is_github_issue=True,
                    is_github_pr=False,
                    provider=provider,
                )
            if is_github_pr:
                pr_response = await self.code_agent.chat(
                    trace_id=trace_id,
                    trace_ids=trace_ids,
                    chat_id=chat_id,
                    user_message=pr_message,
                    model=model,
                    db_client=self.db_client,
                    chat_history=chat_history,
                    timestamp=orig_time,
                    tree=node,
                    trees=trees,
                    user_sub=user_sub,
                    openai_token=openai_token,
                    github_token=github_token,
                    github_file_tasks=github_task_keys,
                    is_github_issue=False,
                    is_github_pr=True,
                    provider=provider,
                )
            # TODO: sequential tool calls
            if issue_response and pr_response:
                summary_response = await summarize_chatbot_output(
                    issue_response=issue_response,
                    pr_response=pr_response,
                    client=self.single_rca_agent.chat_client,
                    openai_token=openai_token,
                    model=model,
                    user_sub=user_sub,
                )
                return summary_response.model_dump()
            elif issue_response:
                return issue_response.model_dump()
            elif pr_response:
                return pr_response.model_dump()
            else:
                raise ValueError("Should not reach here")
        else:
            # Router decided single_rca - use SingleRCAAgent for root cause analysis
            response: ChatbotResponse = await self.single_rca_agent.chat(
                trace_id=trace_id,
                trace_ids=trace_ids,
                chat_id=chat_id,
                user_message=message,
                model=model,
                db_client=self.db_client,
                chat_history=chat_history,
                timestamp=orig_time,
                tree=node,
                trees=trees,
                user_sub=user_sub,
                openai_token=openai_token,
            )
            return response.model_dump()

    async def _add_limit_exceeded_traces(
        self,
        observe_provider: ObservabilityProvider,
        trace_id_set: set[str],
        filtered_traces: list[Trace],
    ) -> None:
        """Check for AWS X-Ray limit exceeded traces and add them to results.

        Args:
            observe_provider: Observability provider instance
            trace_id_set: Set of expected trace IDs from logs
            filtered_traces: List of filtered traces to append limit exceeded traces to
        """
        if not isinstance(observe_provider.trace_client, AWSTraceClient):
            return

        # Find unfound trace IDs (traces we expected but didn't find)
        found_trace_ids = {trace.id for trace in filtered_traces}
        unfound_trace_ids = trace_id_set - found_trace_ids

        if not unfound_trace_ids:
            return

        try:
            # Use batch_get_traces to check if these traces exist
            unfound_list = list(unfound_trace_ids)
            batch_size = 5  # AWS X-Ray limit
            limit_exceeded_trace_ids = []

            for i in range(0, len(unfound_list), batch_size):
                batch = unfound_list[i:i + batch_size]
                response = await observe_provider.trace_client._batch_get_traces(batch)

                # Check for traces with LimitExceeded flag
                if response.get('Traces'):
                    for trace_data in response['Traces']:
                        if trace_data.get('LimitExceeded'):
                            trace_id = trace_data.get('Id')
                            limit_exceeded_trace_ids.append(trace_id)

            # Add traces with LimitExceeded back to the result
            if limit_exceeded_trace_ids:
                # Create empty Trace objects for LimitExceeded traces
                for trace_id in limit_exceeded_trace_ids:
                    empty_trace = Trace(
                        id=trace_id,
                        start_time=0.0,
                        end_time=0.0,
                        duration=0.0,
                        percentile="",
                        spans=[],
                        service_name="LimitExceeded",
                        service_environment="N/A",
                    )
                    filtered_traces.append(empty_trace)
        except Exception as e:
            self.logger.error(f"Error checking unfound traces in X-Ray: {e}")

    async def _get_traces_by_log_search_paginated(
        self,
        request: Request,
        observe_provider: ObservabilityProvider,
        start_time: datetime,
        end_time: datetime,
        log_group_name: str,
        log_search_values: list[str],
        categories: list[str] | None = None,
        values: list[str] | None = None,
        operations: list[Operation] | None = None,
        pagination_state: dict | None = None,
        page_size: int = 50,
        trace_provider: str = 'aws',
    ) -> tuple[list[Trace],
               dict | None]:
        """Get traces matching log search criteria with pagination support.

        This method implements pagination by:
        1. First request: Query CloudWatch for ALL trace IDs and cache them
        2. Subsequent requests: Use cached trace IDs
        3. Fetch only a batch of traces per request

        Args:
            request: FastAPI request object
            observe_provider: Observability provider instance
            start_time: Start time for log query
            end_time: End time for log query
            log_group_name: Log group name
            log_search_values: List of search terms to look for in logs
            categories: Filter by categories if provided
            values: Filter by values if provided
            operations: Filter by operations if provided
            pagination_state: State from previous request (contains cache_key and offset)
            page_size: Number of traces to return per page

        Returns:
            Tuple of (traces, next_pagination_state)
        """
        if not log_search_values:
            return [], None

        search_term = log_search_values[0]

        try:
            # Generate cache key for this specific log search
            import hashlib
            cache_params = (
                f"{start_time.isoformat()}_{end_time.isoformat()}"
                f"_{log_group_name}_{search_term}"
            )
            cache_key = (
                f"log_search_trace_ids:"
                f"{hashlib.md5(cache_params.encode()).hexdigest()}"
            )

            # Determine offset
            if pagination_state and pagination_state.get('type') == 'log_search':
                offset = pagination_state.get('offset', 0)
                # Try to get cached trace IDs
                cached_trace_ids = await self.cache[CacheType.TRACE].get(cache_key)
                if cached_trace_ids:
                    all_trace_ids = cached_trace_ids
                else:
                    # Cache expired, need to re-query
                    all_trace_ids = \
                        await observe_provider.log_client.get_trace_ids_from_logs(
                            start_time=start_time,
                            end_time=end_time,
                            log_group_name=log_group_name,
                            search_term=search_term
                        )
                    # Re-cache for 10 minutes
                    await self.cache[CacheType.TRACE].set(cache_key, all_trace_ids)
            else:
                # First request
                offset = 0
                # Get all matching trace IDs from CloudWatch logs
                all_trace_ids = await observe_provider.log_client.get_trace_ids_from_logs(
                    start_time=start_time,
                    end_time=end_time,
                    log_group_name=log_group_name,
                    search_term=search_term
                )
                # Cache the trace IDs for 10 minutes
                await self.cache[CacheType.TRACE].set(cache_key, all_trace_ids)

            if not all_trace_ids:
                return [], None

            # Get the batch of trace IDs for this page
            batch_trace_ids = all_trace_ids[offset:offset + page_size]

            if not batch_trace_ids:
                return [], None

            # Fetch traces for this batch
            traces = []
            for trace_id in batch_trace_ids:
                trace = await observe_provider.trace_client.get_trace_by_id(
                    trace_id=trace_id,
                    categories=categories,
                    values=values,
                    operations=operations,
                )
                if trace:
                    traces.append(trace)

            # Sort by start_time descending (newest first)
            traces.sort(key=lambda t: t.start_time, reverse=True)

            # Prepare next pagination state
            next_offset = offset + page_size
            if next_offset < len(all_trace_ids):
                next_state = {
                    'type': 'log_search',
                    'provider': trace_provider,  # Provider type for compatibility
                    'cache_key': cache_key,
                    'offset': next_offset,
                    'search_term': search_term  # Store for pagination continuation
                }
            else:
                next_state = None

            return traces, next_state

        except Exception as e:
            self.logger.error(f"Failed to get traces by log search: {e}")
            return [], None

    async def _filter_traces_by_log_content(
        self,
        request: Request,
        traces: list[Trace],
        start_time: datetime,
        end_time: datetime,
        log_group_name: str,
        log_search_values: list[str],
        log_search_operations: list[Operation]
    ) -> list[Trace]:
        """Filter traces by log content using CloudWatch Insights.

        Args:
            traces: List of traces to filter
            start_time: Start time for log query
            end_time: End time for log query
            log_group_name: Log group name
            log_search_values: List of search terms to look for in logs
            log_search_operations: List of operations (currently only '=' supported)

        Returns:
            Filtered list of traces that contain the searched log content
        """
        if not log_search_values:
            return traces

        search_term = log_search_values[0]

        try:
            # Use CloudWatch Insights to find trace IDs
            # from logs containing search term
            # TODO: change all of this to JSON format
            # Log format: timestamp;level;service;function;
            # org;project;env;trace_id;span_id;details
            # Extract trace_id (field 8, 0-indexed field 7)
            # from semicolon-separated logs

            # Single query to get all matching trace IDs
            observe_provider = await self.get_observe_provider(request)
            matching_trace_ids = \
                await observe_provider.log_client.get_trace_ids_from_logs(
                    start_time=start_time,
                    end_time=end_time,
                    log_group_name=log_group_name,
                    search_term=search_term
                )

            if not matching_trace_ids:
                return []

            # Convert to set for fast O(1) lookup
            trace_id_set = set(matching_trace_ids)

            # Filter traces by matching trace IDs
            filtered_traces = [trace for trace in traces if trace.id in trace_id_set]

            # Check if unfound traces exist in AWS X-Ray (may have hit limit)
            await self._add_limit_exceeded_traces(
                observe_provider,
                trace_id_set,
                filtered_traces
            )

            return filtered_traces

        except Exception as e:
            self.logger.error(f"Failed to filter traces by log content: {e}")
            # Fallback: return all traces if log filtering fails
            return traces
