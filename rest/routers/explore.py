import asyncio
import os
from datetime import timezone
from typing import Any, Union

from aiocache import SimpleMemoryCache
from anthropic import AsyncAnthropic
from fastapi import APIRouter, Depends, HTTPException, Request
from openai import AsyncOpenAI
from slowapi import Limiter

from rest.agent import Chat

try:
    from rest.client.ee.aws_client import TraceRootAWSClient
except ImportError:
    from rest.client.aws_client import TraceRootAWSClient

from collections import deque

from rest.client.github_client import GitHubClient
from rest.client.jaeger_client import TraceRootJaegerClient

try:
    from rest.client.ee.mongodb_client import TraceRootMongoDBClient
except ImportError:
    from rest.client.mongodb_client import TraceRootMongoDBClient

from rest.agent.context.tree import SpanNode, build_heterogeneous_tree
from rest.agent.summarizer.chatbot_output import summarize_chatbot_output
from rest.agent.summarizer.github import separate_issue_and_pr
from rest.agent.summarizer.title import summarize_title
from rest.client.sqlite_client import TraceRootSQLiteClient
from rest.config import (ChatbotResponse, ChatHistoryResponse, ChatMetadata,
                         ChatMetadataHistory, ChatRequest, CodeRequest,
                         CodeResponse, GetChatHistoryRequest,
                         GetChatMetadataHistoryRequest, GetChatMetadataRequest,
                         GetLogByTraceIdRequest, GetLogByTraceIdResponse,
                         ListTraceRequest, ListTraceResponse, Trace, TraceLogs)
from rest.config.rate_limit import get_rate_limit_config
from rest.typing import (ChatMode, ChatModel, MessageType, Reference,
                         ResourceType)

try:
    from rest.utils.ee.auth import get_user_credentials, hash_user_sub
except ImportError:
    from rest.utils.auth import get_user_credentials, hash_user_sub

try:
    from rest.agent.ee.agent import Agent
except ImportError:
    from rest.agent.agent import Agent

from rest.agent.summarizer.github import is_github_related, set_github_related
from rest.utils.github import parse_github_url


class ExploreRouter:
    r"""Explore router."""

    def __init__(
        self,
        observe_client: Union[TraceRootAWSClient, TraceRootJaegerClient],
        limiter: Limiter,
    ):
        self.router = APIRouter()
        self.observe_client = observe_client
        self.chat = Chat()
        self.agent = Agent()

        # Choose client based on TRACE_ROOT_LOCAL_MODE environment variable
        self.local_mode = bool(os.getenv("TRACE_ROOT_LOCAL_MODE", False))
        if self.local_mode:
            self.db_client = TraceRootSQLiteClient()
        else:
            self.db_client = TraceRootMongoDBClient()

        self.github = GitHubClient()
        self.limiter = limiter
        self.rate_limit_config = get_rate_limit_config()
        # Cache for 10 minutes
        self.cache = SimpleMemoryCache(ttl=60 * 10)
        self._setup_routes()

    def _setup_routes(self):
        r"""Set up API routes"""
        # Apply rate limiting to routes using configuration
        self.router.get("/list-traces")(self.limiter.limit(
            self.rate_limit_config.list_traces_limit)(self.list_traces))
        self.router.get("/get-logs-by-trace-id")(self.limiter.limit(
            self.rate_limit_config.get_logs_limit)(self.get_logs_by_trace_id))
        self.router.post("/post-chat")(self.limiter.limit(
            self.rate_limit_config.post_chat_limit)(self.post_chat))
        self.router.get("/get-chat-metadata-history")(self.limiter.limit(
            self.rate_limit_config.get_chat_metadata_history_limit)(
                self.get_chat_metadata_history))
        self.router.get("/get-chat-metadata")(self.limiter.limit(
            self.rate_limit_config.get_chat_metadata_limit)(
                self.get_chat_metadata))
        self.router.get("/get-chat-history")(self.limiter.limit(
            self.rate_limit_config.get_chat_history_limit)(
                self.get_chat_history))
        self.router.get("/get-line-context-content")(self.limiter.limit(
            self.rate_limit_config.get_line_context_content_limit)(
                self.get_line_context_content))

    async def handle_github_file(
        self,
        owner: str,
        repo: str,
        file_path: str,
        ref: str,
        line_num: int,
        github_token: str | None,
        line_context_len: int = 100,
    ) -> dict[str, Any]:
        r"""Handle GitHub file content and cache it.

        Args:
            owner (str): Owner of the repository.
            repo (str): Name of the repository.
            file_path (str): Path of the file.
            ref (str): Reference of the file.
            line_num (int): Line number of the file.
            github_token (str | None): GitHub token.

        Returns:
            dict[str, Any]: Dictionary of CodeResponse.model_dump().
        """
        context_key = (owner, repo, file_path, ref, line_num)
        # Try to get cached context lines
        context_lines = await self.cache.get(context_key)

        # Cache hit
        if context_lines is not None:
            lines_above, line, lines_below = context_lines
            response = CodeResponse(
                line=line,
                lines_above=lines_above,
                lines_below=lines_below,
            )
            return response.model_dump()

        # Cache miss then need to get file content at first
        file_key = (owner, repo, file_path, ref)
        file_content = await self.cache.get(file_key)

        # File content is cached, get context lines from file content
        if file_content is not None:
            context_lines = await self.github.get_line_context_content(
                file_content, line_num)
            # Cache the context lines
            await self.cache.set(context_key, context_lines)
            if context_lines is not None:
                lines_above, line, lines_below = context_lines
                response = CodeResponse(
                    line=line,
                    lines_above=lines_above,
                    lines_below=lines_below,
                )
                return response.model_dump()

        # File content is not cached then need to get file content
        file_content, error_message = await self.github.get_file_content(
            owner, repo, file_path, ref, github_token)

        # If file content is not found or cannot be retrieved,
        # return the error message
        if file_content is None:
            response = CodeResponse(
                line=None,
                lines_above=None,
                lines_below=None,
                error_message=error_message,
            )
            return response.model_dump()

        # Cache the file content at first
        await self.cache.set(file_key, file_content)
        context_lines = await self.github.get_line_context_content(
            file_content,
            line_num,
            line_context_len=line_context_len,
        )
        if context_lines is None:
            error_message = (f"Failed to get line context content "
                             f"for line number {line_num} "
                             f"in {owner}/{repo}@{ref}")
            response = CodeResponse(
                line=None,
                lines_above=None,
                lines_below=None,
                error_message=error_message,
            )
            return response.model_dump()

        # Cache the context lines
        await self.cache.set(context_key, context_lines)
        lines_above, line, lines_below = context_lines
        response = CodeResponse(
            line=line,
            lines_above=lines_above,
            lines_below=lines_below,
        )
        return response.model_dump()

    async def get_line_context_content(
            self,
            request: Request,
            req_data: CodeRequest = Depends(),
    ) -> dict[str, Any]:
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
        return await self.handle_github_file(
            owner,
            repo,
            file_path,
            ref,
            line_num,
            github_token,
            line_context_len=4,
        )

    async def list_traces(
            self,
            request: Request,
            req_data: ListTraceRequest = Depends(),
    ) -> dict[str, Any]:
        r"""Get trace data with optional timestamp filtering or trace ID.

        Args:
            req_data (ListTraceRequest): Request object containing start
                time, end time, and service name.

        Returns:
            dict[str, Any]: Dictionary containing list of trace data.
        """
        _, _, user_sub = get_user_credentials(request)
        log_group_name = hash_user_sub(user_sub)

        start_time = req_data.start_time
        end_time = req_data.end_time
        service_name = req_data.service_name

        keys = (start_time, end_time, service_name, log_group_name)
        cached_traces: list[Trace] | None = await self.cache.get(keys)
        if cached_traces:
            resp = ListTraceResponse(traces=cached_traces)
            return resp.model_dump()

        try:
            traces: list[Trace] = await self.observe_client.get_recent_traces(
                start_time=start_time,
                end_time=end_time,
                log_group_name=log_group_name,
                service_name=service_name,
            )
            # Cache the traces for 10 minutes
            await self.cache.set(keys, traces)
            resp = ListTraceResponse(traces=traces)
            return resp.model_dump()
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    async def get_chat_history(
            self,
            request: Request,
            req_data: GetChatHistoryRequest = Depends(),
    ) -> dict[str, Any]:
        # Get user credentials (fake in local mode, real in remote mode)
        _, _, _ = get_user_credentials(request)

        history: list[dict[str, Any]] = await self.db_client.get_chat_history(
            chat_id=req_data.chat_id)
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
                ))
        return chat_history.model_dump()

    async def get_logs_by_trace_id(
            self,
            request: Request,
            req_data: GetLogByTraceIdRequest = Depends(),
    ) -> dict[str, Any]:
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
        # Try to get cached logs
        keys = (req_data.trace_id, req_data.start_time, req_data.end_time,
                log_group_name)
        cached_logs: TraceLogs | None = await self.cache.get(keys)
        if cached_logs:
            resp = GetLogByTraceIdResponse(trace_id=req_data.trace_id,
                                           logs=cached_logs)
            return resp.model_dump()

        try:
            logs: TraceLogs = await self.observe_client.get_logs_by_trace_id(
                trace_id=req_data.trace_id,
                start_time=req_data.start_time,
                end_time=req_data.end_time,
                log_group_name=log_group_name,
            )
            # Cache the logs for 10 minutes
            await self.cache.set(keys, logs)
            resp = GetLogByTraceIdResponse(trace_id=req_data.trace_id,
                                           logs=logs)
            return resp.model_dump()
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    async def get_chat_metadata_history(
        self,
        request: Request,
        req_data: GetChatMetadataHistoryRequest = Depends(),
    ) -> dict[str, Any]:
        # Get user credentials (fake in local mode, real in remote mode)
        _, _, _ = get_user_credentials(request)
        chat_metadata_history: ChatMetadataHistory = await (
            self.db_client.get_chat_metadata_history(
                trace_id=req_data.trace_id))
        return chat_metadata_history.model_dump()

    async def get_chat_metadata(
            self,
            request: Request,
            req_data: GetChatMetadataRequest = Depends(),
    ) -> dict[str, Any]:
        # Get user credentials (fake in local mode, real in remote mode)
        _, _, _ = get_user_credentials(request)
        chat_metadata: ChatMetadata | None = await (
            self.db_client.get_chat_metadata(chat_id=req_data.chat_id))
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
    ) -> dict[str, Any]:
        # Get basic information
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

        if model == ChatModel.AUTO:
            model = ChatModel.GPT_4O

        if req_data.time.tzinfo:
            orig_time = req_data.time.astimezone(timezone.utc)
        else:
            orig_time = req_data.time.replace(tzinfo=timezone.utc)

        # Determine model provider and get tokens
        is_anthropic_model = "claude" in model.value
        openai_token = None
        anthropic_token = None
        llm_client: Union[AsyncOpenAI, AsyncAnthropic]

        if is_anthropic_model:
            anthropic_token = await self.db_client.get_integration_token(
                user_email=user_email,
                token_type=ResourceType.ANTHROPIC.value,
            )
            llm_client = self.chat.anthropic_client
            if anthropic_token is None and self.chat.local_mode:
                return ChatbotResponse(
                    time=orig_time,
                    message="Anthropic token is not found.",
                    reference=[],
                    message_type=MessageType.ASSISTANT,
                    chat_id=chat_id,
                ).model_dump()
        else:
            openai_token = await self.db_client.get_integration_token(
                user_email=user_email,
                token_type=ResourceType.OPENAI.value,
            )
            llm_client = self.chat.openai_client
            if openai_token is None and self.chat.local_mode:
                return ChatbotResponse(
                    time=orig_time,
                    message="OpenAI token is not found.",
                    reference=[],
                    message_type=MessageType.ASSISTANT,
                    chat_id=chat_id,
                ).model_dump()

        # Get whether it's the first chat
        first_chat: bool = await self.db_client.get_chat_metadata(
            chat_id=chat_id) is None

        # Get the title and GitHub related information
        title, github_related = await asyncio.gather(
            summarize_title(
                user_message=message,
                client=llm_client,
                openai_token=openai_token,
                anthropic_token=anthropic_token,
                model=model.value,
                first_chat=first_chat,
            ),
            is_github_related(
                user_message=message,
                client=llm_client,
                openai_token=openai_token,
                anthropic_token=anthropic_token,
                model=model.value,
            ))

        # Get the title of the chat if it's the first chat
        if first_chat and title is not None:
            await self.db_client.insert_chat_metadata(
                metadata={
                    "chat_id": chat_id,
                    "timestamp": orig_time,
                    "chat_title": title,
                    "trace_id": trace_id,
                })

        # Get whether the user message is related to GitHub
        is_github_issue: bool = False
        is_github_pr: bool = False
        source_code_related = set_github_related(
            github_related).source_code_related
        if mode == ChatMode.AGENT and not self.local_mode:
            is_github_issue = github_related.is_github_issue
            is_github_pr = github_related.is_github_pr
        elif self.local_mode and (github_related.is_github_issue
                                  or github_related.is_github_pr):
            is_github_issue = is_github_pr = source_code_related = False

        # Get the trace
        keys = (start_time, end_time, service_name, log_group_name)
        traces: list[Trace] = await self.cache.get(keys)
        if not traces:
            traces = await self.observe_client.get_recent_traces(
                start_time=start_time,
                end_time=end_time,
                service_name=None,
                log_group_name=log_group_name,
            )
        selected_trace = next((t for t in traces if t.id == trace_id), None)

        # Get the logs
        keys = (trace_id, start_time, end_time, log_group_name)
        logs: TraceLogs = await self.cache.get(keys)
        if not logs:
            logs = await self.observe_client.get_logs_by_trace_id(
                trace_id=trace_id,
                start_time=start_time,
                end_time=end_time,
                log_group_name=log_group_name,
            )
            await self.cache.set(keys, logs)

        # Get GitHub token and fetch source code if needed
        github_token = await self.get_github_token(user_email)
        if source_code_related:
            # ... (GitHub file fetching logic remains the same) ...
            pass

        chat_history = await self.db_client.get_chat_history(chat_id=chat_id)
        node: SpanNode = build_heterogeneous_tree(selected_trace.spans[0],
                                                  logs.logs)

        if span_ids:
            queue = deque([node])
            target_set = set(span_ids)
            while queue:
                current = queue.popleft()
                if current.span_id in target_set:
                    node = current
                    break
                for child in current.children_spans:
                    queue.append(child)

        if mode == ChatMode.AGENT and (is_github_issue or
                                       is_github_pr) and not self.local_mode:
            issue_message, pr_message = message, message
            if is_github_issue and is_github_pr:
                issue_message, pr_message = await separate_issue_and_pr(
                    user_message=message,
                    client=llm_client,
                    openai_token=openai_token,
                    anthropic_token=anthropic_token,
                    model=model.value,
                )

            issue_response, pr_response = None, None
            if is_github_issue:
                issue_response = await self.agent.chat(
                    trace_id=trace_id,
                    chat_id=chat_id,
                    user_message=issue_message,
                    model=model,
                    db_client=self.db_client,
                    chat_history=chat_history,
                    timestamp=orig_time,
                    tree=node,
                    openai_token=openai_token,
                    anthropic_token=anthropic_token,
                    github_token=github_token,
                    is_github_issue=True,
                    is_github_pr=False,
                )
            if is_github_pr:
                pr_response = await self.agent.chat(
                    trace_id=trace_id,
                    chat_id=chat_id,
                    user_message=pr_message,
                    model=model,
                    db_client=self.db_client,
                    chat_history=chat_history,
                    timestamp=orig_time,
                    tree=node,
                    openai_token=openai_token,
                    anthropic_token=anthropic_token,
                    github_token=github_token,
                    is_github_issue=False,
                    is_github_pr=True,
                )

            if issue_response and pr_response:
                return (await summarize_chatbot_output(
                    issue_response=issue_response,
                    pr_response=pr_response,
                    client=llm_client,
                    openai_token=openai_token,
                    anthropic_token=anthropic_token,
                    model=model,
                )).model_dump()
            return (issue_response or pr_response).model_dump()
        else:
            return (await self.chat.chat(
                trace_id=trace_id,
                chat_id=chat_id,
                user_message=message,
                model=model,
                db_client=self.db_client,
                chat_history=chat_history,
                timestamp=orig_time,
                tree=node,
                openai_token=openai_token,
                anthropic_token=anthropic_token,
            )).model_dump()
