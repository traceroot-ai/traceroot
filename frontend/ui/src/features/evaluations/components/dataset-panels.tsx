"use client";

import * as React from "react";
import { Check, Copy, Database } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  DatasetFormFields,
  emptyDatasetForm,
  type DatasetFormState,
} from "@/features/offline-eval/components";
import { useCreateDataset, useUpdateDataset } from "../hooks";

/**
 * Server-wired New-dataset and Edit-dataset panels, sharing DatasetFormFields
 * and persisting through the real hooks with real toasts. The schema/metadata
 * form cards are illustrative for now (the server persists name + description);
 * kept visible by design.
 *
 * Both panels are built on the shared `Drawer` (Radix Dialog underneath) rather
 * than a hand-rolled `fixed` overlay, so they get a real focus trap, scroll
 * lock, Escape handling, and `role="dialog"`/`aria-modal` for free — matching
 * `form-kit.tsx`'s `CreateDrawer` and keeping the two panels consistent with
 * each other instead of each reinventing (or half-reinventing) the same thing.
 */

/** "New dataset" — right slide-in drawer, same shape as Save as test case. */
export function NewDatasetPanel({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const create = useCreateDataset(projectId);
  const [state, setState] = React.useState<DatasetFormState>(emptyDatasetForm());

  React.useEffect(() => {
    if (open) setState(emptyDatasetForm());
  }, [open]);

  const canCreate = state.name.trim() !== "";
  const handleCreate = () => {
    if (!canCreate) return;
    create.mutate(
      { name: state.name.trim(), description: state.description.trim() || null },
      {
        onSuccess: () => {
          toast({ title: "Dataset created", tone: "success" });
          onOpenChange(false);
        },
        onError: (e) =>
          toast({ title: "Could not create dataset", description: String(e), tone: "warning" }),
      },
    );
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent width="w-[560px]">
        <DrawerHeader className="pr-10">
          <DrawerTitle>New dataset</DrawerTitle>
        </DrawerHeader>
        <DrawerBody>
          <DatasetFormFields state={state} onChange={setState} />
        </DrawerBody>
        <DrawerFooter className="justify-end">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[12px]"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-7 text-[12px]"
            onClick={handleCreate}
            disabled={!canCreate || create.isPending}
          >
            {create.isPending ? "Creating…" : "Create dataset"}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

/** "Edit dataset" — right slide-in drawer, modelled on the detector edit panel. */
export function DatasetEditPanel({
  projectId,
  dataset,
  onClose,
}: {
  projectId: string;
  dataset: { id: string; name: string; description: string | null };
  onClose: () => void;
}) {
  const { toast } = useToast();
  const update = useUpdateDataset(projectId, dataset.id);
  const [copied, setCopied] = React.useState(false);
  const [state, setState] = React.useState<DatasetFormState>(() =>
    emptyDatasetForm({ name: dataset.name, description: dataset.description ?? "" }),
  );

  React.useEffect(() => {
    setState(emptyDatasetForm({ name: dataset.name, description: dataset.description ?? "" }));
  }, [dataset]);

  const copyId = () => {
    navigator.clipboard?.writeText(dataset.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleSave = () => {
    update.mutate(
      { name: state.name.trim(), description: state.description.trim() || null },
      {
        onSuccess: () => {
          toast({ title: "Dataset saved", tone: "success" });
          onClose();
        },
        onError: (e) =>
          toast({ title: "Could not save dataset", description: String(e), tone: "warning" }),
      },
    );
  };

  // Mounted only while editing (see datasets-view.tsx), so it is always "open";
  // a dismiss of any kind (Escape, overlay click, the drawer's own close button)
  // routes through onClose the same way Cancel does.
  return (
    <Drawer open onOpenChange={(next) => !next && onClose()}>
      <DrawerContent width="w-[560px]">
        {/* Visually-hidden title for the Radix a11y contract; the visible
            identity strip below (name + copyable id) is the real header. */}
        <DrawerTitle className="sr-only">Edit dataset {dataset.name}</DrawerTitle>
        <div className="flex h-10 flex-shrink-0 items-center gap-2 border-b border-border bg-muted/30 px-4 pr-10">
          <Database className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-[13px] font-medium">Dataset</span>
          <span className="truncate text-[13px] text-muted-foreground">{dataset.name}</span>
          <button
            type="button"
            onClick={copyId}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground/60 transition-colors hover:bg-muted hover:text-muted-foreground"
            title="Copy dataset ID"
          >
            {dataset.id}
            {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
          </button>
        </div>

        <DrawerBody>
          <DatasetFormFields state={state} onChange={setState} />
        </DrawerBody>

        <DrawerFooter className="justify-end">
          <Button variant="outline" size="sm" onClick={onClose} className="h-7 text-[12px]">
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            className="h-7 text-[12px]"
            disabled={update.isPending}
          >
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
