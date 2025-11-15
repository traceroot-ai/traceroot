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
from rest.cache import Cache
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
    ConfirmActionRequest,
    ConfirmActionResponse,
    GetChatHistoryRequest,
    GetChatMetadataHistoryRequest,
    GetChatMetadataRequest,
    GetLogByTraceIdRequest,
    GetLogByTraceIdResponse,
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
from rest.utils.pagination import PaginationHelper
from rest.utils.trace_cache import TraceCacheHelper
from rest.utils.trace_query import (
    FilterCategories,
    TraceQueryHelper,
    separate_filter_categories,
)


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
        self.cache_helper = TraceCacheHelper(self.cache)
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

    async def _get_trace_by_id_direct(
        self,
        request: Request,
        trace_id: str,
        filter_cats: FilterCategories,
    ) -> dict[str,
              Any]:
        """Fetch a single trace by ID directly.

        This is an optimized path when user requests a specific trace.

        Args:
            request: FastAPI request object
            trace_id: Trace ID to fetch
            filter_cats: Filter categories to apply

        Returns:
            ListTraceResponse dict

        Raises:
            HTTPException: If trace fetch fails
        """
        try:
            observe_provider = await self.get_observe_provider(request)

            trace = await observe_provider.trace_client.get_trace_by_id(
                trace_id=trace_id,
                categories=filter_cats.remaining_categories,
                values=filter_cats.remaining_values,
                operations=filter_cats.remaining_operations,
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

    async def list_traces(
        self,
        request: Request,
        raw_req: ListTraceRawRequest = Depends(),
    ) -> dict[str,
              Any]:
        r"""Get trace data with optional timestamp filtering or trace ID.

        This function handles three main use cases:
        1. Direct trace ID lookup - returns single trace (optimized path)
        2. Log search filtering - searches logs then fetches matching traces
        3. Normal trace filtering - fetches traces with optional filters

        Args:
            request: FastAPI request object
            raw_req: Raw request data from query parameters

        Returns:
            dict[str, Any]: Dictionary containing list of trace data.
        """
        # 1. Setup - Get user info and parse request
        _, _, user_sub = get_user_credentials(request)
        log_group_name = hash_user_sub(user_sub)
        req_data: ListTraceRequest = raw_req.to_list_trace_request(request)

        # 2. Separate filter categories (service_name, service_environment, log, etc.)
        filter_cats = separate_filter_categories(
            req_data.categories.copy(),
            req_data.values.copy(),
            req_data.operations.copy(),
        )

        # 3. Handle direct trace ID lookup (early return for optimization)
        if req_data.trace_id:
            return await self._get_trace_by_id_direct(
                request,
                req_data.trace_id,
                filter_cats
            )

        # 4. Decode pagination token
        pagination_state = PaginationHelper.decode(req_data.pagination_token)

        # 5. Build cache key and check cache
        cache_key = self.cache_helper.build_cache_key(
            req_data.start_time,
            req_data.end_time,
            req_data.categories,
            req_data.values,
            req_data.operations,
            log_group_name,
            req_data.pagination_token,
        )

        cached_result = await self.cache_helper.get_traces(cache_key)
        if cached_result:
            traces, next_state = cached_result
            next_token = PaginationHelper.encode(next_state)
            return TraceQueryHelper.format_response(traces, next_token)

        # 6. Fetch traces based on filter type
        try:
            observe_provider = await self.get_observe_provider(request)

            # Check if this is log-search pagination or new log search
            is_log_search_pagination = PaginationHelper.is_log_search(pagination_state)

            if filter_cats.has_log_search or is_log_search_pagination:
                # Log search path: Search logs first, then fetch matching traces
                log_search_values = filter_cats.log_search_values

                # For pagination continuation, retrieve search term from state
                if is_log_search_pagination and not log_search_values:
                    log_search_values = [pagination_state.get('search_term', '')]

                trace_provider = request.query_params.get("trace_provider", "aws")

                traces, next_state = await self._get_traces_by_log_search_paginated(
                    request=request,
                    observe_provider=observe_provider,
                    start_time=req_data.start_time,
                    end_time=req_data.end_time,
                    log_group_name=log_group_name,
                    log_search_values=log_search_values,
                    categories=filter_cats.remaining_categories,
                    values=filter_cats.remaining_values,
                    operations=filter_cats.remaining_operations,
                    pagination_state=pagination_state,
                    trace_provider=trace_provider,
                )
            else:
                # Normal path: Fetch traces directly with filters
                traces, next_state = \
                    await observe_provider.trace_client.get_recent_traces(
                        start_time=req_data.start_time,
                        end_time=req_data.end_time,
                        log_group_name=log_group_name,
                        service_name_values=filter_cats.service_name_values,
                        service_name_operations=filter_cats.service_name_operations,
                        service_environment_values=(
                            filter_cats.service_environment_values
                        ),
                        service_environment_operations=(
                            filter_cats.service_environment_operations
                        ),
                        categories=filter_cats.remaining_categories,
                        values=filter_cats.remaining_values,
                        operations=filter_cats.remaining_operations,
                        pagination_state=pagination_state,
                    )

            # 7. Cache results and return
            await self.cache_helper.cache_traces(cache_key, traces, next_state)
            next_token = PaginationHelper.encode(next_state)
            return TraceQueryHelper.format_response(traces, next_token)

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
                reference = [Reference(**ref) for ref in item["reference"]]
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
            log_cache_key = self.cache_helper.build_log_cache_key(
                req_data.trace_id,
                log_start_time,
                log_end_time,
                log_group_name
            )
            cached_logs: TraceLogs | None = await self.cache_helper.get_logs(
                log_cache_key
            )
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
            await self.cache_helper.cache_logs(log_cache_key, logs)
            resp = GetLogByTraceIdResponse(trace_id=req_data.trace_id, logs=logs)
            return resp.model_dump()
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    async def get_chat_metadata_history(
        self,
        request: Request,
        req_data: GetChatMetadataHistoryRequest = Depends(),
    ) -> dict[str,
              Any]:
        # Get user credentials (fake in local mode, real in remote mode)
        _, _, _ = get_user_credentials(request)
        chat_metadata_history: ChatMetadataHistory = await (
            self.db_client.get_chat_metadata_history(trace_id=req_data.trace_id)
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
        span_ids = req_data.span_ids
        start_time = req_data.start_time
        end_time = req_data.end_time
        model = req_data.model
        message = req_data.message
        chat_id = req_data.chat_id
        service_name = req_data.service_name
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

        # Get GitHub token early (needed for confirmation flow)
        github_token = await self.get_github_token(user_email)

        # Check for pending action confirmation BEFORE routing ################
        # Load chat history to check if this is a confirmation response
        if not first_chat:  # Only check if not first chat
            early_chat_history = await self.db_client.get_chat_history(chat_id=chat_id)
            is_confirmation = self._check_user_confirmation_response(
                early_chat_history,
                message
            )
            if is_confirmation:
                # User is responding with yes/no to a pending action
                # Execute the action directly without going through code agent

                # Find the pending action
                pending_action = None
                for msg in reversed(early_chat_history):
                    if msg.get("role") == "user":
                        continue
                    if (
                        msg.get("action_type") == ActionType.PENDING_CONFIRMATION.value
                        and msg.get("status") == ActionStatus.AWAITING_CONFIRMATION.value
                    ):
                        pending_action = msg
                        break

                if not pending_action:
                    # This shouldn't happen, but handle gracefully
                    return {
                        "time": orig_time.timestamp() * 1000,
                        "message": "No pending action found.",
                        "reference": [],
                        "message_type": MessageType.ASSISTANT.value,
                        "chat_id": chat_id,
                    }

                # Determine if user confirmed or rejected
                user_msg_lower = message.lower().strip()
                user_confirmed = user_msg_lower in [
                    "yes",
                    "y",
                    "ok",
                    "okay",
                    "confirm",
                    "proceed",
                    "go ahead",
                    "do it"
                ]

                # Get action metadata
                action_metadata = pending_action.get("pending_action_data", {})
                action_kind = action_metadata.get("action_kind")
                action_data = action_metadata.get("action_data", {})

                # Execute the action if user confirmed
                if user_confirmed:
                    if action_kind == "github_create_issue":
                        issue_number = await self.github.create_issue(
                            title=action_data["title"],
                            body=action_data["body"],
                            owner=action_data["owner"],
                            repo_name=action_data["repo_name"],
                            github_token=github_token,
                        )
                        url = (
                            f"https://github.com/{action_data['owner']}"
                            f"/{action_data['repo_name']}/issues/{issue_number}"
                        )
                        content = f"Issue created: {url}"
                        action_type = ActionType.GITHUB_CREATE_ISSUE.value
                        assistant_message = (
                            f"✓ GitHub issue created successfully!\n\n"
                            f"You can view it here: {url}"
                        )

                    elif action_kind == "github_create_pr":
                        pr_number = await self.github.create_pr_with_file_changes(
                            title=action_data["title"],
                            body=action_data["body"],
                            owner=action_data["owner"],
                            repo_name=action_data["repo_name"],
                            base_branch=action_data["base_branch"],
                            head_branch=action_data["head_branch"],
                            file_path_to_change=action_data["file_path_to_change"],
                            file_content_to_change=action_data["file_content_to_change"],
                            commit_message=action_data["commit_message"],
                            github_token=github_token,
                        )
                        url = (
                            f"https://github.com/{action_data['owner']}"
                            f"/{action_data['repo_name']}/pull/{pr_number}"
                        )
                        content = f"PR created: {url}"
                        action_type = ActionType.GITHUB_CREATE_PR.value
                        assistant_message = (
                            f"✓ Pull request created successfully!\n\n"
                            f"You can view it here: {url}"
                        )
                    else:
                        content = "Unknown action type"
                        action_type = ActionType.AGENT_CHAT.value
                        assistant_message = "Error: Unknown action type"
                else:
                    # User rejected the action
                    if action_kind == "github_create_issue":
                        action_display_name = "GitHub issue"
                    else:
                        action_display_name = "GitHub PR"
                    content = f"{action_display_name} creation cancelled by user."
                    action_type = ActionType.AGENT_CHAT.value
                    assistant_message = f"{action_display_name} creation cancelled."

                # Update the pending action record
                await self.db_client.update_chat_record_status(
                    chat_id=chat_id,
                    timestamp=pending_action["timestamp"],
                    status=ActionStatus.SUCCESS.value
                    if user_confirmed else ActionStatus.CANCELLED.value,
                    content=content,
                    action_type=action_type,
                    user_confirmation=user_confirmed,
                )

                # Insert assistant response
                response_time = datetime.now().astimezone(timezone.utc)
                await self.db_client.insert_chat_record(
                    message={
                        "chat_id": chat_id,
                        "timestamp": response_time,
                        "role": "assistant",
                        "content": assistant_message,
                        "reference": [],
                        "trace_id": trace_id,
                        "chunk_id": 0,
                        "action_type": ActionType.AGENT_CHAT.value,
                        "status": ActionStatus.SUCCESS.value,
                    }
                )

                return {
                    "time": response_time.timestamp() * 1000,
                    "message": assistant_message,
                    "reference": [],
                    "message_type": MessageType.ASSISTANT.value,
                    "chat_id": chat_id,
                }

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
                    "trace_id": trace_id,
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
            has_trace_context=bool(trace_id),
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
                "trace_id": trace_id or "",
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

        # Get the trace #######################################################
        observe_provider = await self.get_observe_provider(
            request,
            trace_provider=req_data.trace_provider,
            log_provider=req_data.log_provider,
            trace_region=req_data.trace_region,
            log_region=req_data.log_region,
        )
        selected_trace: Trace | None = None

        # If we have a trace_id, fetch it directly
        if trace_id:
            selected_trace = await observe_provider.trace_client.get_trace_by_id(
                trace_id=trace_id,
                categories=None,
                values=None,
                operations=None,
            )
        else:
            # Otherwise get recent traces and search
            simple_cache_key = self.cache_helper.build_simple_trace_cache_key(
                start_time,
                end_time,
                service_name,
                log_group_name
            )
            cached_traces: list[Trace] | None = await self.cache_helper.get_simple_traces(
                simple_cache_key
            )
            if cached_traces:
                traces = cached_traces
            else:
                traces: list[Trace
                             ] = await observe_provider.trace_client.get_recent_traces(
                                 start_time=start_time,
                                 end_time=end_time,
                                 log_group_name=log_group_name,
                                 service_name_values=None,
                                 service_name_operations=None,
                                 service_environment_values=None,
                                 service_environment_operations=None,
                                 categories=None,
                                 values=None,
                                 operations=None,
                             )
                # Cache the fetched traces
                await self.cache_helper.cache_simple_traces(simple_cache_key, traces)
            for trace in traces:
                if trace.id == trace_id:
                    selected_trace = trace
                    break
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

        # Get the logs ########################################################
        # Use trace's actual start/end times for optimal log search performance
        # If we have the trace, use its timestamps (converted from Unix to datetime)
        # Otherwise fall back to the request's start/end times
        trace_start_time = None
        trace_end_time = None
        if selected_trace:
            # Check if this is a LimitExceeded trace (start_time = 0)
            if (
                selected_trace.service_name == "LimitExceeded"
                and selected_trace.start_time == 0.0 and selected_trace.end_time == 0.0
            ):
                # For LimitExceeded traces, fetch timestamps from
                # logs using CloudWatch Insights
                try:
                    earliest, latest = \
                        await observe_provider.log_client.get_log_timestamps_by_trace_id(
                            trace_id=trace_id,
                            log_group_name=log_group_name,
                            start_time=start_time,
                            end_time=end_time,
                        )
                    if earliest and latest:
                        trace_start_time = earliest
                        trace_end_time = latest
                        # Update the trace object with the discovered timestamps
                        selected_trace.start_time = earliest.timestamp()
                        selected_trace.end_time = latest.timestamp()
                        selected_trace.duration = latest.timestamp() - earliest.timestamp(
                        )
                        # Update the placeholder span with discovered timestamps
                        if selected_trace.spans and len(selected_trace.spans) > 0:
                            placeholder_span = selected_trace.spans[0]
                            placeholder_span.start_time = earliest.timestamp()
                            placeholder_span.end_time = latest.timestamp()
                            placeholder_span.duration = latest.timestamp(
                            ) - earliest.timestamp()
                except Exception as e:
                    print(
                        f"Failed to get log timestamps for "
                        f"LimitExceeded trace {trace_id}: {e}"
                    )
            else:
                # Normal trace with valid timestamps
                trace_start_time = datetime.fromtimestamp(
                    selected_trace.start_time,
                    tz=timezone.utc
                )
                trace_end_time = datetime.fromtimestamp(
                    selected_trace.end_time,
                    tz=timezone.utc
                )

        log_start_time = trace_start_time if trace_start_time else start_time
        log_end_time = trace_end_time if trace_end_time else end_time

        log_cache_key = self.cache_helper.build_log_cache_key(
            trace_id,
            log_start_time,
            log_end_time,
            log_group_name
        )
        logs: TraceLogs | None = await self.cache_helper.get_logs(log_cache_key)
        if logs is None:
            observe_provider = await self.get_observe_provider(request)
            logs = await observe_provider.log_client.get_logs_by_trace_id(
                trace_id=trace_id,
                start_time=log_start_time,
                end_time=log_end_time,
                log_group_name=log_group_name,
            )
            # Cache the logs for 10 minutes
            await self.cache_helper.cache_logs(log_cache_key, logs)

        # GitHub token already retrieved earlier for confirmation flow

        # Only fetch the source code if it's source code related ##############
        github_tasks: list[tuple[str, str, str, str]] = []
        log_entries_to_update: list = []
        github_task_keys: set[tuple[str, str, str, str]] = set()
        # Track unique files and map them to log entries
        unique_file_tasks: dict = {}  # key -> (task, [log_entries])
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

        # For LimitExceeded traces, reassign all logs to the placeholder span
        if selected_trace.service_name == "LimitExceeded":
            # Get the placeholder span ID
            placeholder_span_id = selected_trace.spans[0].id

            # Reassign all logs to the placeholder span ID
            reassigned_logs = []
            for log_dict in logs.logs:
                # Create new dict with all logs under placeholder span ID
                all_log_entries = []
                for span_id, log_entries in log_dict.items():
                    all_log_entries.extend(log_entries)

                if all_log_entries:
                    reassigned_logs.append({placeholder_span_id: all_log_entries})

            # Build tree with reassigned logs
            node: SpanNode = build_heterogeneous_tree(
                selected_trace.spans[0],
                reassigned_logs
            )
        else:
            # Normal trace - build tree normally
            node: SpanNode = build_heterogeneous_tree(selected_trace.spans[0], logs.logs)

        if len(span_ids) > 0:
            # Use BFS to find the first span matching any of target span_ids
            queue = deque([node])
            target_set = set(span_ids)

            while queue:
                current = queue.popleft()
                # Check if current node matches any target span
                if current.span_id in target_set:
                    node = current
                    break
                # Add children to queue for next level
                for child in current.children_spans:
                    queue.append(child)

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
                    chat_id=chat_id,
                    user_message=issue_message,
                    model=model,
                    db_client=self.db_client,
                    chat_history=chat_history,
                    timestamp=orig_time,
                    tree=node,
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
                    chat_id=chat_id,
                    user_message=pr_message,
                    model=model,
                    db_client=self.db_client,
                    chat_history=chat_history,
                    timestamp=orig_time,
                    tree=node,
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
                chat_id=chat_id,
                user_message=message,
                model=model,
                db_client=self.db_client,
                chat_history=chat_history,
                timestamp=orig_time,
                tree=node,
                user_sub=user_sub,
                openai_token=openai_token,
            )
            return response.model_dump()

    async def confirm_github_action(
        self,
        request: Request,
        req_data: ConfirmActionRequest,
    ) -> dict[str,
              Any]:
        """Confirm or reject a pending action (generic handler).

        Args:
            request: FastAPI request object
            req_data: Confirmation request data

        Returns:
            Confirmation response with result
        """
        user_email, _, user_sub = get_user_credentials(request)

        try:
            # Get the pending action from the database
            chat_history = await self.db_client.get_chat_history(chat_id=req_data.chat_id)

            # Find the pending message by timestamp
            pending_message = None
            for item in chat_history:
                if (
                    item.get("timestamp") and
                    abs(item["timestamp"].timestamp() - req_data.message_timestamp) < 1.0
                    and  # Within 1 second
                    item.get("status") == ActionStatus.AWAITING_CONFIRMATION.value
                ):
                    pending_message = item
                    break

            if not pending_message:
                raise HTTPException(
                    status_code=404,
                    detail="Pending action not found or already processed"
                )

            # Get the pending action metadata
            action_metadata = pending_message.get("pending_action_data")
            if not action_metadata:
                raise HTTPException(
                    status_code=400,
                    detail="No pending action data found"
                )

            # Extract action kind and data from metadata
            action_kind = action_metadata.get("action_kind")
            action_data = action_metadata.get("action_data")

            if not action_kind or not action_data:
                raise HTTPException(
                    status_code=400,
                    detail="Invalid action metadata structure"
                )

            # Execute the action (if confirmed) or prepare cancellation message
            if req_data.confirmed:
                # User confirmed - execute the action based on action_kind
                result_data = await self._execute_confirmed_action(
                    action_kind=action_kind,
                    action_data=action_data,
                    user_email=user_email,
                )
                action_result_message = result_data["message"]
                final_action_type = result_data["action_type"]
            else:
                # User rejected - prepare cancellation message
                action_display_name = self._get_action_display_name(action_kind)
                action_result_message = f"{action_display_name} cancelled by user."
                final_action_type = pending_message.get("action_type")
                result_data = {"message": action_result_message}

            # Update the original pending message with the result
            await self.db_client.update_chat_record_status(
                chat_id=req_data.chat_id,
                timestamp=pending_message["timestamp"],
                status=ActionStatus.SUCCESS.value
                if req_data.confirmed else ActionStatus.CANCELLED.value,
                content=action_result_message,
                action_type=final_action_type,
                user_confirmation=req_data.confirmed,
            )

            # Now call LLM to generate a summary based on the user's decision
            # and action result
            summary_response = await self._generate_confirmation_summary(
                chat_id=req_data.chat_id,
                confirmed=req_data.confirmed,
                action_kind=action_kind,
                action_data=action_data,
                result_message=action_result_message,
                user_email=user_email,
                user_sub=user_sub,
            )

            response = ConfirmActionResponse(
                success=True,
                message=summary_response["summary"],
                data=result_data.get("data"),
            )

            return response.model_dump()

        except HTTPException:
            raise
        except Exception as e:
            self.logger.error(f"Error confirming action: {e}")
            raise HTTPException(
                status_code=500,
                detail=f"Error processing confirmation: {str(e)}"
            )

    async def _execute_confirmed_action(
        self,
        action_kind: str,
        action_data: dict,
        user_email: str,
    ) -> dict[str,
              Any]:
        """Execute a confirmed action based on its kind.

        Args:
            action_kind: The type of action to execute
            action_data: The data needed to execute the action
            user_email: User's email for token retrieval

        Returns:
            Dict with message, action_type, and optional data
        """
        if action_kind == "github_create_issue":
            # Get GitHub token
            github_token = await self.db_client.get_integration_token(
                user_email=user_email,
                token_type="github",
            )
            if not github_token:
                raise HTTPException(
                    status_code=400,
                    detail="GitHub token not found. Please configure it in settings."
                )

            github_client = GitHubClient()
            issue_number = await github_client.create_issue(
                title=action_data["title"],
                body=action_data["body"],
                owner=action_data["owner"],
                repo_name=action_data["repo_name"],
                github_token=github_token,
            )
            url = (
                f"https://github.com/{action_data['owner']}"
                f"{action_data['repo_name']}"
                f"/issues/{issue_number}"
            )
            return {
                "message": f"Issue created: {url}",
                "action_type": ActionType.GITHUB_CREATE_ISSUE.value,
                "data": {
                    "url": url,
                    "issue_number": issue_number
                },
            }

        elif action_kind == "github_create_pr":
            # Get GitHub token
            github_token = await self.db_client.get_integration_token(
                user_email=user_email,
                token_type="github",
            )
            if not github_token:
                raise HTTPException(
                    status_code=400,
                    detail="GitHub token not found. Please configure it in settings."
                )

            github_client = GitHubClient()
            pr_number = await github_client.create_pr_with_file_changes(
                title=action_data["title"],
                body=action_data["body"],
                owner=action_data["owner"],
                repo_name=action_data["repo_name"],
                base_branch=action_data["base_branch"],
                head_branch=action_data["head_branch"],
                file_path_to_change=action_data["file_path_to_change"],
                file_content_to_change=action_data["file_content_to_change"],
                commit_message=action_data["commit_message"],
                github_token=github_token,
            )
            url = (
                f"https://github.com/{action_data['owner']}"
                f"{action_data['repo_name']}"
                f"/pull/{pr_number}"
            )
            return {
                "message": f"PR created: {url}",
                "action_type": ActionType.GITHUB_CREATE_PR.value,
                "data": {
                    "url": url,
                    "pr_number": pr_number
                },
            }

        else:
            # Extensible: Add more action kinds here
            raise HTTPException(
                status_code=400,
                detail=f"Unknown action kind: {action_kind}"
            )

    def _get_action_display_name(self, action_kind: str) -> str:
        """Get a human-readable display name for an action kind.

        Args:
            action_kind: The action kind identifier

        Returns:
            Human-readable action name
        """
        action_names = {
            "github_create_issue": "GitHub issue creation",
            "github_create_pr": "GitHub pull request creation",
            # Add more action kinds here as needed
        }
        return action_names.get(action_kind, "Action")

    async def _generate_confirmation_summary(
        self,
        chat_id: str,
        confirmed: bool,
        action_kind: str,
        action_data: dict,
        result_message: str,
        user_email: str,
        user_sub: str,
    ) -> dict[str,
              str]:
        """Generate LLM summary after user confirms/rejects an action.

        Args:
            chat_id: The chat ID
            confirmed: Whether user confirmed or rejected
            action_kind: The type of action
            action_data: The action data
            result_message: The result message (success or cancellation)
            user_email: User's email
            user_sub: User's sub

        Returns:
            Dict with summary text
        """
        # Get OpenAI token
        openai_token = await self.db_client.get_integration_token(
            user_email=user_email,
            token_type="openai",
        )

        # Use default if no custom token
        from openai import AsyncOpenAI
        if openai_token:
            client = AsyncOpenAI(api_key=openai_token)
        else:
            client = AsyncOpenAI()

        # Build the prompt for the LLM
        decision_text = "confirmed" if confirmed else "rejected"
        action_desc = self._get_action_display_name(action_kind)

        prompt = (
            f"The user was asked to confirm a {action_desc} with the following details:"
            f"{self._format_action_data(action_kind, action_data)}"
            f"The user {decision_text} this action."
            f"Result: {result_message}"
            f"Please provide a brief, friendly summary "
            f"of what happened. Keep it conversational and "
            f"to the point (1-2 sentences)."
        )

        # Call LLM to generate summary
        response = await client.chat.completions.create(
            model=ChatModel.GPT_4_1.value,
            messages=[
                {
                    "role":
                    "system",
                    "content":
                    "You are a helpful assistant that provides brief, friendly summaries."
                },
                {
                    "role": "user",
                    "content": prompt
                }
            ],
            stream=True,
            stream_options={"include_usage": True},
        )

        # Stream the response and save to database
        content_parts = []
        usage_data = None
        timestamp = datetime.now().astimezone(timezone.utc)

        async for chunk in response:
            if chunk.choices and len(chunk.choices) > 0:
                delta = chunk.choices[0].delta
                if delta.content:
                    content_parts.append(delta.content)

            if hasattr(chunk, 'usage') and chunk.usage:
                usage_data = chunk.usage

        summary_content = "".join(content_parts)

        # Save the assistant's summary response to chat history
        await self.db_client.insert_chat_record(
            message={
                "chat_id": chat_id,
                "timestamp": timestamp,
                "role": "assistant",
                "content": summary_content,
                "reference": [],
                "trace_id": None,
                "chunk_id": 0,
                "action_type": ActionType.AGENT_CHAT.value,
                "status": ActionStatus.SUCCESS.value,
            }
        )

        # Track token usage
        if usage_data:
            from rest.agent.token_tracker import track_tokens_for_user
            mock_response = type(
                'MockResponse',
                (),
                {
                    'usage':
                    usage_data,
                    'choices': [
                        type(
                            'Choice',
                            (),
                            {
                                'message':
                                type('Message',
                                     (),
                                     {'content': summary_content})()
                            }
                        )()
                    ]
                }
            )()
            await track_tokens_for_user(
                user_sub=user_sub,
                openai_response=mock_response,
                model=ChatModel.GPT_4_1.value
            )

        return {"summary": summary_content}

    def _format_action_data(self, action_kind: str, action_data: dict) -> str:
        """Format action data for LLM prompt.

        Args:
            action_kind: The type of action
            action_data: The action data

        Returns:
            Formatted string
        """
        if action_kind == "github_create_issue":
            return f"""Repository: {action_data['owner']}/{action_data['repo_name']}
Title: {action_data['title']}
Description: {action_data['body']}"""
        elif action_kind == "github_create_pr":
            return f"""Repository: {action_data['owner']}/{action_data['repo_name']}
Title: {action_data['title']}
Base Branch: {action_data['base_branch']} ← Head Branch: {action_data['head_branch']}
Description: {action_data['body']}"""
        else:
            return str(action_data)

    def _check_user_confirmation_response(
        self,
        chat_history: list[dict] | None,
        user_message: str,
    ) -> bool:
        """Check if user message is a yes/no response to pending confirmation.

        Args:
            chat_history: The chat history
            user_message: The current user message

        Returns:
            True if this is a confirmation response, False otherwise
        """
        if not chat_history:
            return False

        # Check if there's a recent pending confirmation in chat history
        for message in reversed(chat_history):
            # Skip user messages
            if message.get("role") == "user":
                continue

            # Check if this is a pending confirmation
            if (
                message.get("action_type") == ActionType.PENDING_CONFIRMATION.value
                and message.get("status") == ActionStatus.AWAITING_CONFIRMATION.value
            ):
                # Found pending action, check if user message is yes/no
                user_msg_lower = user_message.lower().strip()
                yes_variations = [
                    "yes",
                    "y",
                    "ok",
                    "okay",
                    "confirm",
                    "proceed",
                    "go ahead",
                    "do it"
                ]
                no_variations = [
                    "no",
                    "n",
                    "cancel",
                    "stop",
                    "don't",
                    "dont",
                    "nope",
                    "skip"
                ]
                return user_msg_lower in yes_variations or user_msg_lower in no_variations

            # Continue searching through recent messages
            # (don't break on first non-pending message)

        return False

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

        ORDERING STRATEGY:
        Trace IDs are returned from CloudWatch sorted by LOG timestamp (newest first),
        NOT by span start_time. This is a deliberate trade-off:
        - Pro: Fast and cheap (single CloudWatch query, no X-Ray calls)
        - Con: Log timestamp ≠ span start time (usually close, but can differ)
        - Result: 99% of traces appear in chronological order, occasional outliers

        CRITICAL: The trace ID list from CloudWatch MUST preserve order for pagination
        to work correctly. See aws_log_client.py for implementation details.

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
            if PaginationHelper.is_log_search(pagination_state):
                offset = pagination_state.get('offset', 0)
                # Try to get cached trace IDs
                cached_trace_ids = await self.cache_helper.get_trace_ids(cache_key)
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
                    await self.cache_helper.cache_trace_ids(cache_key, all_trace_ids)
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
                await self.cache_helper.cache_trace_ids(cache_key, all_trace_ids)

            if not all_trace_ids:
                return [], None

            # Get the batch of trace IDs for this page
            batch_trace_ids = all_trace_ids[offset:offset + page_size]

            if not batch_trace_ids:
                return [], None

            # NOTE: When categorical filters are applied, we may need to fetch
            # multiple batches to find matching traces (since traces are filtered
            # one-by-one in get_trace_by_id). Keep fetching until we get results
            # or exhaust all available trace IDs.
            has_categorical_filter = categories is not None and values is not None

            traces = []
            current_offset = offset
            batches_tried = 0

            # Keep fetching batches until we find matches or exhaust all trace IDs
            # No arbitrary limit - bounded naturally by total trace IDs and timeouts
            while True:
                # Get batch for current offset
                current_batch = all_trace_ids[current_offset:current_offset + page_size]
                if not current_batch:
                    print(f"No more trace IDs at offset {current_offset}")
                    break

                batches_tried += 1
                print(
                    f"Batch {batches_tried}: Fetching {len(current_batch)} traces "
                    f"from offset {current_offset}..."
                )

                # Fetch traces for this batch
                batch_traces = []
                for i, trace_id in enumerate(current_batch):
                    print(f"Fetching trace {i+1}/{len(current_batch)}: {trace_id}")
                    trace = await observe_provider.trace_client.get_trace_by_id(
                        trace_id=trace_id,
                        categories=categories,
                        values=values,
                        operations=operations,
                    )
                    if trace:
                        batch_traces.append(trace)
                        print("Trace fetched successfully")
                    else:
                        print("Trace not found or filtered out")

                traces.extend(batch_traces)
                print(
                    f"Batch {batches_tried} yielded {len(batch_traces)} matching traces"
                )

                # If we got results OR no categorical filter OR no more traces,
                # stop and return
                if len(
                    traces
                ) > 0 or not has_categorical_filter or current_offset + page_size > len(
                    all_trace_ids
                ):
                    if batches_tried > 1 and len(traces) > 0:
                        print(
                            f"✓ Found {len(traces)} matching traces after "
                            f"checking {batches_tried} batches"
                        )
                    break

                # No matches yet, try next batch
                print(
                    f"⚠️ Batch {batches_tried}: Categorical filter found 0 matches, "
                    f"trying next batch..."
                )
                current_offset += page_size

            print(
                f"Successfully fetched {len(traces)} traces total "
                f"(tried {batches_tried} batches)"
            )

            # Sort by start_time descending (newest first)
            traces.sort(key=lambda t: t.start_time, reverse=True)

            # Prepare next pagination state
            next_offset = current_offset + page_size
            print(
                f"Calculating next state: next_offset={next_offset}, "
                f"total_traces={len(all_trace_ids)}"
            )
            if next_offset < len(all_trace_ids):
                next_state = PaginationHelper.create_log_search_state(
                    offset=next_offset,
                    search_term=search_term,
                    cache_key=cache_key,
                    provider=trace_provider
                )
            else:
                next_state = None

            return traces, next_state

        except Exception as e:
            self.logger.error(f"Failed to get traces by log search: {e}")
            return [], None
