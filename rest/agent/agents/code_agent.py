import asyncio
import os
from datetime import datetime, timezone

from openai import AsyncOpenAI

try:
    from rest.dao.ee.mongodb_dao import TraceRootMongoDBClient
except ImportError:
    from rest.dao.mongodb_dao import TraceRootMongoDBClient

import json
from copy import deepcopy
from typing import Any, Tuple

from rest.agent.agents.base import BaseAgent
from rest.agent.context.chat_context import build_chat_history_messages
from rest.agent.context.trace_context import get_trace_context_messages
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
from rest.config import ChatbotResponse
from rest.constants import MAX_PREV_RECORD
from rest.tools.github import GitHubClient
from rest.typing import ActionStatus, ActionType, ChatModel, MessageType, Provider
from rest.utils.token_tracking import track_tokens_for_user


class CodeAgent(BaseAgent):
    """Code Agent for GitHub operations (issues, PRs)."""

    def __init__(self):
        super().__init__()
        api_key = os.getenv("OPENAI_API_KEY")

        if api_key is None:
            # This means that is using the local mode
            # and user needs to provide the token within
            # the integrate section at first
            api_key = "fake_openai_api_key"
        self.chat_client = AsyncOpenAI(api_key=api_key)
        self.system_prompt = AGENT_SYSTEM_PROMPT
        self.name = "CodeAgent"
        self.model = ChatModel.GPT_4O  # Default model for code agent

    async def _generate_summary_without_tools(
        self,
        messages: list[dict[str,
                            str]],
        model: ChatModel,
        client: AsyncOpenAI,
        provider: Provider,
        user_sub: str,
        db_client: TraceRootMongoDBClient,
        chat_id: str,
        trace_id: str,
        timestamp: datetime,
    ) -> ChatbotResponse:
        """Generate LLM summary without function tools (for confirmations).

        Args:
            messages: The conversation messages
            model: The model to use
            client: The OpenAI client
            provider: The provider
            user_sub: User's sub ID
            db_client: Database client
            chat_id: Chat ID
            trace_id: Trace ID
            timestamp: Message timestamp

        Returns:
            ChatbotResponse with the summary
        """
        from rest.agent.token_tracker import track_tokens_for_user

        # Call LLM without function tools
        response = await client.chat.completions.create(
            model=model.value,
            messages=messages,
            stream=True,
            stream_options={"include_usage": True},
        )

        # Stream the response
        content_parts = []
        usage_data = None

        async for chunk in response:
            if chunk.choices and len(chunk.choices) > 0:
                delta = chunk.choices[0].delta
                if delta.content:
                    content_parts.append(delta.content)

            if hasattr(chunk, 'usage') and chunk.usage:
                usage_data = chunk.usage

        summary_content = "".join(content_parts)

        # Save to database
        response_time = datetime.now().astimezone(timezone.utc)
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

        # Track tokens
        if usage_data:
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

        return ChatbotResponse(
            time=response_time.timestamp() * 1000,
            message=summary_content,
            reference=[],
            message_type=MessageType.ASSISTANT,
            chat_id=chat_id,
        )

    def _check_pending_action_confirmation(
        self,
        chat_history: list[dict] | None,
        user_message: str,
    ) -> tuple[dict | None,
               bool | None]:
        """Check if user is responding to a pending action confirmation.

        Args:
            chat_history: The chat history
            user_message: The current user message

        Returns:
            Tuple of (pending_action_record, user_confirmed)
            - pending_action_record: The pending action record if found, None otherwise
            - user_confirmed: True if user said yes, False
            if no, None if not a confirmation
        """
        if not chat_history:
            return None, None

        # Check if there's a recent pending confirmation in chat history
        # Look through the last few messages to find a pending action
        pending_action = None
        for message in reversed(chat_history):
            # Skip user messages
            if message.get("role") == "user":
                continue

            # Check if this is a pending confirmation
            if (
                message.get("action_type") == ActionType.PENDING_CONFIRMATION.value
                and message.get("status") == ActionStatus.AWAITING_CONFIRMATION.value
            ):
                pending_action = message
                break

            # Stop searching if we've gone too far back (more than 2 non-user messages)
            # This prevents matching old pending actions from earlier in the conversation

        if not pending_action:
            return None, None

        # Check if user message is a confirmation (yes/no)
        user_msg_lower = user_message.lower().strip()

        # Detect "yes" variations
        if user_msg_lower in [
            "yes",
            "y",
            "ok",
            "okay",
            "confirm",
            "proceed",
            "go ahead",
            "do it"
        ]:
            return pending_action, True

        # Detect "no" variations
        if user_msg_lower in [
            "no",
            "n",
            "cancel",
            "stop",
            "don't",
            "dont",
            "nope",
            "skip"
        ]:
            return pending_action, False

        return None, None

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

        # Check if this is a confirmation response to a pending action
        pending_action, user_confirmed = self._check_pending_action_confirmation(
            chat_history, user_message
        )

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

        context_chunks = get_trace_context_messages(context)
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

        # Add formatted chat history
        history_messages = build_chat_history_messages(
            chat_history,
            max_records=MAX_PREV_RECORD
        )
        messages.extend(history_messages)
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

        # Note: Confirmation handling is now done in the router (explore.py)
        # This code path should not be reached for confirmations

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

        GitHubClient()
        maybe_return_directly: bool = False

        # Check if LLM wants to create a new action (not a confirmation response)
        if is_github_issue:
            # Use generic PENDING_CONFIRMATION action type
            # Store action-specific metadata in pending_action_data
            action_metadata = {
                "action_kind": "github_create_issue",  # Specific action identifier
                "action_data": response,  # The actual data needed to execute the action
            }
            content = (
                f"**GitHub Issue Ready for Creation**\n\n"
                f"**Repository:** {response['owner']}/{response['repo_name']}\n"
                f"**Title:** {response['title']}\n\n"
                f"**Description:**\n{response['body']}\n\n"
                f"Do you want to create this issue?"
            )
            await db_client.insert_chat_record(
                message={
                    "chat_id": chat_id,
                    "timestamp": datetime.now().astimezone(timezone.utc),
                    "role": "github",
                    "content": content,
                    "reference": [],
                    "trace_id": trace_id,
                    "chunk_id": 0,
                    "action_type": ActionType.PENDING_CONFIRMATION.value,
                    "status": ActionStatus.AWAITING_CONFIRMATION.value,
                    "pending_action_data": action_metadata,
                }
            )
            # Mark streaming as completed
            await db_client.update_reasoning_status(chat_id, 0, "completed")

            # Insert an assistant message prompting the user to confirm
            response_time = datetime.now().astimezone(timezone.utc)
            summary_message = (
                f"I've prepared a GitHub issue for **{response['owner']}"
                f"/{response['repo_name']}**. Please review the details above"
                f"and let me know if you'd like me to create it."
            )

            await db_client.insert_chat_record(
                message={
                    "chat_id": chat_id,
                    "timestamp": response_time,
                    "role": "assistant",
                    "content": summary_message,
                    "reference": [],
                    "trace_id": trace_id,
                    "chunk_id": 0,
                    "action_type": ActionType.AGENT_CHAT.value,
                    "status": ActionStatus.SUCCESS.value,
                }
            )

            # Return the response
            return ChatbotResponse(
                time=response_time.timestamp() * 1000,
                message=summary_message,
                reference=[],
                message_type=MessageType.ASSISTANT,
                chat_id=chat_id,
            )

        elif is_github_pr:
            if "file_path_to_change" in response:
                # Use generic PENDING_CONFIRMATION action type
                action_metadata = {
                    "action_kind": "github_create_pr",
                    "action_data": response,
                }
                content = (
                    f"**GitHub Pull Request Ready for Creation**\n\n"
                    f"**Repository:** {response['owner']}/{response['repo_name']}\n"
                    f"**Title:** {response['title']}\n"
                    f"**Base Branch:** {response['base_branch']}\n\n"
                    f"**Head Branch:** {response['head_branch']}\n\n"
                    f"**Description:**\n{response['body']}\n\n"
                    f"**File to Change:** {response['file_path_to_change']}\n"
                    f"**Commit Message:** {response['commit_message']}\n\n"
                    f"Do you want to create this pull request?"
                )
                await db_client.insert_chat_record(
                    message={
                        "chat_id": chat_id,
                        "timestamp": datetime.now().astimezone(timezone.utc),
                        "role": "github",
                        "content": content,
                        "reference": [],
                        "trace_id": trace_id,
                        "chunk_id": 0,
                        "action_type": ActionType.PENDING_CONFIRMATION.value,
                        "status": ActionStatus.AWAITING_CONFIRMATION.value,
                        "pending_action_data": action_metadata,
                    }
                )
                # Mark streaming as completed
                await db_client.update_reasoning_status(chat_id, 0, "completed")

                # Insert an assistant message prompting the user to confirm
                response_time = datetime.now().astimezone(timezone.utc)
                summary_message = (
                    f"I've prepared a pull request for **"
                    f"{response['owner']}/{response['repo_name']}**."
                    f"Please review the details above"
                    f"and let me know if you'd like me to create it."
                )

                await db_client.insert_chat_record(
                    message={
                        "chat_id": chat_id,
                        "timestamp": response_time,
                        "role": "assistant",
                        "content": summary_message,
                        "reference": [],
                        "trace_id": trace_id,
                        "chunk_id": 0,
                        "action_type": ActionType.AGENT_CHAT.value,
                        "status": ActionStatus.SUCCESS.value,
                    }
                )

                # Return the response
                return ChatbotResponse(
                    time=response_time.timestamp() * 1000,
                    message=summary_message,
                    reference=[],
                    message_type=MessageType.ASSISTANT,
                    chat_id=chat_id,
                )
            else:
                maybe_return_directly = True
        else:
            maybe_return_directly = True

        # If we reach here, it means we didn't create a pending action
        # Return the original response content
        if maybe_return_directly:
            return ChatbotResponse(
                time=datetime.now().astimezone(timezone.utc).timestamp() * 1000,
                message=response.get("content",
                                     ""),
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
