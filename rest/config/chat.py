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
    ReferenceWithTrace,
)


class ChatRequest(BaseModel):
    time: datetime
    message: str
    messageType: MessageType
    trace_id: str
    trace_ids: list[str] = []  # Support multiple traces
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
    reference: list[Reference | ReferenceWithTrace]
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
    trace_id: str  # Keep for backward compatibility
    trace_ids: list[str] = []  # Support multiple traces
    user_id: str | None = None

    @field_serializer('timestamp')
    def serialize_timestamp(self, dt: datetime, _info) -> str:
        """Serialize datetime to ISO string with explicit UTC timezone indicator."""
        if dt.tzinfo is None:
            # If naive datetime, assume UTC
            return dt.isoformat() + 'Z'
        else:
            # Convert to UTC and add Z suffix
            utc_dt = dt.astimezone(timezone.utc)
            return utc_dt.isoformat().replace('+00:00', 'Z')


class ChatMetadataHistory(BaseModel):
    history: list[ChatMetadata] = Field(default_factory=list)


class GetChatMetadataRequest(BaseModel):
    chat_id: str


class GetChatMetadataHistoryRawRequest(BaseModel):
    """Raw request for getting chat metadata history from query parameters."""
    trace_id: str | None = None
    trace_ids: str | None = None  # Will be parsed from multi_items()

    def to_chat_metadata_history_request(
        self,
        request
    ) -> 'GetChatMetadataHistoryRequest':
        """Convert raw request to GetChatMetadataHistoryRequest with proper list parsing.

        Args:
            request: FastAPI request object to parse multi-value parameters

        Returns:
            GetChatMetadataHistoryRequest with properly parsed trace_ids list
        """
        query_params = request.query_params
        trace_ids = []

        for key, value in query_params.multi_items():
            if key == 'trace_ids':
                trace_ids.append(value)

        return GetChatMetadataHistoryRequest(trace_id=self.trace_id, trace_ids=trace_ids)


class GetChatMetadataHistoryRequest(BaseModel):
    trace_id: str | None = None
    trace_ids: list[str] = []


class ConfirmActionRequest(BaseModel):
    """Request to confirm or reject a pending action."""
    chat_id: str
    message_timestamp: float  # Timestamp to identify the specific pending message
    confirmed: bool  # True for yes, False for no


class ConfirmActionResponse(BaseModel):
    """Response after confirming or rejecting an action."""
    success: bool
    message: str
    data: dict | None = None  # Optional data returned after action execution


# Backward compatibility aliases
ConfirmGitHubActionRequest = ConfirmActionRequest
ConfirmGitHubActionResponse = ConfirmActionResponse
