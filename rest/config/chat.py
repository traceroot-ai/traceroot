from datetime import datetime, timezone

from pydantic import BaseModel, Field, field_serializer

from rest.typing import (
    ActionStatus,
    ActionType,
    ChatMode,
    ChatModel,
    MessageType,
    Provider,
    Reference,
)


class ChatRequest(BaseModel):
    time: datetime
    message: str
    messageType: MessageType
    trace_id: str
    span_ids: list[str]
    start_time: datetime
    end_time: datetime
    model: ChatModel
    mode: ChatMode
    chat_id: str
    trace_provider: str
    log_provider: str
    service_name: str | None = None
    trace_region: str | None = None
    log_region: str | None = None
    provider: Provider = Provider.OPENAI


class ChatbotResponse(BaseModel):
    time: datetime
    message: str
    reference: list[Reference]
    message_type: MessageType
    chat_id: str
    action_type: ActionType | None = None
    status: ActionStatus | None = None

    @field_serializer('time')
    def serialize_time(self, dt: datetime, _info) -> str:
        """Serialize datetime to ISO string with explicit UTC timezone indicator."""
        if dt.tzinfo is None:
            # If naive datetime, assume UTC
            return dt.isoformat() + 'Z'
        else:
            # Convert to UTC and add Z suffix
            utc_dt = dt.astimezone(timezone.utc)
            return utc_dt.isoformat().replace('+00:00', 'Z')


class ChatHistoryResponse(BaseModel):
    history: list[ChatbotResponse] = Field(default_factory=list)


class GetChatHistoryRequest(BaseModel):
    chat_id: str


class ChatMetadata(BaseModel):
    chat_id: str
    timestamp: datetime
    chat_title: str
    trace_id: str
    user_id: str | None = None


class ChatMetadataHistory(BaseModel):
    history: list[ChatMetadata] = Field(default_factory=list)


class GetChatMetadataRequest(BaseModel):
    chat_id: str


class GetChatMetadataHistoryRequest(BaseModel):
    trace_id: str
