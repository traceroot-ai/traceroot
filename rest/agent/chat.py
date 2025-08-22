import asyncio
import json
import os
from copy import deepcopy
from datetime import datetime, timezone

from openai import AsyncOpenAI

try:
    from rest.client.ee.mongodb_client import TraceRootMongoDBClient
except ImportError:
    from rest.client.mongodb_client import TraceRootMongoDBClient

from rest.agent.chunk.sequential import sequential_chunk
from rest.agent.context.tree import SpanNode
from rest.agent.filter.feature import log_feature_selector, span_feature_selector
from rest.agent.filter.structure import filter_log_node, log_node_selector
from rest.agent.output.chat_output import ChatOutput
# ✅ Use centralized prompt definitions
from rest.agent.prompts import CHAT_SYSTEM_PROMPT, LOCAL_MODE_APPENDIX
from rest.agent.summarizer.chunk import chunk_summarize
from rest.agent.typing import LogFeature
from rest.client.sqlite_client import TraceRootSQLiteClient
from rest.config import ChatbotResponse
from rest.typing import ActionStatus, ActionType, ChatModel, MessageType
from rest.utils.token_tracking import track_tokens_for_user


class Chat:

    def __init__(self):
        api_key = os.getenv("OPENAI_API_KEY")
        if api_key is None:
            # Local mode (no real key)
            api_key = "fake_openai_api_key"
            self.local_mode = True
        else:
            self.local_mode = False

        self.chat_client = AsyncOpenAI(api_key=api_key)

        # ✅ Load system prompt from prompts module
        self.system_prompt = CHAT_SYSTEM_PROMPT

        # ✅ Append local-only instructions when needed
        if self.local_mode:
            self.system_prompt += LOCAL_MODE_APPENDIX

    async def chat(
        self,
        trace_id: str,
        chat_id: str,
        user_message: str,
        model: ChatModel,
        db_client: TraceRootMongoDBClient | TraceRootSQLiteClient,
        timestamp: datetime,
        tree: SpanNode,
        user_sub: str,
        chat_history: list[dict] | None = None,
        openai_token: str | None = None,
    ) -> ChatbotResponse:
        """Main chat entrypoint for TraceRoot assistant."""
        if model == ChatModel.AUTO:
            model = ChatModel.GPT_4O

        # Use local client to avoid race conditions in concurrent calls
        client = AsyncOpenAI(api_key=openai_token) if openai_token else self.chat_client

        # Select only necessary log and span features #
        (log_features,
         span_features,
         log_node_selector_output) = await asyncio.gather(
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
                )
        except Exception as e:
            print(e)

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
            context_messages[i] = (
                f"{message}\n\nHere are my questions: "
                f"{user_message}"
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
                if "user_message" in record and record["user_message"] is not None:
                    content = record["user_message"]
                else:
                    content = record["content"]
                messages.append({
                    "role": record["role"],
                    "content": content,
                })
        # To handle potential chunking calls, we need to create multiple
        # messages for each context chunk
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

        responses: list[ChatOutput] = await asyncio.gather(
            *[
                self.chat_with_context_chunks(messages,
                                              model,
                                              client,
                                              user_sub) for messages in all_messages
            ]
        )

        response_time = datetime.now().astimezone(timezone.utc)
        if len(responses) == 1:
            response = responses[0]
            response_content = response.answer
            response_references = response.reference
        else:
            # Summarize the response answers and references into a single
            # ChatOutput
            response_answers = [response.answer for response in responses]
            response_references = [response.reference for response in responses]
            response = await chunk_summarize(
                response_answers=response_answers,
                response_references=response_references,
                client=client,
                model=model,
                user_sub=user_sub,
            )
            response_content = response.answer
            response_references = response.reference

        await db_client.insert_chat_record(
            message={
                "chat_id": chat_id,
                "timestamp": response_time,
                "role": "assistant",
                "content": response_content,
                "reference": [ref.model_dump() for ref in response_references],
                "trace_id": trace_id,
                "chunk_id": 0,
                "action_type": ActionType.AGENT_CHAT.value,
                "status": ActionStatus.SUCCESS.value,
            }
        )

        return ChatbotResponse(
            time=response_time,
            message=response_content,
            reference=response.reference,
            message_type=MessageType.ASSISTANT,
            chat_id=chat_id,
        )

    async def chat_with_context_chunks(
        self,
        messages: list[dict[str,
                            str]],
        model: ChatModel,
        chat_client: AsyncOpenAI,
        user_sub: str,
    ) -> ChatOutput:
        r"""Chat with context chunks.
        """
        if model in {
            ChatModel.GPT_5.value,
            ChatModel.GPT_5_MINI.value,
            ChatModel.O4_MINI.value
        }:
            params = {}
        else:
            params = {
                "temperature": 0.8,
            }
        response = await chat_client.responses.parse(
            model=model,
            input=messages,
            text_format=ChatOutput,
            **params,
        )

        # Track token usage for this API call
        await track_tokens_for_user(
            user_sub=user_sub,
            openai_response=response,
            model=str(model)
        )

        if model in {
            ChatModel.GPT_5.value,
            ChatModel.GPT_5_MINI.value,
            ChatModel.O4_MINI.value
        }:
            content = response.output[1].content[0]
        else:
            content = response.output[0].content[0]
        return content.parsed

    def get_context_messages(self, context: str) -> list[str]:
        r"""Get the context message.
        """
        # Make this more efficient.
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
                f"{i+1}th chunk of the tree:\n\n"
                f"{chunk}"
            )
        return messages
