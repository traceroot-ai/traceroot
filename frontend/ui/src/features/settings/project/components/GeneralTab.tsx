'use client';

import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { DeleteButton } from '@/components/ui/delete-button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { updateProject, deleteProject } from '@/lib/api';
import { useProject } from '../hooks';

interface GeneralTabProps {
  projectId: string;
}

export function GeneralTab({ projectId }: GeneralTabProps) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: project, isLoading } = useProject(projectId);

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [deleteConfirmText, setDeleteConfirmText] = useState('');

  useEffect(() => {
    if (project) {
      setProjectName(project.name);
    }
  }, [project]);

  const updateMutation = useMutation({
    mutationFn: (name: string) => {
      if (!project) throw new Error('Project not found');
      return updateProject(project.workspace_id, projectId, { name });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => {
      if (!project) throw new Error('Project not found');
      return deleteProject(project.workspace_id, projectId);
    },
    onSuccess: () => {
      const workspaceId = project?.workspace_id;
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId] });
      queryClient.invalidateQueries({ queryKey: ['projects', workspaceId] });
      router.push(`/workspaces/${workspaceId}/projects`);
    },
  });

  const handleSave = () => {
    if (projectName.trim() && projectName !== project?.name) {
      updateMutation.mutate(projectName.trim());
    }
  };

  const handleDelete = () => {
    if (deleteConfirmText === project?.name) {
      deleteMutation.mutate();
    }
  };

  if (isLoading) {
    return <div className="text-[13px] text-muted-foreground">Loading project...</div>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">General</h2>
        <p className="text-[13px] text-muted-foreground">
          Manage your project settings and preferences
        </p>
      </div>

      <div className="border p-4">
        <h3 className="text-[13px] font-medium">Rename project</h3>
        <p className="text-[12px] text-muted-foreground mt-1">
          Update the name of your project. Changes will take effect immediately.
        </p>
        <div className="flex gap-2 mt-3">
          <Input
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder="Project name"
            className="max-w-xs h-7 text-[13px]"
          />
          <Button
            size="sm"
            className="h-7 text-[12px]"
            onClick={handleSave}
            disabled={updateMutation.isPending || projectName === project?.name || !projectName.trim()}
          >
            {updateMutation.isPending ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>

      <div className="border p-4">
        <h3 className="text-[13px] font-medium">Delete project</h3>
        <p className="text-[12px] text-muted-foreground mt-1">
          Permanently delete this project and all of its data. This action cannot be undone.
        </p>
        <DeleteButton
          onClick={() => setShowDeleteDialog(true)}
          className="mt-3 h-7 text-[12px]"
        >
          Delete project
        </DeleteButton>
      </div>

      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Project</DialogTitle>
            <DialogDescription>
              This action cannot be undone. This will permanently delete the project
              &quot;<span className="font-semibold">{project?.name}</span>&quot; and all associated data.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm text-muted-foreground mb-2">
              Type <span className="font-mono font-semibold text-foreground">{project?.name}</span> to confirm:
            </p>
            <Input
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder="Project name"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteConfirmText !== project?.name || deleteMutation.isPending}
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete Project'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
