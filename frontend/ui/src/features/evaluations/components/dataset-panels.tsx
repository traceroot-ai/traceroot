"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
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
 */

/** "New dataset" — non-modal right slide-in, same shape as Save as test case. */
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
  const router = useRouter();
  const create = useCreateDataset(projectId);
  const [state, setState] = React.useState<DatasetFormState>(emptyDatasetForm());

  React.useEffect(() => {
    if (open) setState(emptyDatasetForm());
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onOpenChange]);

  if (!open) return null;

  const canCreate = state.name.trim() !== "";
  const handleCreate = () => {
    if (!canCreate) return;
    create.mutate(
      { name: state.name.trim(), description: state.description.trim() || null },
      {
        onSuccess: (data) => {
          // Creating a name that already resolves to a dataset opens it instead of
          // erroring (same name = same dataset), so the toast reflects which happened.
          toast({
            title: data.created ? "Dataset created" : "Opened existing dataset",
            tone: "success",
          });
          onOpenChange(false);
          // Jump straight into the dataset (the one just created, or the existing one).
          router.push(`/projects/${projectId}/datasets/${data.dataset.id}`);
        },
        onError: (e) =>
          toast({ title: "Could not create dataset", description: String(e), tone: "warning" }),
      },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      {/* Dimmed backdrop; clicking it closes the modal. */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={() => onOpenChange(false)}
        aria-hidden
      />
      {/* Centered modal (matches the "Add to datasets" modal), not a side drawer. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-dataset-title"
        className="relative z-10 flex max-h-[90vh] w-[min(560px,94vw)] flex-col rounded-lg border border-border bg-background shadow-xl"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
          <h2 id="new-dataset-title" className="text-[13px] font-semibold">
            New dataset
          </h2>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
            className="rounded-sm text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          <DatasetFormFields state={state} onChange={setState} />
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">
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
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** "Edit dataset" — right slide-in, modelled on the detector edit panel. */
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
  const [state, setState] = React.useState<DatasetFormState>(() =>
    emptyDatasetForm({ name: dataset.name, description: dataset.description ?? "" }),
  );

  React.useEffect(() => {
    setState(emptyDatasetForm({ name: dataset.name, description: dataset.description ?? "" }));
  }, [dataset]);

  const hasChanges =
    state.name.trim() !== dataset.name.trim() ||
    state.description.trim() !== (dataset.description ?? "").trim();
  const canSave = state.name.trim() !== "" && hasChanges;

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      {/* Dimmed backdrop; clicking it closes the modal. */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      {/* Centered modal — identical to the New dataset modal, just pre-filled. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-dataset-title"
        className="relative z-10 flex max-h-[90vh] w-[min(560px,94vw)] flex-col rounded-lg border border-border bg-background shadow-xl"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
          <h2 id="edit-dataset-title" className="text-[13px] font-semibold">
            Edit dataset
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-sm text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          <DatasetFormFields state={state} onChange={setState} />
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="outline" size="sm" className="h-7 text-[12px]" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-7 text-[12px]"
            onClick={handleSave}
            disabled={!canSave || update.isPending}
          >
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
