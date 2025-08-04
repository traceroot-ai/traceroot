import asyncio
import os
from datetime import datetime, timezone

import httpx
from anthropic import AsyncAnthropic
from openai import AsyncOpenAI

try:
    from rest.client.ee.mongodb_client import TraceRootMongoDBClient
except ImportError:
    from rest.client.mongodb_client import TraceRootMongoDBClient

import json
from copy import deepcopy

from rest.agent.chunk.sequential import sequential_chunk
from rest.agent.context.tree import SpanNode
from rest.agent.filter.feature import (log_feature_selector,
                                       span_feature_selector)
from rest.agent.filter.structure import filter_log_node, log_node_selector
from rest.agent.output.chat_output import ChatOutput
from rest.agent.summarizer.chunk import chunk_summarize
from rest.agent.typing import LogFeature
from rest.client.sqlite_client import TraceRootSQLiteClient
from rest.config import ChatbotResponse
from rest.typing import ActionStatus, ActionType, ChatModel, MessageType


class Chat:

    def __init__(self):
        openai_api_key = os.getenv("OPENAI_API_KEY")
        anthropic_api_key = os.getenv("ANTHROPIC_API_KEY")

        if openai_api_key is None and anthropic_api_key is None:
            # This means that is using the local mode
            # and user needs to provide the token within
            # the integrate section at first
            openai_api_key = "fake_openai_api_key"
            anthropic_api_key = "fake_anthropic_api_key"
            self.local_mode = True
        else:
            self.local_mode = False
        self.openai_client = AsyncOpenAI(api_key=openai_api_key)
        # Explicitly create an httpx client to avoid the internal proxy issue.
        http_client = httpx.AsyncClient()
        self.anthropic_client = AsyncAnthropic(
            api_key=anthropic_api_key,
            http_client=http_client,
        )
        self.system_prompt = (
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
            "in the reference list.")
        # ;) :) :D :P :] :[ :| :/ :]
        if self.local_mode:
            self.system_prompt += (
                "8. If user wants to create a GitHub PR or issue, say that "
                "you cannot do that and suggest them to use "
                "https://traceroot.ai production service instead.")

    async def chat(
        self,
        trace_id: str,
        chat_id: str,
        user_message: str,
        model: ChatModel,
        db_client: TraceRootMongoDBClient | TraceRootSQLiteClient,
        timestamp: datetime,
        tree: SpanNode,
        chat_history: list[dict] | None = None,
        openai_token: str | None = None,
        anthropic_token: str | None = None,
    ) -> ChatbotResponse:
        """
        Args:
            chat_id (str): The ID of the chat.
            user_message (str): The message from the user.
            model (ChatModel): The model to use.
            db_client (TraceRootMongoDBClient | TraceRootSQLiteClient):
                The database client.
            timestamp (datetime): The timestamp of the user message.
            tree (dict[str, Any] | None): The tree of the trace.
            chat_history (list[dict] | None): The history of the
                chat where there are keys including chat_id, timestamp, role
                and content.
            openai_token (str | None): The OpenAI token to use.
        """
        if model == ChatModel.AUTO:
            model = ChatModel.GPT_4O

        # Determine if the model is from Anthropic or OpenAI
        is_anthropic_model = "claude" in model.value

        # Initialize clients, using user-provided tokens if available
        openai_client = self.openai_client
        if openai_token is not None:
            openai_client = AsyncOpenAI(api_key=openai_token)
        anthropic_client = self.anthropic_client
        if anthropic_token is not None:
            http_client = httpx.AsyncClient()
            anthropic_client = AsyncAnthropic(
                api_key=anthropic_token,
                http_client=http_client,
            )
        else:
            client = self.chat_client

        # Select only necessary log and span features #########################
        (log_features, span_features,
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
            if (LogFeature.LOG_LEVEL in log_node_selector_output.log_features
                    and len(log_node_selector_output.log_features) == 1):
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
            context_messages[i] = (f"{message}\n\nHere are my questions: "
                                   f"{user_message}")
        messages = [{"role": "system", "content": self.system_prompt}]
        # Remove github messages from chat history
        chat_history = [
            chat for chat in chat_history if chat["role"] != "github"
        ]
        if chat_history is not None:
            # Only append the last 10 chat history records
            for record in chat_history[-10:]:
                # We only need to include the user message
                # (without the context information) in the
                # chat history
                if "user_message" in record and record[
                        "user_message"] is not None:
                    content = record["user_message"]
                else:
                    content = record["content"]
                messages.append({
                    "role": record["role"],
                    "content": content,
                })
        # To handle potential chunking calls, we need to create multiple
        # messages for each context chunk
        all_messages: list[list[dict[str, str]]] = [
            deepcopy(messages) for _ in range(len(context_messages))
        ]
        for i in range(len(context_messages)):
            all_messages[i].append({
                "role": "user",
                "content": context_messages[i]
            })
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
                })

        if is_anthropic_model:
            chat_coros = [
                self.chat_with_context_chunks_anthropic(
                    messages, model, anthropic_client, self.system_prompt)
                for messages in all_messages
            ]
        else:
            for msg_list in all_messages:
                msg_list.insert(0, {
                    "role": "system",
                    "content": self.system_prompt
                })
            chat_coros = [
                self.chat_with_context_chunks_openai(messages, model,
                                                     openai_client)
                for messages in all_messages
            ]

        responses: list[ChatOutput] = await asyncio.gather(*chat_coros)

        response_time = datetime.now().astimezone(timezone.utc)
        if len(responses) == 1:
            response = responses[0]
            response_content = response.answer
            response_references = response.reference
        else:
            # Summarize the response answers and references into a single
            # ChatOutput
            response_answers = [response.answer for response in responses]
            response_references = [
                response.reference for response in responses
            ]
            response = await chunk_summarize(
                response_answers=response_answers,
                response_references=response_references,
                client=openai_client,
                model=ChatModel.GPT_4O,
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
            })

        return ChatbotResponse(
            time=response_time,
            message=response_content,
            reference=response.reference,
            message_type=MessageType.ASSISTANT,
            chat_id=chat_id,
        )

    async def chat_with_context_chunks_openai(
        self,
        messages: list[dict[str, str]],
        model: ChatModel,
        chat_client: AsyncOpenAI,
    ) -> ChatOutput:
        r"""Chat with context chunks using an OpenAI model."""
        # NOTE: `chat_client.responses.parse` seems to be a custom wrapper or
        # part of a library like `instructor` for structured output.
        response = await chat_client.responses.parse(
            model=model.value,
            input=messages,
            text_format=ChatOutput,
            temperature=0.8,
        )
        return response.output[0].content[0].parsed

    async def chat_with_context_chunks_anthropic(
        self,
        messages: list[dict[str, str]],
        model: ChatModel,
        chat_client: AsyncAnthropic,
        system_prompt: str,
    ) -> ChatOutput:
        r"""Chat with context chunks using an Anthropic model."""
        try:
            # Use Anthropic's tool-use feature for structured output
            response = await chat_client.messages.create(
                model=model.value,
                system=system_prompt,
                messages=messages,
                max_tokens=4096,
                temperature=0.8,
                tools=[{
                    "name": "provide_answer",
                    "description": "Answer with references.",
                    "input_schema": ChatOutput.model_json_schema(),
                }],
                tool_choice={
                    "type": "tool",
                    "name": "provide_answer"
                },
            )

            tool_call = next(
                (block
                 for block in response.content if block.type == "tool_use"),
                None)
            if tool_call and tool_call.name == "provide_answer":
                return ChatOutput(**tool_call.input)
            else:
                # Fallback if the model fails to use the tool
                text_content = "".join(block.text for block in response.content
                                       if block.type == "text")
                return ChatOutput(
                    answer=f"Unstructured model response: {text_content}",
                    reference=[])
        except Exception as e:
            print(f"Error calling Anthropic API: {e}")
            return ChatOutput(
                answer=f"An error occurred with the Anthropic API: {str(e)}",
                reference=[])

    def get_context_messages(self, context: str) -> list[str]:
        r"""Get the context message.
        """
        # Make this more efficient.
        context_chunks = list(sequential_chunk(context))
        if len(context_chunks) == 1:
            return [(f"\n\nHere is the structure of the tree with related "
                     "information:\n\n"
                     f"{context}")]
        messages: list[str] = []
        for i, chunk in enumerate(context_chunks):
            messages.append(f"\n\nHere is the structure of the tree "
                            f"with related information of the "
                            f"{i+1}th chunk of the tree:\n\n"
                            f"{chunk}")
        return messages
