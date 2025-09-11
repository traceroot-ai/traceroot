import asyncio
import os
from datetime import datetime, timezone

from openai import AsyncOpenAI

try:
    from rest.client.ee.mongodb_client import TraceRootMongoDBClient
except ImportError:
    from rest.client.mongodb_client import TraceRootMongoDBClient

import json
from copy import deepcopy
from typing import Any, Tuple

from rest.agent.chunk.sequential import sequential_chunk
from rest.agent.context.tree import SpanNode
from rest.agent.filter.feature import (
    SpanFeature,
    log_feature_selector,
    span_feature_selector,
)
from rest.agent.filter.structure import (
    LogNodeSelectorOutput,
    filter_log_node,
    log_node_selector,
)
from rest.agent.github_tools import create_issue, create_pr_with_file_changes
from rest.agent.prompts import AGENT_SYSTEM_PROMPT
from rest.agent.typing import ISSUE_TYPE, LogFeature
from rest.agent.utils.openai_tools import get_openai_tool_schema
from rest.client.github_client import GitHubClient
from rest.config import ChatbotResponse
from rest.constants import MAX_PREV_RECORD
from rest.typing import ActionStatus, ActionType, ChatModel, MessageType, Provider
from rest.utils.token_tracking import track_tokens_for_user


class Agent:

    def __init__(self):
        api_key = os.getenv("OPENAI_API_KEY")

        if api_key is None:
            # This means that is using the local mode
            # and user needs to provide the token within
            # the integrate section at first
            api_key = "fake_openai_api_key"
        self.chat_client = AsyncOpenAI(api_key=api_key)
        self.system_prompt = AGENT_SYSTEM_PROMPT

    async def chat(
        self,
        trace_id: str,
        chat_id: str,
        user_message: str,
        model: ChatModel,
        db_client: TraceRootMongoDBClient,
        timestamp: datetime,
        tree: SpanNode,
        user_sub: str,
        chat_history: list[dict] | None = None,
        openai_token: str | None = None,
        github_token: str | None = None,
        github_file_tasks: set[tuple[str,
                                     str,
                                     str,
                                     str]] | None = None,
        is_github_issue: bool = False,
        is_github_pr: bool = False,
        provider: Provider | None = None,
    ) -> ChatbotResponse:
        """
        Args:
            chat_id (str): The ID of the chat.
            user_message (str): The message from the user.
            model (ChatModel): The model to use.
            db_client (TraceRootMongoDBClient):
                The database client.
            timestamp (datetime): The timestamp of the user message.
            tree (dict[str, Any] | None): The tree of the trace.
            chat_history (list[dict] | None): The history of the
                chat where there are keys including chat_id, timestamp, role
                and content.
            openai_token (str | None): The OpenAI token to use.
            github_token (str | None): The GitHub token to use.
            github_file_tasks (set[tuple[str, str, str, str]] | None):
                The tasks to be done on GitHub.
            is_github_issue (bool): Whether the user wants to create an issue.
            is_github_pr (bool): Whether the user wants to create a PR.
            provider (Provider): The provider to use.
        """
        if not (is_github_issue or is_github_pr):
            raise ValueError("Either is_github_issue or is_github_pr must be True.")

        if model == ChatModel.AUTO:
            model = ChatModel.GPT_4O

        # shall we rename this github_file_tasks it is very confusing
        if github_file_tasks is not None:
            github_str = "\n".join(
                [
                    f"({task[0]}, {task[1]}, {task[2]}, {task[3]})"
                    for task in github_file_tasks
                ]
            )
            github_message = (
                f"Here are the github file tasks: {github_str} "
                "where the first element is the owner, the "
                "second element is the repo name, and the "
                "third element is the file path, and the "
                "fourth element is the base branch."
            )

        # Use local client to avoid race conditions in concurrent calls
        client = AsyncOpenAI(api_key=openai_token) if openai_token else self.chat_client

        # Select only necessary log and span features #########################
        (
            log_features,
            span_features,
            log_node_selector_output,
        ) = await self._selector_handler(user_message,
                                         client,
                                         model)

        # TODO: Make this more robust
        try:
            if (
                LogFeature.LOG_LEVEL in log_node_selector_output.log_features
                and len(log_node_selector_output.log_features) == 1
            ):
                tree = filter_log_node(
                    feature_types=log_node_selector_output.log_features,
                    feature_values=log_node_selector_output.log_feature_values,
                    feature_ops=log_node_selector_output.log_feature_ops,
                    node=tree,
                    is_github_pr=is_github_pr,
                )
        except Exception as e:
            print(e)

        if is_github_pr:
            if LogFeature.LOG_SOURCE_CODE_LINE not in log_features:
                log_features.append(LogFeature.LOG_SOURCE_CODE_LINE)
            if LogFeature.LOG_SOURCE_CODE_LINES_ABOVE not in log_features:
                log_features.append(LogFeature.LOG_SOURCE_CODE_LINES_ABOVE)
            if LogFeature.LOG_SOURCE_CODE_LINES_BELOW not in log_features:
                log_features.append(LogFeature.LOG_SOURCE_CODE_LINES_BELOW)

        tree = tree.to_dict(
            log_features=log_features,
            span_features=span_features,
        )

        context = f"{json.dumps(tree, indent=4)}"

        # Compute estimated tokens for context and insert statistics record
        estimated_tokens = len(context) * 4
        await db_client.insert_chat_record(
            message={
                "chat_id": chat_id,
                "timestamp": datetime.now().astimezone(timezone.utc),
                "role": "statistics",
                "content":
                f"Number of estimated tokens for TraceRoot context: {estimated_tokens}",
                "trace_id": trace_id,
                "chunk_id": 0,
                "action_type": ActionType.STATISTICS.value,
                "status": ActionStatus.SUCCESS.value,
            }
        )

        context_chunks = self.get_context_messages(context)
        context_messages = [
            deepcopy(context_chunks[i]) for i in range(len(context_chunks))
        ]
        for i, msg in enumerate(context_chunks):
            if is_github_issue:
                updated_message = self._context_chunk_msg_handler(
                    msg,
                    ISSUE_TYPE.GITHUB_ISSUE
                )
            elif is_github_pr:
                updated_message = self._context_chunk_msg_handler(
                    msg,
                    ISSUE_TYPE.GITHUB_PR
                )
            else:
                updated_message = msg
            context_messages[i] = (
                f"{updated_message}\n\nHere are my questions: "
                f"{user_message}\n\n{github_message}"
            )
        messages = [{"role": "system", "content": self.system_prompt}]
        # Remove github messages from chat history
        chat_history = [
            chat for chat in chat_history
            if chat["role"] != "github" and chat["role"] != "statistics"
        ]
        if chat_history is not None:
            # Only append the last 10 chat history records
            for record in chat_history[-MAX_PREV_RECORD:]:
                # We only need to include the user message
                # (without the context information) in the
                # chat history
                if "user_message" in record:
                    content = record["user_message"]
                else:
                    content = record["content"]
                messages.append({
                    "role": record["role"],
                    "content": content,
                })
        all_messages: list[list[dict[str,
                                     str]]
                           ] = [deepcopy(messages) for _ in range(len(context_messages))]
        for i in range(len(context_messages)):
            all_messages[i].append({"role": "user", "content": context_messages[i]})
            await db_client.insert_chat_record(
                message={
                    "chat_id": chat_id,
                    "timestamp": timestamp,
                    "role": "user",
                    "content": context_messages[i],
                    "trace_id": trace_id,
                    "user_message": user_message,
                    "context": context_chunks[i],
                    "chunk_id": i,
                    "action_type": ActionType.AGENT_CHAT.value,
                    "status": ActionStatus.PENDING.value,
                }
            )

        # Add reasoning messages once before processing chunks
        await self._add_fake_reasoning_message(
            db_client,
            chat_id,
            trace_id,
            0,  # Use chunk_id 0 for shared reasoning messages
            "Analyzing trace data and determining appropriate GitHub actions...\n"
        )

        await self._add_fake_reasoning_message(
            db_client,
            chat_id,
            trace_id,
            0,  # Use chunk_id 0 for shared reasoning messages
            "Specifying corresponding GitHub tools...\n"
        )

        # Support streaming for both single and multiple chunks
        # Each chunk gets its own database record with unique chunk_id
        responses = await asyncio.gather(
            *[
                self.chat_with_context_chunks_streaming(
                    messages,
                    model,
                    client,
                    provider,
                    user_sub,
                    db_client,
                    chat_id,
                    trace_id,
                    i  # chunk_id - each chunk gets unique ID
                ) for i, messages in enumerate(all_messages)
            ]
        )
        response = responses[0]

        # Add tool-specific reasoning message based on response type
        if isinstance(response, dict) and response:
            if "file_path_to_change" in response:
                await self._add_fake_reasoning_message(
                    db_client,
                    chat_id,
                    trace_id,
                    0,  # Use chunk_id 0 for shared reasoning messages
                    (
                        f"Using GitHub PR tool to create pull request for "
                        f"{response.get('repo_name', 'repository')}...\n"
                    )
                )
            elif "title" in response and "body" in response:
                await self._add_fake_reasoning_message(
                    db_client,
                    chat_id,
                    trace_id,
                    0,  # Use chunk_id 0 for shared reasoning messages
                    (
                        f"Using GitHub Issue tool to create issue for "
                        f"{response.get('repo_name', 'repository')}...\n"
                    )
                )

        github_client = GitHubClient()
        maybe_return_directly: bool = False
        if is_github_issue:
            content, action_type = await self._issue_handler(
                response, github_token, github_client
            )
        elif is_github_pr:
            if "file_path_to_change" in response:
                _, content, action_type = await self._pr_handler(
                    response, github_token, github_client
                )
            else:
                maybe_return_directly = True

        if not maybe_return_directly:
            await db_client.insert_chat_record(
                message={
                    "chat_id": chat_id,
                    "timestamp": datetime.now().astimezone(timezone.utc),
                    "role": "github",
                    "content": content,
                    "reference": [],
                    "trace_id": trace_id,
                    "chunk_id": 0,
                    "action_type": action_type,
                    "status": ActionStatus.SUCCESS.value,
                }
            )

        response_time = datetime.now().astimezone(timezone.utc)
        if not maybe_return_directly:
            summary_response = await client.chat.completions.create(
                model=ChatModel.GPT_4_1.value,
                messages=[
                    {
                        "role":
                        "system",
                        "content": (
                            "You are a helpful assistant "
                            "that can summarize the "
                            "created issue or the "
                            "created PR."
                        ),
                    },
                    {
                        "role":
                        "user",
                        "content":
                        (f"Here is the created issue or the created PR:\n{response}"),
                    },
                ],
                stream=True,
                stream_options={"include_usage": True},
            )

            # Handle streaming summary response
            content_parts = []
            usage_data = None

            async for chunk in summary_response:
                if chunk.choices and len(chunk.choices) > 0:
                    delta = chunk.choices[0].delta
                    if delta.content:
                        content_parts.append(delta.content)

                # Capture usage data from the final chunk
                if hasattr(chunk, 'usage') and chunk.usage:
                    usage_data = chunk.usage

            # Mark streaming as completed
            await db_client.update_reasoning_status(chat_id, 0, "completed")

            summary_content = "".join(content_parts)

            # Track token usage for this OpenAI call
            if usage_data:
                # Create a mock response object for token tracking
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
                    model=str(model)
                )
        else:
            summary_content = response["content"]

        await db_client.insert_chat_record(
            message={
                "chat_id": chat_id,
                "timestamp": response_time,
                "role": "assistant",
                "content": summary_content,
                "reference": [],
                "trace_id": trace_id,
                "chunk_id": 0,
                "action_type": ActionType.AGENT_CHAT.value,
                "status": ActionStatus.SUCCESS.value,
            }
        )

        return ChatbotResponse(
            time=response_time,
            message=summary_content,
            reference=[],
            message_type=MessageType.ASSISTANT,
            chat_id=chat_id,
        )

    async def chat_with_context_chunks_streaming(
        self,
        messages: list[dict[str,
                            str]],
        model: ChatModel,
        chat_client: AsyncOpenAI,
        provider: Provider,
        user_sub: str,
        db_client: TraceRootMongoDBClient,
        chat_id: str,
        trace_id: str,
        chunk_id: int,
    ) -> dict[str,
              Any]:
        r"""Chat with context chunks in streaming mode with database updates."""
        # Create initial assistant record
        start_time = datetime.now().astimezone(timezone.utc)
        await db_client.insert_chat_record(
            message={
                "chat_id": chat_id,
                "timestamp": start_time,
                "role": "assistant",
                "content": "",
                "reference": [],
                "trace_id": trace_id,
                "chunk_id": chunk_id,
                "action_type": ActionType.AGENT_CHAT.value,
                "status": ActionStatus.PENDING.value,
                "is_streaming": True,
            }
        )

        return await self._chat_with_context_openai_streaming(
            messages,
            model,
            user_sub,
            chat_client,
            db_client,
            chat_id,
            trace_id,
            chunk_id,
            start_time
        )

    def get_context_messages(self, context: str) -> list[str]:
        r"""Get the context message."""
        # TODO: Make this more efficient.
        context_chunks = list(sequential_chunk(context))
        if len(context_chunks) == 1:
            return [
                (
                    f"\n\nHere is the structure of the tree with related "
                    "information:\n\n"
                    f"{context}"
                )
            ]
        messages: list[str] = []
        for i, chunk in enumerate(context_chunks):
            messages.append(
                f"\n\nHere is the structure of the tree "
                f"with related information of the "
                f"{i + 1}th chunk of the tree:\n\n"
                f"{chunk}"
            )
        return messages

    async def _selector_handler(
        self,
        user_message,
        client,
        model
    ) -> tuple[list[LogFeature],
               list[SpanFeature],
               LogNodeSelectorOutput]:
        return await asyncio.gather(
            log_feature_selector(
                user_message=user_message,
                client=client,
                model=model,
            ),
            span_feature_selector(
                user_message=user_message,
                client=client,
                model=model,
            ),
            log_node_selector(
                user_message=user_message,
                client=client,
                model=model,
            ),
        )

    def _context_chunk_msg_handler(self, message: str, issue_type: ISSUE_TYPE):
        if issue_type == ISSUE_TYPE.GITHUB_ISSUE:
            return f"""
                {message}\nFor now please create an GitHub issue.\n
            """

        if issue_type == ISSUE_TYPE.GITHUB_PR:
            return f"""
                {message}\nFor now please create a GitHub PR.\n
            """

    async def _pr_handler(
        self,
        response: dict[str,
                       Any],
        github_token: str | None,
        github_client: GitHubClient,
    ) -> Tuple[str,
               str,
               str]:
        pr_number = await github_client.create_pr_with_file_changes(
            title=response["title"],
            body=response["body"],
            owner=response["owner"],
            repo_name=response["repo_name"],
            base_branch=response["base_branch"],
            head_branch=response["head_branch"],
            file_path_to_change=response["file_path_to_change"],
            file_content_to_change=response["file_content_to_change"],
            commit_message=response["commit_message"],
            github_token=github_token,
        )
        url = (
            f"https://github.com/{response['owner']}/"
            f"{response['repo_name']}/"
            f"pull/{pr_number}"
        )
        content = f"PR created: {url}"
        action_type = ActionType.GITHUB_CREATE_PR.value

        return url, content, action_type

    async def _issue_handler(
        self,
        response: dict[str,
                       Any],
        github_token: str | None,
        github_client: GitHubClient,
    ) -> Tuple[str,
               str]:
        issue_number = await github_client.create_issue(
            title=response["title"],
            body=response["body"],
            owner=response["owner"],
            repo_name=response["repo_name"],
            github_token=github_token,
        )
        url = (
            f"https://github.com/{response['owner']}/"
            f"{response['repo_name']}/"
            f"issues/{issue_number}"
        )
        content = f"Issue created: {url}"
        action_type = ActionType.GITHUB_CREATE_ISSUE.value
        return content, action_type

    async def _chat_with_context_openai_streaming(
        self,
        messages: list[dict[str,
                            str]],
        model: ChatModel,
        user_sub: str,
        chat_client: AsyncOpenAI,
        db_client: TraceRootMongoDBClient = None,
        chat_id: str = None,
        trace_id: str = None,
        chunk_id: int = None,
        start_time=None,
    ):
        allowed_model = {ChatModel.GPT_5, ChatModel.O4_MINI}

        if model not in allowed_model:
            model = ChatModel.O4_MINI

        response = await chat_client.chat.completions.create(
            model=model,
            messages=messages,
            tools=[
                get_openai_tool_schema(create_issue),
                get_openai_tool_schema(create_pr_with_file_changes),
            ],
            stream=False,
        )

        # Handle streaming response with DB updates
        tool_calls_data = None

        # Process the non-streaming response
        response.usage
        full_content = response.choices[0].message.content or ""
        tool_calls_data = response.choices[0].message.tool_calls

        # Track token usage for this OpenAI call with real usage data
        await track_tokens_for_user(
            user_sub=user_sub,
            openai_response=response,
            model=str(model)
        )

        if tool_calls_data is None or len(tool_calls_data) == 0:
            return {"content": full_content}
        else:
            arguments = tool_calls_data[0].function.arguments
            arguments = json.loads(arguments)
            return arguments

    async def _update_streaming_record(
        self,
        db_client: TraceRootMongoDBClient,
        chat_id: str,
        trace_id: str,
        chunk_id: int,
        content: str,
        start_time,
        status: ActionStatus,
    ):
        """Update the streaming record in the database."""
        # For now, we'll insert a new record with updated content
        # In a real implementation, you'd want to update the existing record
        timestamp = datetime.now().astimezone(timezone.utc)
        await db_client.insert_chat_record(
            message={
                "chat_id": chat_id,
                "timestamp": timestamp,
                "role": "assistant",
                "content": content,
                "reference": [],
                "trace_id": trace_id,
                "chunk_id": chunk_id,
                "action_type": ActionType.AGENT_CHAT.value,
                "status": status.value,
                "is_streaming": True,
                "stream_update": True,
            }
        )

        # Broadcast to SSE clients
        from rest.routers.streaming import get_streaming_router_instance
        streaming_router = get_streaming_router_instance()
        if streaming_router:
            await streaming_router.broadcast_streaming_update(
                chat_id=chat_id,
                chunk_id=chunk_id,
                data={
                    "content": content,
                    "status": status.value,
                    "timestamp": timestamp.isoformat(),
                    "trace_id": trace_id,
                }
            )

    async def _chat_with_context_openai(
        self,
        messages: list[dict[str,
                            str]],
        model: ChatModel,
        user_sub: str,
        chat_client: AsyncOpenAI,
        stream: bool = False,
    ):
        allowed_model = {ChatModel.GPT_5, ChatModel.O4_MINI}

        if model not in allowed_model:
            model = ChatModel.O4_MINI

        response = await chat_client.chat.completions.create(
            model=model,
            messages=messages,
            tools=[
                get_openai_tool_schema(create_issue),
                get_openai_tool_schema(create_pr_with_file_changes),
            ],
            stream=stream,
        )
        if stream:
            # Handle streaming response
            content_parts = []
            tool_calls_data = None

            async for chunk in response:
                if chunk.choices and len(chunk.choices) > 0:
                    delta = chunk.choices[0].delta

                    if delta.content:
                        content_parts.append(delta.content)

                    if delta.tool_calls:
                        if tool_calls_data is None:
                            tool_calls_data = delta.tool_calls
                        else:
                            # Accumulate tool call data
                            for i, tool_call in enumerate(delta.tool_calls):
                                if i < len(tool_calls_data):
                                    tc_data = tool_calls_data[i]
                                    if tool_call.function and tool_call.function.arguments:  # noqa: E501
                                        tc_data.function.arguments += tool_call.function.arguments  # noqa: E501
                                else:
                                    tool_calls_data.append(tool_call)

            # Create a mock response object for token tracking
            class MockResponse:

                def __init__(self, content, tool_calls):
                    self.usage = None  # Streaming doesn't provide usage info
                    self.choices = [
                        type(
                            'Choice',
                            (),
                            {
                                'message':
                                type(
                                    'Message',
                                    (),
                                    {
                                        'content': content,
                                        'tool_calls': tool_calls
                                    }
                                )()
                            }
                        )()
                    ]

            full_content = "".join(content_parts)
            mock_response = MockResponse(full_content, tool_calls_data)

            # Track token usage (note: streaming responses don't include usage info)
            await track_tokens_for_user(
                user_sub=user_sub,
                openai_response=mock_response,
                model=str(model)
            )

            if tool_calls_data is None or len(tool_calls_data) == 0:
                return {"content": full_content}
            else:
                arguments = tool_calls_data[0].function.arguments
                return json.loads(arguments)
        else:
            # Track token usage for this OpenAI call
            await track_tokens_for_user(
                user_sub=user_sub,
                openai_response=response,
                model=str(model)
            )

            tool_calls = response.choices[0].message.tool_calls
            if tool_calls is None or len(tool_calls) == 0:
                return {"content": response.choices[0].message.content}
            else:
                arguments = tool_calls[0].function.arguments
                return json.loads(arguments)

    async def _add_fake_reasoning_message(
        self,
        db_client: TraceRootMongoDBClient,
        chat_id: str,
        trace_id: str,
        chunk_id: int,
        content: str,
    ):
        """Add a fake reasoning message for better UX."""
        from datetime import datetime, timezone

        timestamp = datetime.now(timezone.utc)

        # Store reasoning data in dedicated reasoning collection
        reasoning_data = {
            "chat_id": chat_id,
            "chunk_id": chunk_id,
            "content": content,
            "status": "pending",
            "timestamp": timestamp,
            "trace_id": trace_id,
        }

        await db_client.insert_reasoning_record(reasoning_data)
