from typing import List, Literal, Optional

from pydantic import BaseModel


class WorkflowCheckbox(BaseModel):
    """Workflow checkbox configuration model."""
    summarization: bool = False
    issue_creation: bool = False
    pr_creation: bool = False


class Pattern(BaseModel):
    """Pattern model for workflow items."""
    pattern_id: str
    pattern_description: str


class WorkflowTableData(BaseModel):
    """Workflow table data model representing a workflow item."""
    service_name: str
    trace_id: str
    error_count: int
    summarization: str
    created_issue: str
    created_pr: str
    pattern: Pattern
    timestamp: str


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


# Workflow Items Models
class WorkflowItemRequest(BaseModel):
    """Request model for creating workflow items."""
    trace_id: str
    service_name: str
    error_count: int
    summarization: Optional[str] = "-"
    created_issue: Optional[str] = "-"
    created_pr: Optional[str] = "-"
    pattern: Pattern
    timestamp: str


class WorkflowItemResponse(BaseModel):
    """Response model for workflow item operations."""
    success: bool
    error: Optional[str] = None


class GetWorkflowItemsResponse(BaseModel):
    """Response model for getting workflow items."""
    success: bool
    workflow_items: Optional[List[WorkflowTableData]] = None
    error: Optional[str] = None


class DeleteWorkflowItemRequest(BaseModel):
    """Request model for deleting workflow items."""
    trace_id: str


class DeleteWorkflowItemResponse(BaseModel):
    """Response model for deleting workflow items."""
    success: bool
    error: Optional[str] = None
