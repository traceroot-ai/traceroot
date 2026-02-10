"use client";

import { useState, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { DeleteButton } from "@/components/ui/delete-button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Role } from "@traceroot/core";
import { updateWorkspace, deleteWorkspace } from "@/lib/api";
import { useWorkspace } from "../hooks";

interface GeneralTabProps {
  workspaceId: string;
}

export function GeneralTab({ workspaceId }: GeneralTabProps) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: workspace, isLoading } = useWorkspace(workspaceId);

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  useEffect(() => {
    if (workspace) {
      setWorkspaceName(workspace.name);
    }
  }, [workspace]);

  const updateMutation = useMutation({
    mutationFn: (name: string) => updateWorkspace(workspaceId, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["workspace", workspaceId] });
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteWorkspace(workspaceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      router.push("/workspaces");
    },
  });

  const handleSave = () => {
    if (workspaceName.trim() && workspaceName !== workspace?.name) {
      updateMutation.mutate(workspaceName.trim());
    }
  };

  const handleDelete = () => {
    if (deleteConfirmText === workspace?.name) {
      deleteMutation.mutate();
    }
  };

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading workspace...</div>;
  }

  const isAdmin = workspace?.role === Role.ADMIN;

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold">General</h2>
        <p className="text-sm text-muted-foreground">Manage your workspace settings</p>
      </div>

      <div className="border p-4">
        <h3 className="text-sm font-medium">Rename workspace</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Update the name of your workspace. Changes will take effect immediately.
        </p>
        <div className="mt-3 flex gap-2">
          <Input
            value={workspaceName}
            onChange={(e) => setWorkspaceName(e.target.value)}
            placeholder="Workspace name"
            className="h-8 max-w-xs text-sm"
          />
          <Button
            size="sm"
            onClick={handleSave}
            disabled={
              updateMutation.isPending || workspaceName === workspace?.name || !workspaceName.trim()
            }
          >
            {updateMutation.isPending ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      {isAdmin && (
        <div className="border p-4">
          <h3 className="text-sm font-medium">Delete workspace</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Permanently delete this workspace and all of its projects and data. This action cannot
            be undone.
          </p>
          <DeleteButton onClick={() => setShowDeleteDialog(true)} className="mt-3">
            Delete workspace
          </DeleteButton>
        </div>
      )}

      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Workspace</DialogTitle>
            <DialogDescription>
              This action cannot be undone. This will permanently delete the workspace &quot;
              <span className="font-semibold">{workspace?.name}</span>&quot; and all associated
              projects and data.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <p className="mb-2 text-sm text-muted-foreground">
              Type{" "}
              <span className="font-mono font-semibold text-foreground">{workspace?.name}</span> to
              confirm:
            </p>
            <Input
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder="Workspace name"
            />
            {deleteMutation.isError && (
              <p className="mt-2 text-sm text-destructive">{deleteMutation.error.message}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteConfirmText !== workspace?.name || deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Workspace"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
