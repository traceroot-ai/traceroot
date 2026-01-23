"""Pydantic domain models for organizations, users, and memberships."""

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field


class Role(str, Enum):
    """User role in organization."""

    OWNER = "OWNER"
    ADMIN = "ADMIN"
    MEMBER = "MEMBER"
    VIEWER = "VIEWER"


# Role hierarchy for permission checks
ROLE_LEVELS = {
    Role.OWNER: 4,
    Role.ADMIN: 3,
    Role.MEMBER: 2,
    Role.VIEWER: 1,
}


def role_level(role: Role) -> int:
    """Get numeric level for role comparison."""
    return ROLE_LEVELS.get(role, 0)


def has_min_role(user_role: Role, required_role: Role) -> bool:
    """Check if user_role meets or exceeds required_role."""
    return role_level(user_role) >= role_level(required_role)


class User(BaseModel):
    """User account."""

    id: str
    email: str | None = None
    name: str | None = None
    image: str | None = None
    admin: bool = False
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class Organization(BaseModel):
    """Organization (tenant)."""

    id: str
    name: str
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class OrganizationMembership(BaseModel):
    """Links users to organizations with roles."""

    id: str
    org_id: str
    user_id: str
    role: Role
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class OrganizationWithRole(Organization):
    """Organization with user's role included."""

    role: Role


class MembershipInvitation(BaseModel):
    """Pending invitation to join an organization."""

    id: str
    email: str
    org_id: str
    org_role: Role
    invited_by_user_id: str | None = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class Member(BaseModel):
    """Organization member with user details."""

    id: str  # membership id
    user_id: str
    email: str | None
    name: str | None
    role: Role
    created_at: datetime
