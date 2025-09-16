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
from rest.agent.prompts import CHAT_SYSTEM_PROMPT, LOCAL_MODE_APPENDIX
from rest.agent.summarizer.chunk import chunk_summarize
from rest.agent.typing import LogFeature
from rest.client.sqlite_client import TraceRootSQLiteClient
from rest.config import ChatbotResponse
from rest.typing import ActionStatus, ActionType, ChatModel, MessageType, Reference
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
        self.system_prompt = CHAT_SYSTEM_PROMPT
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

        # Compute estimated tokens for context and insert statistics record
        estimated_tokens = len(context) * 4
        stats_timestamp = datetime.now().astimezone(timezone.utc)

        await db_client.insert_chat_record(
            message={
                "chat_id": chat_id,
                "timestamp": stats_timestamp,
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
        for i, message in enumerate(context_chunks):
            context_messages[i] = (
                f"{message}\n\nHere are my questions: "
                f"{user_message}"
            )
        messages = [{"role": "system", "content": self.system_prompt}]
        # Remove github and statistics messages from chat history
        chat_history = [
            chat for chat in chat_history
            if chat["role"] != "github" and chat["role"] != "statistics"
        ]
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

        # Support streaming for both single and multiple chunks
        # Each chunk gets its own database record with unique chunk_id
        responses: list[ChatOutput] = await asyncio.gather(
            *[
                self.chat_with_context_chunks_streaming(
                    messages,
                    model,
                    client,
                    user_sub,
                    db_client,
                    chat_id,
                    trace_id,
                    i  # chunk_id - each chunk gets unique ID
                ) for i, messages in enumerate(all_messages)
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
        print("References:", response_references)
        print("Message content:", response_content)
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

    async def chat_with_context_chunks_streaming(
        self,
        messages: list[dict[str,
                            str]],
        model: ChatModel,
        chat_client: AsyncOpenAI,
        user_sub: str,
        db_client: TraceRootMongoDBClient | TraceRootSQLiteClient,
        chat_id: str,
        trace_id: str,
        chunk_id: int,
    ) -> ChatOutput:
        r"""Chat with context chunks in streaming mode with database updates.
        """
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

        return await self._chat_with_context_chunks_streaming_with_db(
            messages,
            model,
            chat_client,
            user_sub,
            db_client,
            chat_id,
            trace_id,
            chunk_id,
            start_time
        )

    async def _chat_with_context_chunks_streaming_with_db(
        self,
        messages: list[dict[str,
                            str]],
        model: ChatModel,
        chat_client: AsyncOpenAI,
        user_sub: str,
        db_client: TraceRootMongoDBClient | TraceRootSQLiteClient,
        chat_id: str,
        trace_id: str,
        chunk_id: int,
        start_time,
    ) -> ChatOutput:
        r"""Chat with context chunks in streaming mode with real-time database updates.
        """
        if model == ChatModel.GPT_5.value:
            model = ChatModel.GPT_4_1.value

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

        response = await chat_client.chat.completions.create(
            model=model,
            messages=messages,
            stream=True,
            stream_options={"include_usage": True},
            response_format={"type": "json_object"},
            **params,
        )

        # Handle streaming response with DB updates
        content_parts = []
        usage_data = None

        async for chunk in response:
            if chunk.choices and len(chunk.choices) > 0:
                delta = chunk.choices[0].delta
                if delta.content:
                    content_parts.append(delta.content)
                    # Store only the individual chunk content (non-cumulative)
                    await self._update_streaming_record(
                        db_client,
                        chat_id,
                        trace_id,
                        chunk_id,
                        delta.content,  # Store individual chunk, not accumulated
                        start_time,
                        ActionStatus.PENDING
                    )

            # Capture usage data from the final chunk
            if hasattr(chunk, 'usage') and chunk.usage:
                usage_data = chunk.usage
        # Ensure final completion status is marked
        await db_client.update_reasoning_status(chat_id, chunk_id, "completed")

        full_content = "".join(content_parts)

        # Track token usage for this API call with real usage data
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
                            {'message': type('Message',
                                             (),
                                             {'content': full_content})()}
                        )()
                    ]
                }
            )()

            await track_tokens_for_user(
                user_sub=user_sub,
                openai_response=mock_response,
                model=str(model)
            )

        # Parse the streamed content into ChatOutput format
        try:
            # Try to parse as JSON first (structured output)
            parsed_data = json.loads(full_content)
            # Parse references into proper Reference objects
            references = []
            if "reference" in parsed_data and isinstance(parsed_data["reference"], list):
                for ref_data in parsed_data["reference"]:
                    if isinstance(ref_data, dict):
                        references.append(Reference(**ref_data))

            return ChatOutput(
                answer=parsed_data.get("answer",
                                       full_content),
                reference=references
            )
        except (json.JSONDecodeError, Exception) as e:
            print(f"JSON parsing failed in streaming mode: {e}")
            # Fallback to treating the entire content as the answer
            return ChatOutput(answer=full_content, reference=[])

    async def _update_streaming_record(
        self,
        db_client: TraceRootMongoDBClient | TraceRootSQLiteClient,
        chat_id: str,
        trace_id: str,
        chunk_id: int,
        content: str,
        start_time,
        status: ActionStatus,
    ):
        """Update the streaming record in the database using dedicated
        reasoning storage.
        """
        timestamp = datetime.now(timezone.utc)

        # Store reasoning data in dedicated reasoning collection
        reasoning_data = {
            "chat_id": chat_id,
            "chunk_id": chunk_id,
            "content": content,
            "status": "pending" if status == ActionStatus.PENDING else "completed",
            "timestamp": timestamp,
            "trace_id": trace_id,
        }

        await db_client.insert_reasoning_record(reasoning_data)

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
