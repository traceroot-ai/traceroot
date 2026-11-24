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
import { updateProject, deleteProject } from "@/lib/api";
import { useProject } from "@/features/projects/hooks";
import { useT } from "@/lib/i18n/provider";

interface GeneralTabProps {
  projectId: string;
}

export function GeneralTab({ projectId }: GeneralTabProps) {
  const router = useRouter();
  const t = useT();
  const queryClient = useQueryClient();

  const { data: project, isLoading } = useProject(projectId);

  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  useEffect(() => {
    if (project) {
      setProjectName(project.name);
    }
  }, [project]);

  const updateMutation = useMutation({
    mutationFn: (name: string) => {
      if (!project) throw new Error("Project not found");
      return updateProject(project.workspace_id, projectId, { name });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => {
      if (!project) throw new Error("Project not found");
      return deleteProject(project.workspace_id, projectId);
    },
    onSuccess: () => {
      const workspaceId = project?.workspace_id;
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      queryClient.invalidateQueries({ queryKey: ["workspace", workspaceId] });
      queryClient.invalidateQueries({ queryKey: ["projects", workspaceId] });
      router.push(`/workspaces/${workspaceId}/projects`);
    },
  });

  const handleSave = () => {
    if (projectName.trim() && projectName !== project?.name) {
      updateMutation.mutate(projectName.trim());
    }
  };

  const handleDelete = () => {
    if (deleteConfirmText === project?.name && !deleteMutation.isPending) {
      deleteMutation.mutate();
    }
  };

  if (isLoading) {
    return <div className="text-[13px] text-muted-foreground">{t("projectSettings.loading")}</div>;
  }

  return (
    <div className="space-y-4">
      <div className="-mx-4 -mt-4 flex h-11 items-center gap-3 border-b border-border px-4">
        <h2 className="text-[15px] font-medium">{t("settings.general")}</h2>
        <p className="text-[13px] text-muted-foreground">{t("projectSettings.subtitle")}</p>
      </div>

      <div className="border">
        <div className="flex h-9 items-center border-b px-4">
          <h3 className="text-[13px] font-medium">{t("projectSettings.renameTitle")}</h3>
        </div>
        <div className="p-4">
          <p className="mt-1 text-[12px] text-muted-foreground">
            {t("projectSettings.renameText")}
          </p>
          <div className="mt-3 flex gap-2">
            <Input
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder={t("projects.namePlaceholder")}
              className="h-8 max-w-xs text-[13px]"
            />
            <Button
              size="sm"
              className="h-8 text-[13px]"
              onClick={handleSave}
              disabled={
                updateMutation.isPending || projectName === project?.name || !projectName.trim()
              }
            >
              {updateMutation.isPending ? t("common.saving") : t("common.save")}
            </Button>
          </div>
        </div>
      </div>

      <div className="border">
        <div className="flex h-9 items-center border-b px-4">
          <h3 className="text-[13px] font-medium">{t("projectSettings.deleteTitle")}</h3>
        </div>
        <div className="p-4">
          <p className="mt-1 text-[12px] text-muted-foreground">
            {t("projectSettings.deleteText")}
          </p>
          <DeleteButton onClick={() => setShowDeleteDialog(true)} className="mt-3 h-7 text-[12px]">
            {t("projectSettings.deleteTitle")}
          </DeleteButton>
        </div>
      </div>

      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("projectSettings.deleteDialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("projectSettings.deleteDialogBefore")}
              <span className="font-semibold">{project?.name}</span>
              {t("projectSettings.deleteDialogAfter")}
            </DialogDescription>
          </DialogHeader>
          <div>
            <p className="mb-2 text-sm text-muted-foreground">
              {t("workspaceSettings.typeBefore")}{" "}
              <span className="font-mono font-semibold text-foreground">{project?.name}</span>{" "}
              {t("workspaceSettings.typeAfter")}
            </p>
            <Input
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && handleDelete()}
              placeholder={t("projects.namePlaceholder")}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteConfirmText !== project?.name || deleteMutation.isPending}
            >
              {deleteMutation.isPending
                ? t("workspaceSettings.deleting")
                : t("projectSettings.deleteDialogTitle")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
