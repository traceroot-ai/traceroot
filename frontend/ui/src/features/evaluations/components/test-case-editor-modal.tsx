"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { EditableValueBlock } from "@/features/offline-eval/components";
import { useSaveTestCase, useUpdateTestCase } from "../hooks";

/**
 * Create / edit a dataset row (test case). "+ Row" opens it empty; the row action
 * menu opens it seeded from the case. Input / Expected / Metadata are the same
 * editable, line-numbered fields the trace "Add to datasets" flow uses — a blank
 * row is authored here rather than inserted empty and edited later. Saving
 * publishes a new immutable dataset version (older snapshots are untouched).
 */
export type TestCaseEditorMode =
  | { kind: "create" }
  | {
      kind: "edit";
      testCaseId: string;
      input: string;
      expected: string | null;
      metadata: unknown;
    };

function metadataToText(metadata: unknown): string {
  if (metadata === null || metadata === undefined) return "";
  if (typeof metadata === "object" && Object.keys(metadata as object).length === 0) return "";
  return JSON.stringify(metadata, null, 2);
}

export function TestCaseEditorModal({
  projectId,
  datasetId,
  mode,
  onClose,
  onSaved,
}: {
  projectId: string;
  datasetId: string;
  mode: TestCaseEditorMode;
  onClose: () => void;
  /** Called with the row the publish wants revealed (the server's `focusTestCaseId`)
   *  and the version number it published, so the caller can wait for that snapshot
   *  to load before revealing the row (null when no new version was published). */
  onSaved: (focusTestCaseId: string | null, versionNumber: number | null) => void;
}) {
  const { toast } = useToast();
  const save = useSaveTestCase(projectId, datasetId);
  const update = useUpdateTestCase(projectId, datasetId);
  const isEdit = mode.kind === "edit";

  const [input, setInput] = React.useState(isEdit ? mode.input : "");
  const [expected, setExpected] = React.useState(isEdit ? (mode.expected ?? "") : "");
  const [metadata, setMetadata] = React.useState(isEdit ? metadataToText(mode.metadata) : "");

  // Close on Escape (capture phase, so a nested popover can pre-empt it).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Metadata must be empty or a JSON object; surfaced so a half-typed value blocks
  // Save rather than being silently dropped.
  const metadataError = React.useMemo(() => {
    const trimmed = metadata.trim();
    if (trimmed === "") return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return null;
      return 'Metadata must be a JSON object, e.g. {"key": "value"}.';
    } catch {
      return "Metadata isn't valid JSON.";
    }
  }, [metadata]);

  const pending = save.isPending || update.isPending;
  // In edit mode, keep Save disabled until a field actually changes (a create is always savable).
  const hasChanges =
    mode.kind !== "edit" ||
    input !== mode.input ||
    expected !== (mode.expected ?? "") ||
    metadata !== metadataToText(mode.metadata);
  const canSave = !metadataError && !pending && hasChanges;

  const handleSave = () => {
    if (!canSave) return;
    const metadataObj: Record<string, unknown> | null = metadata.trim()
      ? (JSON.parse(metadata) as Record<string, unknown>)
      : null;
    // The row to reveal comes from the publish response, never re-derived here —
    // the server decides where a case lands, and a duplicate POST short-circuits
    // to an existing case rather than publishing a new one at all.
    const onSuccess = (res: {
      focusTestCaseId?: string;
      testCaseId?: string;
      versionNumber?: number;
    }) => {
      toast({
        title: isEdit ? "Row saved — new version published" : "Row added",
        tone: "success",
      });
      onSaved(res.focusTestCaseId || res.testCaseId || null, res.versionNumber ?? null);
      onClose();
    };
    const onError = (e: unknown) =>
      toast({ title: "Could not save the row", description: String(e), tone: "warning" });

    if (mode.kind === "edit") {
      update.mutate(
        {
          testCaseId: mode.testCaseId,
          patch: { input, expected: expected.trim() || null, metadata: metadataObj },
        },
        { onSuccess, onError },
      );
    } else {
      save.mutate(
        { input, expected: expected.trim() || null, metadata: metadataObj },
        { onSuccess, onError },
      );
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="test-case-editor-title"
        className="relative z-10 flex max-h-[90vh] w-[min(1080px,94vw)] flex-col rounded-lg border border-border bg-background shadow-xl"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
          <h2 id="test-case-editor-title" className="text-[13px] font-semibold">
            {isEdit ? "Edit Row" : "New Row"}
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

        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-5 py-4 text-[12px]">
          <EditableValueBlock
            label="Input"
            text={input}
            onChange={setInput}
            copyable
            autoDetectKind
            boxed
            minRows={3}
          />
          <EditableValueBlock
            label="Expected"
            text={expected}
            onChange={setExpected}
            copyable
            autoDetectKind
            boxed
            minRows={3}
          />
          <EditableValueBlock
            label="Metadata"
            text={metadata}
            onChange={setMetadata}
            defaultKind="pretty"
            copyable
            autoDetectKind
            boxed
            minRows={2}
          />
          {metadataError && (
            <p className="text-[11px] leading-snug text-amber-700 dark:text-amber-300">
              {metadataError}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="outline" size="sm" className="h-7 text-[12px]" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" className="h-7 text-[12px]" onClick={handleSave} disabled={!canSave}>
            {pending ? "Saving…" : isEdit ? "Save changes" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
