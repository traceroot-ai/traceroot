import json
import os
from datetime import datetime, timezone

from openai import AsyncOpenAI

try:
    from rest.dao.ee.mongodb_dao import TraceRootMongoDBClient
except ImportError:
    from rest.dao.mongodb_dao import TraceRootMongoDBClient

from rest.agent.agents.base import BaseAgent
from rest.agent.context.chat_context import build_chat_history_messages
from rest.agent.prompts import GENERAL_AGENT_SYSTEM_PROMPT
from rest.config import ChatbotResponse
from rest.dao.sqlite_dao import TraceRootSQLiteClient
from rest.rest_types import ActionStatus, ActionType, ChatModel, MessageType
from rest.utils.token_tracking import track_tokens_for_user


class GeneralAgent(BaseAgent):
    """General purpose agent for answering general questions."""

    def __init__(self):
        super().__init__()
        api_key = os.getenv("OPENAI_API_KEY")
        if api_key is None:
            # Local mode (no real key)
            api_key = "fake_openai_api_key"
            self.local_mode = True
        else:
            self.local_mode = False

        self.chat_client = AsyncOpenAI(api_key=api_key)
        self.system_prompt = GENERAL_AGENT_SYSTEM_PROMPT
        self.name = "GeneralAgent"
        self.model = ChatModel.GPT_4O  # Default model for general agent

    async def chat(
        self,
        chat_id: str,
        user_message: str,
        model: ChatModel,
        db_client: TraceRootMongoDBClient | TraceRootSQLiteClient,
        timestamp: datetime,
        user_sub: str,
        chat_history: list[dict] | None = None,
        openai_token: str | None = None,
        trace_id: str | None = None,
    ) -> ChatbotResponse:
        """
        Main chat entrypoint for general queries.

        Args:
            chat_id: The ID of the chat
            user_message: The message from the user
            model: The model to use
            db_client: The database client
            timestamp: The timestamp of the user message
            user_sub: User subscription ID for token tracking
            chat_history: The history of the chat
            openai_token: Optional OpenAI token override
            trace_id: Optional trace ID (can be None for general queries)

        Returns:
            ChatbotResponse with the agent's answer
        """
        if model == ChatModel.AUTO:
            model = ChatModel.GPT_4O

        # Use local client to avoid race conditions in concurrent calls
        client = AsyncOpenAI(api_key=openai_token) if openai_token else self.chat_client

        # Build messages for the conversation
        messages = [{"role": "system", "content": self.system_prompt}]

        # Add formatted chat history
        history_messages = build_chat_history_messages(chat_history, max_records=10)
        messages.extend(history_messages)

        # Add current user message
        messages.append({"role": "user", "content": user_message})

        # Insert user message record
        await db_client.insert_chat_record(
            message={
                "chat_id": chat_id,
                "timestamp": timestamp,
                "role": "user",
                "content": user_message,
                "trace_id": trace_id or "",
                "user_message": user_message,
                "chunk_id": 0,
                "action_type": ActionType.AGENT_CHAT.value,
                "status": ActionStatus.PENDING.value,
            }
        )

        # Determine parameters based on model
        if model in {
            ChatModel.GPT_5.value,
            ChatModel.GPT_5_MINI.value,
            ChatModel.O4_MINI.value
        }:
            params = {}
        else:
            params = {
                "temperature": 0.7,
            }

        # Call OpenAI API with streaming
        response = await client.chat.completions.create(
            model=model,
            messages=messages,
            stream=True,
            stream_options={"include_usage": True},
            response_format={"type": "json_object"},
            **params,
        )

        # Handle streaming response
        content_parts = []
        usage_data = None

        async for chunk in response:
            if chunk.choices and len(chunk.choices) > 0:
                delta = chunk.choices[0].delta
                if delta.content:
                    content_parts.append(delta.content)

            # Capture usage data from the final chunk
            if hasattr(chunk, 'usage') and chunk.usage:
                usage_data = chunk.usage

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

        # Parse the response
        try:
            parsed_data = json.loads(full_content)
            response_content = parsed_data.get("answer", full_content)
        except (json.JSONDecodeError, Exception) as e:
            print(f"JSON parsing failed for general agent: {e}")
            response_content = full_content

        response_time = datetime.now().astimezone(timezone.utc)

        # Insert assistant message record
        await db_client.insert_chat_record(
            message={
                "chat_id": chat_id,
                "timestamp": response_time,
                "role": "assistant",
                "content": response_content,
                "reference": [],
                "trace_id": trace_id or "",
                "chunk_id": 0,
                "action_type": ActionType.AGENT_CHAT.value,
                "status": ActionStatus.SUCCESS.value,
            }
        )

        return ChatbotResponse(
            time=response_time,
            message=response_content,
            reference=[],
            message_type=MessageType.ASSISTANT,
            chat_id=chat_id,
        )
