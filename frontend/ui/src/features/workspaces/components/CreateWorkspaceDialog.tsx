"use client";

import { useT } from "@/lib/i18n/provider";
import { translateClientError } from "@/lib/i18n/client-errors";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createWorkspace } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { AddButton } from "@/components/ui/add-button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

interface CreateWorkspaceDialogProps {
  trigger?: React.ReactNode;
  /** Controlled mode: when provided, no trigger is rendered. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function CreateWorkspaceDialog({
  trigger,
  open: controlledOpen,
  onOpenChange,
}: CreateWorkspaceDialogProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const [name, setName] = useState("");
  const queryClient = useQueryClient();
  const router = useRouter();

  const createMutation = useMutation({
    mutationFn: (name: string) => createWorkspace(name),
    onSuccess: (workspace) => {
      queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      setOpen(false);
      setName("");
      router.push(`/workspaces/${workspace.id}/projects`);
    },
  });

  const t = useT();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim()) {
      createMutation.mutate(name.trim());
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!isControlled && (
        <DialogTrigger asChild>
          {trigger || <AddButton>{t("workspaces.newWorkspace")}</AddButton>}
        </DialogTrigger>
      )}
      <DialogContent>
        <form onSubmit={handleSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t("workspaces.newWorkspace")}</DialogTitle>
            <DialogDescription>{t("workspaces.newDescription")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="workspace-name"
              className="text-[12px] font-medium text-muted-foreground"
            >
              {t("common.name")}
            </label>
            <Input
              id="workspace-name"
              className="h-8 text-[13px]"
              autoFocus
              placeholder={t("workspaces.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={createMutation.isPending}
            />
            {createMutation.isError && (
              <p className="text-[12px] text-destructive">
                {translateClientError(t, createMutation.error.message)}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={createMutation.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!name.trim() || createMutation.isPending}>
              {createMutation.isPending ? t("common.creating") : t("common.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
