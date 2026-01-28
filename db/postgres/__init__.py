"""PostgreSQL database module."""

from db.postgres.engine import close_db, get_session, init_db
from db.postgres.membership import (
    add_member,
    count_owners,
    get_membership,
    get_user_role,
    list_members_by_org,
    list_memberships_by_user,
    remove_member,
    update_member_role,
)
from db.postgres.models import (
    ApiKeyModel,
    Base,
    MembershipInvitationModel,
    OrganizationMembershipModel,
    OrganizationModel,
    ProjectModel,
    UserModel,
)
from db.postgres.organization import (
    create_organization,
    delete_organization,
    get_organization_by_id,
    get_organization_with_projects,
    list_organizations_by_user,
    update_organization,
)
from db.postgres.project import (
    Project,
    check_project_name_exists,
    create_project,
    get_active_project_by_id,
    has_active_projects,
    list_projects_by_org,
    soft_delete_project,
    update_project,
)
from db.postgres.user import (
    create_user,
    get_user_by_email,
    get_user_by_id,
    update_user,
    upsert_user,
)
from db.postgres.api_key import (
    ApiKey,
    ApiKeyWithSecret,
    create_api_key,
    delete_api_key,
    get_api_key_by_hash,
    get_api_key_by_id,
    list_api_keys_by_project,
    update_api_key_last_used,
)

__all__ = [
    # Engine
    "get_session",
    "init_db",
    "close_db",
    # Models
    "Base",
    "UserModel",
    "OrganizationModel",
    "OrganizationMembershipModel",
    "ProjectModel",
    "ApiKeyModel",
    "MembershipInvitationModel",
    # User functions
    "create_user",
    "get_user_by_id",
    "get_user_by_email",
    "upsert_user",
    "update_user",
    # Organization functions
    "create_organization",
    "get_organization_by_id",
    "list_organizations_by_user",
    "update_organization",
    "delete_organization",
    "get_organization_with_projects",
    # Membership functions
    "add_member",
    "get_membership",
    "get_user_role",
    "list_memberships_by_user",
    "list_members_by_org",
    "update_member_role",
    "remove_member",
    "count_owners",
    # Project functions
    "Project",
    "create_project",
    "get_active_project_by_id",
    "list_projects_by_org",
    "update_project",
    "soft_delete_project",
    "has_active_projects",
    "check_project_name_exists",
    # API Key functions
    "ApiKey",
    "ApiKeyWithSecret",
    "create_api_key",
    "delete_api_key",
    "get_api_key_by_hash",
    "get_api_key_by_id",
    "list_api_keys_by_project",
    "update_api_key_last_used",
]
