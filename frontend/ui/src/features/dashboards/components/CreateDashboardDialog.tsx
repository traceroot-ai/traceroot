"use client";

import { useT } from "@/lib/i18n/provider";
import { translateClientError } from "@/lib/i18n/client-errors";
import { useState } from "react";
import { useRouter } from "next/navigation";
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
  const [description, setDescription] = useState("");
  const router = useRouter();
  const t = useT();
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
      setDescription("");
      createDashboard.reset();
    }
    onOpenChange(next);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    createDashboard.mutate(
      { name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) },
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
        <form onSubmit={handleSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t("dashboardsList.createTitle")}</DialogTitle>
            <DialogDescription>{t("dashboardsList.createText")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Input
              autoFocus
              maxLength={DASHBOARD_NAME_MAX}
              placeholder={t("dashboardsList.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={createDashboard.isPending}
            />
            <textarea
              aria-label={t("dashboardsList.descriptionAria")}
              maxLength={DASHBOARD_DESCRIPTION_MAX}
              rows={3}
              placeholder={t("dashboardsList.descriptionPlaceholder")}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={createDashboard.isPending}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
            />
            {createDashboard.isError && (
              <p className="text-sm text-destructive">
                {translateClientError(t, createDashboard.error.message)}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={createDashboard.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!name.trim() || createDashboard.isPending}>
              {createDashboard.isPending ? t("common.creating") : t("common.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
