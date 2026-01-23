"""Organization management API endpoints."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from common.models import OrganizationMembership, Role
from db.postgres import (
    add_member,
    check_project_name_exists,
    count_owners,
    create_organization,
    create_project,
    delete_organization,
    get_active_project_by_id,
    get_membership,
    get_organization_with_projects,
    get_user_by_email,
    get_user_by_id,
    has_active_projects,
    list_members_by_org,
    list_organizations_by_user,
    list_projects_by_org,
    remove_member,
    soft_delete_project,
    update_member_role,
    update_organization,
)
from rest.routers.deps import (
    CurrentUser,
    DbSession,
    OrgMembership,
    get_db_session,
    require_org_role,
)
from rest.config.organizations import (
    MemberCreate,
    MemberListResponse,
    MemberResponse,
    MemberUpdate,
    OrganizationCreate,
    OrganizationListResponse,
    OrganizationResponse,
    OrganizationUpdate,
    OrganizationWithProjects,
    ProjectCreate,
    ProjectListResponse,
    ProjectResponse,
)

router = APIRouter(prefix="/organizations", tags=["Organizations"])


# =============================================================================
# Organization CRUD
# =============================================================================


@router.post("", status_code=status.HTTP_201_CREATED, response_model=OrganizationResponse)
async def create_organization_endpoint(
    data: OrganizationCreate,
    user: CurrentUser,
    session: DbSession,
):
    """
    Create a new organization.

    The creating user automatically becomes the OWNER.
    """
    # Create organization
    org = await create_organization(session, name=data.name)

    # Add creator as OWNER
    await add_member(
        session,
        org_id=org.id,
        user_id=user.id,
        role=Role.OWNER,
    )

    await session.commit()

    return OrganizationResponse(
        id=org.id,
        name=org.name,
        role=Role.OWNER.value,
        created_at=org.created_at,
        updated_at=org.updated_at,
    )


@router.get("", response_model=OrganizationListResponse)
async def list_organizations_endpoint(
    user: CurrentUser,
    session: DbSession,
):
    """List all organizations the user belongs to."""
    orgs = await list_organizations_by_user(session, user.id)

    return OrganizationListResponse(
        data=[
            OrganizationResponse(
                id=org.id,
                name=org.name,
                role=org.role.value,
                created_at=org.created_at,
                updated_at=org.updated_at,
            )
            for org in orgs
        ]
    )


@router.get("/{org_id}", response_model=OrganizationWithProjects)
async def get_organization_endpoint(
    org_id: str,
    membership: OrgMembership,
    session: DbSession,
):
    """Get organization details with projects."""
    org = await get_organization_with_projects(session, org_id)

    if not org:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found",
        )

    # Filter to non-deleted projects
    active_projects = [p for p in org.projects if p.deleted_at is None]

    return OrganizationWithProjects(
        id=org.id,
        name=org.name,
        role=membership.role.value,
        created_at=org.created_at,
        updated_at=org.updated_at,
        projects=[
            ProjectResponse(
                id=p.id,
                org_id=p.org_id,
                name=p.name,
                retention_days=p.retention_days,
                created_at=p.created_at,
                updated_at=p.updated_at,
            )
            for p in active_projects
        ],
    )


@router.put("/{org_id}", response_model=OrganizationResponse)
async def update_organization_endpoint(
    org_id: str,
    data: OrganizationUpdate,
    membership: Annotated[OrganizationMembership, Depends(require_org_role(Role.ADMIN))],
    session: DbSession,
):
    """Update organization details. Requires ADMIN role or higher."""
    org = await update_organization(session, org_id, name=data.name)

    if not org:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found",
        )

    await session.commit()

    return OrganizationResponse(
        id=org.id,
        name=org.name,
        role=membership.role.value,
        created_at=org.created_at,
        updated_at=org.updated_at,
    )


@router.delete("/{org_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_organization_endpoint(
    org_id: str,
    membership: Annotated[OrganizationMembership, Depends(require_org_role(Role.OWNER))],
    session: DbSession,
):
    """
    Delete organization. Requires OWNER role.

    Cannot delete if there are active (non-deleted) projects.
    """
    # Check for active projects
    if await has_active_projects(session, org_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot delete organization with active projects. Delete all projects first.",
        )

    deleted = await delete_organization(session, org_id)

    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found",
        )

    await session.commit()


# =============================================================================
# Project Management (nested under organization)
# =============================================================================


@router.get("/{org_id}/projects", response_model=ProjectListResponse)
async def list_projects_endpoint(
    org_id: str,
    membership: OrgMembership,
    session: DbSession,
):
    """List all projects in an organization."""
    projects = await list_projects_by_org(session, org_id, include_deleted=False)

    return ProjectListResponse(
        data=[
            ProjectResponse(
                id=p.id,
                org_id=p.org_id,
                name=p.name,
                retention_days=p.retention_days,
                created_at=p.created_at,
                updated_at=p.updated_at,
            )
            for p in projects
        ]
    )


@router.post(
    "/{org_id}/projects",
    status_code=status.HTTP_201_CREATED,
    response_model=ProjectResponse,
)
async def create_project_endpoint(
    org_id: str,
    data: ProjectCreate,
    membership: Annotated[OrganizationMembership, Depends(require_org_role(Role.MEMBER))],
    session: DbSession,
):
    """Create a new project. Requires MEMBER role or higher."""
    # Check for duplicate name
    if await check_project_name_exists(session, org_id, data.name):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A project with this name already exists in the organization",
        )

    project = await create_project(session, org_id=org_id, name=data.name)
    await session.commit()

    return ProjectResponse(
        id=project.id,
        org_id=project.org_id,
        name=project.name,
        retention_days=project.retention_days,
        created_at=project.created_at,
        updated_at=project.updated_at,
    )


@router.delete("/{org_id}/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project_endpoint(
    org_id: str,
    project_id: str,
    membership: Annotated[OrganizationMembership, Depends(require_org_role(Role.ADMIN))],
    session: DbSession,
):
    """Soft-delete a project. Requires ADMIN role or higher."""
    # Verify project belongs to org
    project = await get_active_project_by_id(session, project_id)
    if not project or project.org_id != org_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Project not found",
        )

    await soft_delete_project(session, project_id)
    await session.commit()


# =============================================================================
# Member Management
# =============================================================================


@router.get("/{org_id}/members", response_model=MemberListResponse)
async def list_members_endpoint(
    org_id: str,
    membership: OrgMembership,
    session: DbSession,
):
    """List all members of an organization."""
    members = await list_members_by_org(session, org_id)

    return MemberListResponse(
        data=[
            MemberResponse(
                id=m.id,
                user_id=m.user_id,
                email=m.email,
                name=m.name,
                role=m.role.value,
                created_at=m.created_at,
            )
            for m in members
        ]
    )


@router.post(
    "/{org_id}/members",
    status_code=status.HTTP_201_CREATED,
    response_model=MemberResponse,
)
async def add_member_endpoint(
    org_id: str,
    data: MemberCreate,
    membership: Annotated[OrganizationMembership, Depends(require_org_role(Role.ADMIN))],
    session: DbSession,
):
    """
    Add a member to the organization. Requires ADMIN role or higher.

    The user must already exist (have signed up).
    """
    # Find user by email
    user = await get_user_by_email(session, data.email)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found. They must sign up first.",
        )

    # Check if already a member
    existing = await get_membership(session, org_id, user.id)
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="User is already a member of this organization",
        )

    # Add member
    new_membership = await add_member(
        session,
        org_id=org_id,
        user_id=user.id,
        role=Role(data.role),
    )
    await session.commit()

    return MemberResponse(
        id=new_membership.id,
        user_id=user.id,
        email=user.email,
        name=user.name,
        role=new_membership.role.value,
        created_at=new_membership.created_at,
    )


@router.put("/{org_id}/members/{user_id}", response_model=MemberResponse)
async def update_member_role_endpoint(
    org_id: str,
    user_id: str,
    data: MemberUpdate,
    membership: Annotated[OrganizationMembership, Depends(require_org_role(Role.ADMIN))],
    session: DbSession,
):
    """
    Update a member's role. Requires ADMIN role or higher.

    Cannot demote yourself if you're the last OWNER.
    """
    # Get target membership
    target_membership = await get_membership(session, org_id, user_id)
    if not target_membership:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Member not found",
        )

    new_role = Role(data.role)

    # Prevent removing last OWNER
    if target_membership.role == Role.OWNER and new_role != Role.OWNER:
        owner_count = await count_owners(session, org_id)
        if owner_count <= 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot demote the last owner",
            )

    # Only OWNER can promote to OWNER or demote from OWNER
    if (new_role == Role.OWNER or target_membership.role == Role.OWNER) and membership.role != Role.OWNER:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only owners can promote to or demote from owner role",
        )

    updated = await update_member_role(session, org_id, user_id, new_role)
    await session.commit()

    # Get user details
    user = await get_user_by_id(session, user_id)

    return MemberResponse(
        id=updated.id,
        user_id=user_id,
        email=user.email if user else None,
        name=user.name if user else None,
        role=updated.role.value,
        created_at=updated.created_at,
    )


@router.delete("/{org_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_member_endpoint(
    org_id: str,
    user_id: str,
    membership: Annotated[OrganizationMembership, Depends(require_org_role(Role.ADMIN))],
    session: DbSession,
):
    """
    Remove a member from the organization. Requires ADMIN role or higher.

    Cannot remove yourself if you're the last OWNER.
    """
    # Get target membership
    target_membership = await get_membership(session, org_id, user_id)
    if not target_membership:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Member not found",
        )

    # Prevent removing last OWNER
    if target_membership.role == Role.OWNER:
        owner_count = await count_owners(session, org_id)
        if owner_count <= 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot remove the last owner",
            )

    # Only OWNER can remove another OWNER
    if target_membership.role == Role.OWNER and membership.role != Role.OWNER:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only owners can remove other owners",
        )

    await remove_member(session, org_id, user_id)
    await session.commit()
