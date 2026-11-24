"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n/provider";

interface DeleteAlertDialogProps {
  alertName: string;
  /** Whether the rule has an alert open, which deleting it closes in Slack. */
  hasOpenPage?: boolean;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isDeleting?: boolean;
  error?: Error | null;
}

export function DeleteAlertDialog({
  alertName,
  hasOpenPage,
  isOpen,
  onClose,
  onConfirm,
  isDeleting,
  error,
}: DeleteAlertDialogProps) {
  const t = useT();
  const [typed, setTyped] = useState("");

  const handleClose = () => {
    setTyped("");
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="max-w-[420px] gap-3">
        <DialogHeader>
          <DialogTitle>{t("alertsDelete.title")}</DialogTitle>
          <DialogDescription className="text-[12px]">
            {t("alertsDelete.textBefore")}{" "}
            <span className="font-medium text-foreground">{alertName}</span>
            {t("alertsDelete.textAfter")}
          </DialogDescription>
        </DialogHeader>

        {hasOpenPage && (
          <p className="text-[12px] text-muted-foreground">{t("alertsDelete.openWarning")}</p>
        )}

        <p className="text-[12px] text-muted-foreground">
          {t("alertsDelete.typeBefore")}{" "}
          <span className="font-medium text-foreground">{alertName}</span>{" "}
          {t("alertsDelete.typeAfter")}
        </p>
        <Input
          className="h-8 text-[12px]"
          placeholder={alertName}
          aria-label={t("alertsDelete.confirmLabel")}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoFocus
        />

        {error && <p className="text-[12px] text-destructive">{error.message}</p>}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-[12px]"
            onClick={handleClose}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            className="h-7 text-[12px]"
            disabled={typed !== alertName || isDeleting}
            onClick={onConfirm}
          >
            {isDeleting ? t("alertsDelete.deleting") : t("common.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
