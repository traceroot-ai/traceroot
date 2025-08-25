from enum import Enum

from pydantic import BaseModel, Field


class Reference(BaseModel):
    r"""Reference to log, trace (span), source code, etc."""

    number: int = Field(description="The number of the reference.")
    span_id: str | None = Field(
        description=("Original Span ID if it's related to the answer.")
    )
    span_function_name: str | None = Field(
        description=("Function name of the span if it's related to the answer.")
    )
    line_number: int | None = Field(
        description=("Line number of the source code if it's related to the answer.")
    )
    log_message: str | None = Field(
        description=("Log message if it's related to the answer.")
    )

    def __str__(self) -> str:
        return f"[{self.number}]: {self.span_id} {self.line_number}"


class Percentile(str, Enum):
    P50 = "P50"
    P90 = "P90"
    P95 = "P95"
    P99 = "P99"


class MessageType(str, Enum):
    ASSISTANT = "assistant"
    USER = "user"
    GITHUB = "github"


class ChatModel(str, Enum):
    GPT_4O = "gpt-4o"
    GPT_5 = "gpt-5"
    GPT_5_MINI = "gpt-5-mini"
    O4_MINI = "o4-mini"
    O3 = "o3"
    GPT_4_1 = "gpt-4.1"
    GPT_4_1_MINI = "gpt-4.1-mini"
    AUTO = "auto"

    GPT_OSS_120B = "openai/gpt-oss-120b"


class ChatMode(str, Enum):
    AGENT = "agent"
    CHAT = "chat"


class ResourceType(str, Enum):
    """Enumeration of supported resource types for tokens."""

    GITHUB = "github"
    NOTION = "notion"
    SLACK = "slack"
    OPENAI = "openai"
    GROQ = "groq"
    TRACEROOT = "traceroot"


class TokenResource(BaseModel):
    """Pydantic model containing a token and its associated
    resource type."""

    token: str | None = None
    resource_type: ResourceType = Field(alias="resourceType")

    class Config:
        populate_by_name = True


class ActionType(str, Enum):
    GITHUB_GET_FILE = "github_get_file"
    GITHUB_CREATE_ISSUE = "github_create_issue"
    GITHUB_CREATE_PR = "github_create_pr"
    AGENT_CHAT = "agent_chat"


class ActionStatus(str, Enum):
    PENDING = "pending"
    SUCCESS = "success"
    FAILED = "failed"
    CANCELLED = "cancelled"


class Provider(str, Enum):
    OPENAI = "openai"
    CUSTOM = "custom"
    GROQ = "groq"


class Operation(str, Enum):
    EQUAL = "="
    CONTAINS = "contains"


NO_TEMPERATURE_MODEL = {"gpt-5", "gpt-5-mini", "gpt-o4-mini"}
