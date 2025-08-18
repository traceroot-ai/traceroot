from datetime import datetime

from pydantic import BaseModel, Field

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
    service_name: str | None = None
    provider: Provider = Provider.OPENAI


class ChatbotResponse(BaseModel):
    time: datetime
    message: str
    reference: list[Reference]
    message_type: MessageType
    chat_id: str
    action_type: ActionType | None = None
    status: ActionStatus | None = None


class ChatHistoryResponse(BaseModel):
    history: list[ChatbotResponse] = Field(default_factory=list)


class GetChatHistoryRequest(BaseModel):
    chat_id: str


class ChatMetadata(BaseModel):
    chat_id: str
    timestamp: datetime
    chat_title: str
    trace_id: str


class ChatMetadataHistory(BaseModel):
    history: list[ChatMetadata] = Field(default_factory=list)


class GetChatMetadataRequest(BaseModel):
    chat_id: str


class GetChatMetadataHistoryRequest(BaseModel):
    trace_id: str
