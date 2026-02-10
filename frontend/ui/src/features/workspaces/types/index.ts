/**
 * Workspace feature types
 * Re-export shared types and define feature-specific types
 */
export type { Workspace, WorkspaceWithProjects, Role } from "@/types/api";

/**
 * Props for WorkspaceCard component
 */
export interface WorkspaceCardProps {
  workspace: {
    id: string;
    name: string;
    role: string;
    member_count?: number;
    project_count?: number;
    create_time: string;
  };
}

/**
 * Props for CreateWorkspaceDialog component
 */
export interface CreateWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}
