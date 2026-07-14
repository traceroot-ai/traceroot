"use client";

import { useState } from "react";
import { useDashboardMutations } from "../hooks/use-dashboards";
import { DASHBOARD_DESCRIPTION_MAX, DASHBOARD_NAME_MAX } from "../types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Edit a dashboard's name and description from the list page. `target`
 * doubles as the open state: a row's Edit action sets it, closing clears it.
 * The drafts seed on mount, so callers must key this component by the
 * target's id to reset them per row.
 */
export function EditDashboardDialog({
  projectId,
  target,
  onClose,
}: {
  projectId: string;
  target: { id: string; name: string; description: string | null } | null;
  onClose: () => void;
}) {
  const { renameDashboard } = useDashboardMutations(projectId, target?.id);
  const [name, setName] = useState(target?.name ?? "");
  const [description, setDescription] = useState(target?.description ?? "");

  const handleOpenChange = (next: boolean) => {
    // Radix close paths (Escape, overlay click) bypass the disabled Cancel
    // button — ignore them while the save is in flight.
    if (!next && renameDashboard.isPending) return;
    if (!next) {
      renameDashboard.reset();
      onClose();
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    renameDashboard.mutate(
      // An emptied description clears the stored one, not just the draft.
      { name: name.trim(), description: description.trim() || null },
      { onSuccess: () => onClose() },
    );
  };

  return (
    <Dialog open={target !== null} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Edit Dashboard</DialogTitle>
            <DialogDescription>
              Update the name and description of “{target?.name}”.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-4">
            <Input
              autoFocus
              aria-label="Dashboard name"
              maxLength={DASHBOARD_NAME_MAX}
              placeholder="Dashboard name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={renameDashboard.isPending}
            />
            <textarea
              aria-label="Dashboard description"
              maxLength={DASHBOARD_DESCRIPTION_MAX}
              rows={3}
              placeholder="Describe the purpose of this dashboard (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={renameDashboard.isPending}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
            />
            {renameDashboard.isError && (
              <p className="text-sm text-destructive">{renameDashboard.error.message}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={renameDashboard.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || renameDashboard.isPending}>
              {renameDashboard.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
