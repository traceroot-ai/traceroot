"""API key schemas for request/response validation."""

from datetime import datetime

from pydantic import BaseModel, Field


class ApiKeyCreate(BaseModel):
    """Request schema for creating an API key."""

    name: str | None = Field(None, max_length=100)
    expires_at: datetime | None = None


class ApiKeyResponse(BaseModel):
    """Response schema for an API key (without secret)."""

    id: str
    project_id: str
    key_prefix: str
    name: str | None
    expires_at: datetime | None
    last_used_at: datetime | None
    created_at: datetime


class ApiKeyCreatedResponse(ApiKeyResponse):
    """Response schema for a newly created API key (includes full key)."""

    key: str  # Full key, only returned once at creation


class ApiKeyListResponse(BaseModel):
    """Response schema for listing API keys."""

    data: list[ApiKeyResponse]
