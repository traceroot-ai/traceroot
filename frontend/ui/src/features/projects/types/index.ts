/**
 * Project feature types
 * Re-export shared types and define feature-specific types
 */
export type { Project } from '@/types/api';

/**
 * Props for ProjectCard component
 */
export interface ProjectCardProps {
  project: {
    id: string;
    name: string;
    trace_ttl_days: number | null;
    access_key_count?: number;
    create_time: string;
  };
  workspaceId: string;
}

/**
 * Props for CreateProjectDialog component
 */
export interface CreateProjectDialogProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}
