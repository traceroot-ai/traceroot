"""Pydantic schemas for organization API endpoints."""

from datetime import datetime

from pydantic import BaseModel, Field


class OrganizationCreate(BaseModel):
    """Request schema for creating an organization."""

    name: str = Field(min_length=1, max_length=100)


class OrganizationUpdate(BaseModel):
    """Request schema for updating an organization."""

    name: str = Field(min_length=1, max_length=100)


class OrganizationResponse(BaseModel):
    """Response schema for an organization."""

    id: str
    name: str
    role: str  # User's role in this org
    created_at: datetime
    updated_at: datetime


class ProjectResponse(BaseModel):
    """Response schema for a project."""

    id: str
    org_id: str
    name: str
    retention_days: int | None = None
    created_at: datetime
    updated_at: datetime


class OrganizationWithProjects(OrganizationResponse):
    """Organization with its projects."""

    projects: list[ProjectResponse]


class OrganizationListResponse(BaseModel):
    """Response schema for listing organizations."""

    data: list[OrganizationResponse]


class ProjectCreate(BaseModel):
    """Request schema for creating a project."""

    name: str = Field(min_length=1, max_length=100)


class ProjectUpdate(BaseModel):
    """Request schema for updating a project."""

    name: str | None = Field(None, min_length=1, max_length=100)
    retention_days: int | None = None


class ProjectListResponse(BaseModel):
    """Response schema for listing projects."""

    data: list[ProjectResponse]


class MemberResponse(BaseModel):
    """Response schema for an organization member."""

    id: str
    user_id: str
    email: str | None
    name: str | None
    role: str
    created_at: datetime


class MemberCreate(BaseModel):
    """Request schema for adding a member."""

    email: str
    role: str = Field(pattern="^(ADMIN|MEMBER|VIEWER)$")  # Can't add OWNER directly


class MemberUpdate(BaseModel):
    """Request schema for updating a member's role."""

    role: str = Field(pattern="^(OWNER|ADMIN|MEMBER|VIEWER)$")


class MemberListResponse(BaseModel):
    """Response schema for listing members."""

    data: list[MemberResponse]
