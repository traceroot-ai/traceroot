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
from typing import Any

from groq import AsyncGroq

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
from rest.agent.typing import LogFeature
from rest.agent.utils.openai_tools import get_openai_tool_schema
from rest.client.github_client import GitHubClient
from rest.config import ChatbotResponse
from rest.typing import ActionStatus, ActionType, ChatModel, MessageType, Provider
from rest.utils.token_tracking import track_tokens_for_user

AGENT_SYSTEM_PROMPT = (
    "You are a helpful TraceRoot.AI assistant that is the best "
    "assistant for debugging with logs, traces, metrics and source "
    "code. You will be provided with a tree of spans where each span "
    "has span related information and maybe logs (and maybe the "
    "source code and context for the logs) logged within the span.\n"
    "Please answer user's question based on the given data. Keep your "
    "answer concise and to the point. You also need to follow "
    "following rules:\n"
    "1. Please remember you are a TraceRoot AI agent. You are not "
    "allowed to hallucinate or make up information. "
    "2. If you are very unsure about the answer, you should answer "
    "that you don't know.\n"
    "3. Please provide insightful answer other than just simply "
    "returning the information directly.\n"
    "4. Be more like a real and very helpful person.\n"
    "5. If there is any reference to the answer, ALWAYS directly "
    "write the reference such as [1], [2], [3] etc. at the end of "
    "the line of the corresponding answer to indicate the reference.\n"
    "6. If there is any reference, please make sure at least and at "
    "most either of log, trace (span) and source code is provided. "
    "in the reference.\n"
    "7. Please include all reference for each answer. If each answer "
    "has a reference, please MAKE SURE you also include the reference "
    "in the reference list.\n"
    "8. You are equipped with two functions to either create an "
    "issue or a PR. You can use the function to create an issue or "
    "a PR if the user asks you to do so.\n"
    "9. If creating a PR, please infer the issue or PR information "
    "from the github related tuples.\n"
    "10. If creating a PR, please try your best to create "
    "file changes in the PR. Please copy the original code, "
    "lines Keep the original code as much as possible before "
    "making changes. PLEASE DON'T DELETE TOO MUCH CODE DIRECTLY.\n"
    "11. If creating a PR, please create a short head branch name for "
    "the PR. Please make sure the head branch name is concise and to "
    "the point."
)


class Agent:

    def __init__(self):
        api_key = os.getenv("OPENAI_API_KEY")
        if api_key is None:
            # This means that is using the local mode
            # and user needs to provide the token within
            # the integrate section at first
            api_key = "fake_openai_api_key"
            self.local_mode = True
        else:
            self.local_mode = False
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
        groq_token: str | None = None,
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
            groq_token (str | None): The Groq API key to use.
        """
        if not is_github_issue and not is_github_pr:
            raise ValueError("Either is_github_issue or is_github_pr must be True.")
        if model == ChatModel.AUTO:
            model = ChatModel.GPT_4O

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
        if openai_token is not None:
            client = AsyncOpenAI(api_key=openai_token)
        else:
            client = self.chat_client

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

        context_chunks = self.get_context_messages(context)
        context_messages = [
            deepcopy(context_chunks[i]) for i in range(len(context_chunks))
        ]
        for i, message in enumerate(context_chunks):
            if is_github_issue:
                updated_message = f"""
                    {message}\nFor now please create an GitHub issue.\n
                """
            elif is_github_pr:
                updated_message = f"""
                    {message}\nFor now please create a GitHub PR.\n
                """
            else:
                updated_message = message
            context_messages[i] = (
                f"{updated_message}\n\nHere are my questions: "
                f"{user_message}\n\n{github_message}"
            )
        messages = [{"role": "system", "content": self.system_prompt}]
        # Remove github messages from chat history
        chat_history = [chat for chat in chat_history if chat["role"] != "github"]
        if chat_history is not None:
            # Only append the last 10 chat history records
            for record in chat_history[-10:]:
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

        # TODO: support multiple chunks
        responses = await asyncio.gather(
            *[
                self.chat_with_context_chunks(
                    messages,
                    model,
                    client,
                    provider,
                    user_sub,
                    groq_token
                ) for messages in all_messages
            ]
        )
        response = responses[0]
        github_client = GitHubClient()
        maybe_return_directly: bool = False
        if is_github_issue:
            issue_number = github_client.create_issue(
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
        elif is_github_pr:
            if "file_path_to_change" in response:
                pr_number = github_client.create_pr_with_file_changes(
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
                model=model,
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
                        ("Here is the created issueor "
                         f"the created PR:{response}"),
                    },
                ],
            )

            # Track token usage for this OpenAI call
            await track_tokens_for_user(
                user_sub=user_sub,
                openai_response=summary_response,
                model=str(model)
            )

            summary_content = summary_response.choices[0].message.content
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

    async def chat_with_context_chunks(
        self,
        messages: list[dict[str,
                            str]],
        model: ChatModel,
        chat_client: AsyncOpenAI,
        provider: Provider,
        user_sub: str,
        groq_token: str | None = None,
    ) -> dict[str,
              Any]:
        r"""Chat with context chunks."""
        if provider == Provider.GROQ:
            model = ChatModel.GPT_OSS_120B
            client = AsyncGroq(api_key=groq_token)
            response = await client.chat.completions.create(
                model=model,
                messages=messages,
                tools=[
                    get_openai_tool_schema(create_issue),
                    get_openai_tool_schema(create_pr_with_file_changes),
                ],
            )
            # Track token usage for Groq call
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
        else:
            # Force using o4-mini for if not using gpt-5
            if model != ChatModel.GPT_5:
                model = ChatModel.O4_MINI
            response = await chat_client.chat.completions.create(
                model=model,
                messages=messages,
                tools=[
                    get_openai_tool_schema(create_issue),
                    get_openai_tool_schema(create_pr_with_file_changes),
                ],
            )
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
