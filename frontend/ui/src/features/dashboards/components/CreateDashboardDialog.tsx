"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useDashboardMutations } from "../hooks/use-dashboards";
import { DASHBOARD_NAME_MAX } from "../types";
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

export function CreateDashboardDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState("");
  const router = useRouter();
  const { createDashboard } = useDashboardMutations(projectId);

  // Closing discards the draft: a cancelled name or stale error must not
  // reappear the next time the dialog opens.
  const handleOpenChange = (next: boolean) => {
    // Radix close paths (Escape, overlay click, the X) bypass the disabled
    // Cancel button — ignore them while a create is in flight, so the pending
    // mutation can't be reset mid-request and resubmitted.
    if (!next && createDashboard.isPending) return;
    if (!next) {
      setName("");
      createDashboard.reset();
    }
    onOpenChange(next);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createDashboard.mutate(
      { name: name.trim() },
      {
        onSuccess: (res) => {
          handleOpenChange(false);
          router.push(`/projects/${projectId}/dashboard/${res.dashboard.id}`);
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create Dashboard</DialogTitle>
            <DialogDescription>Create a new dashboard to organize your widgets.</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              autoFocus
              maxLength={DASHBOARD_NAME_MAX}
              placeholder="Dashboard name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={createDashboard.isPending}
            />
            {createDashboard.isError && (
              <p className="mt-2 text-sm text-destructive">{createDashboard.error.message}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={createDashboard.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || createDashboard.isPending}>
              {createDashboard.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
