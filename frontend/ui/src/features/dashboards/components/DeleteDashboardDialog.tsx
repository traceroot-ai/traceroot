"use client";

import { useT } from "@/lib/i18n/provider";
import { translateClientError } from "@/lib/i18n/client-errors";
import { useDashboardMutations } from "../hooks/use-dashboards";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Confirm-delete for a dashboard, opened from the list page's row actions.
 * `target` doubles as the open state.
 */
export function DeleteDashboardDialog({
  projectId,
  target,
  onClose,
}: {
  projectId: string;
  target: { id: string; name: string } | null;
  onClose: () => void;
}) {
  const t = useT();
  const { removeDashboard } = useDashboardMutations(projectId);

  const handleOpenChange = (next: boolean) => {
    // Radix close paths (Escape, overlay click) bypass the disabled Cancel
    // button — ignore them while the delete is in flight.
    if (!next && removeDashboard.isPending) return;
    if (!next) {
      // Reset so a failed delete of one dashboard doesn't show its error the
      // next time the dialog opens for another.
      removeDashboard.reset();
      onClose();
    }
  };

  const handleDelete = () => {
    if (!target) return;
    removeDashboard.mutate(target.id, {
      onSuccess: () => {
        removeDashboard.reset();
        onClose();
      },
    });
  };

  return (
    <Dialog open={target !== null} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("dashboardsList.deleteTitle")}</DialogTitle>
          <DialogDescription>
            {t("dashboardsList.deleteText", { name: target?.name ?? "" })}
          </DialogDescription>
        </DialogHeader>
        {removeDashboard.isError && (
          <p className="text-sm text-destructive">
            {translateClientError(t, removeDashboard.error.message)}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={removeDashboard.isPending}
          >
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={removeDashboard.isPending}>
            {removeDashboard.isPending ? t("dashboardsList.deleting") : t("common.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
