"""SQLAlchemy models for PostgreSQL database.

Schema follows docs/specs/data-model/postgres.md specification.
"""

from datetime import datetime
from enum import Enum
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, String, UniqueConstraint, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

if TYPE_CHECKING:
    pass


class Base(DeclarativeBase):
    """Base class for all models."""

    pass


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


class UserModel(Base):
    """User account model."""

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    email: Mapped[str | None] = mapped_column(String, unique=True, nullable=True)
    name: Mapped[str | None] = mapped_column(String, nullable=True)
    password: Mapped[str | None] = mapped_column(String, nullable=True)  # hashed
    image: Mapped[str | None] = mapped_column(String, nullable=True)
    admin: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )

    # Relationships
    memberships: Mapped[list["OrganizationMembershipModel"]] = relationship(
        back_populates="user"
    )
    invitations_sent: Mapped[list["MembershipInvitationModel"]] = relationship(
        back_populates="invited_by_user"
    )


class OrganizationModel(Base):
    """Organization (tenant) model."""

    __tablename__ = "organizations"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )

    # Relationships
    projects: Mapped[list["ProjectModel"]] = relationship(back_populates="organization")
    memberships: Mapped[list["OrganizationMembershipModel"]] = relationship(
        back_populates="organization"
    )
    invitations: Mapped[list["MembershipInvitationModel"]] = relationship(
        back_populates="organization"
    )


class OrganizationMembershipModel(Base):
    """Links users to organizations with roles."""

    __tablename__ = "organization_memberships"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    org_id: Mapped[str] = mapped_column(
        String, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    role: Mapped[str] = mapped_column(String, nullable=False)  # Role enum value
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )

    # Relationships
    organization: Mapped["OrganizationModel"] = relationship(back_populates="memberships")
    user: Mapped["UserModel"] = relationship(back_populates="memberships")

    __table_args__ = (
        UniqueConstraint("org_id", "user_id", name="uq_org_user"),
        Index("ix_membership_org_id", "org_id"),
        Index("ix_membership_user_id", "user_id"),
    )


class ProjectModel(Base):
    """Project within an organization."""

    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    org_id: Mapped[str] = mapped_column(
        String, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String, nullable=False)
    retention_days: Mapped[int | None] = mapped_column(default=None, nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)  # Soft delete
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )

    # Relationships
    organization: Mapped["OrganizationModel"] = relationship(back_populates="projects")
    api_keys: Mapped[list["ApiKeyModel"]] = relationship(back_populates="project")

    __table_args__ = (Index("ix_project_org_id", "org_id"),)


class ApiKeyModel(Base):
    """API key for SDK authentication (project-scoped)."""

    __tablename__ = "api_keys"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(
        String, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    key_hash: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    key_prefix: Mapped[str] = mapped_column(String, nullable=False)  # tr_xxxx (first 7 chars)
    name: Mapped[str | None] = mapped_column(String, nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )

    # Relationships
    project: Mapped["ProjectModel"] = relationship(back_populates="api_keys")

    __table_args__ = (Index("ix_api_key_project_id", "project_id"),)


class MembershipInvitationModel(Base):
    """Pending invitation to join an organization."""

    __tablename__ = "membership_invitations"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    email: Mapped[str] = mapped_column(String, nullable=False)
    org_id: Mapped[str] = mapped_column(
        String, ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
    )
    org_role: Mapped[str] = mapped_column(String, nullable=False)  # Role enum value
    invited_by_user_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )

    # Relationships
    organization: Mapped["OrganizationModel"] = relationship(back_populates="invitations")
    invited_by_user: Mapped["UserModel | None"] = relationship(
        back_populates="invitations_sent"
    )

    __table_args__ = (
        UniqueConstraint("email", "org_id", name="uq_invitation_email_org"),
        Index("ix_invitation_org_id", "org_id"),
    )
