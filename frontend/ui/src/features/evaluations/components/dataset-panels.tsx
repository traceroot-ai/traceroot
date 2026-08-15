"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Database, X } from "lucide-react";
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
          toast({ title: "Dataset created", tone: "success" });
          onOpenChange(false);
          // Jump straight into the dataset that was just created.
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

  return (
    <div className="animate-slide-in-right fixed bottom-0 right-0 top-0 z-50 flex w-[560px] max-w-[96vw] flex-col border-l border-border bg-background shadow-xl">
      <div className="flex h-10 flex-shrink-0 items-center justify-between border-b border-border bg-muted/30 px-4">
        <div className="flex min-w-0 items-center gap-2">
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
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="h-7 w-7 p-0"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <DatasetFormFields state={state} onChange={setState} />
      </div>

      <div className="flex flex-shrink-0 justify-end gap-2 border-t border-border px-4 py-3">
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
      </div>
    </div>
  );
}
