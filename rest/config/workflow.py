from typing import Literal, Optional

from pydantic import BaseModel


class WorkflowCheckbox(BaseModel):
    """Workflow checkbox configuration model."""
    summarization: bool = False
    issue_creation: bool = False
    pr_creation: bool = False


class WorkflowRequest(BaseModel):
    """Request model for workflow operations (POST/DELETE)."""
    checkbox_type: Literal['summarization', 'issue_creation', 'pr_creation']


class WorkflowResponse(BaseModel):
    """Response model for workflow operations."""
    success: bool
    error: Optional[str] = None


class GetWorkflowResponse(BaseModel):
    """Response model for getting workflow configuration."""
    success: bool
    workflow: Optional[WorkflowCheckbox] = None
    error: Optional[str] = None


class DeleteWorkflowRequest(BaseModel):
    """Request model for deleting workflow configuration."""
    checkbox_type: Literal['summarization', 'issue_creation', 'pr_creation']


class DeleteWorkflowResponse(BaseModel):
    """Response model for deleting workflow configuration."""
    success: bool
    error: Optional[str] = None
