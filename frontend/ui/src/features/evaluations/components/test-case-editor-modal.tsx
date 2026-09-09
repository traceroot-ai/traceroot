"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { EditableValueBlock } from "@/features/offline-eval/components";
import { canonicalJson } from "@/lib/eval/canonical";
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

/**
 * The canonical form of the value `handleSave` would PERSIST for this metadata text —
 * the parsed object, or null when blank — so the dirty check compares meaning rather than
 * bytes. Metadata is stored parsed, so re-spacing `{"a": 1}` to `{"a":1}` or reordering
 * its keys is a no-op that must not enable Save (it would publish an identical version).
 * Text with no persisted form — half-typed JSON, or a value `canonicalJson` rejects —
 * returns null: `metadataError` runs the same parse AND the same canonicalization, so it
 * blocks Save on either with a message, and a null here is never the only reason Save is
 * off. This runs during render, so it must not throw. The null sentinel can't collide with
 * a real result, which is always a JSON string (blank metadata canonicalizes to `"null"`,
 * not to null).
 */
function metadataSignature(text: string): string | null {
  const trimmed = text.trim();
  try {
    return canonicalJson(trimmed === "" ? null : JSON.parse(trimmed));
  } catch {
    return null;
  }
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
  onSaved: () => void;
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

  // Metadata must be empty or a JSON object that canonicalizes; surfaced so a value with
  // no persisted form blocks Save rather than being silently dropped.
  const metadataError = React.useMemo(() => {
    const trimmed = metadata.trim();
    if (trimmed === "") return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return "Metadata isn't valid JSON.";
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return 'Metadata must be a JSON object, e.g. {"key": "value"}.';
    }
    // Valid JSON syntax is not enough. An unpaired UTF-16 surrogate parses fine but is not
    // valid Unicode text, so `canonicalJson` rejects it (its only rejection) and the value
    // has no canonical form to hash or compare by — which is exactly why `metadataSignature`
    // can't produce one either. Reported here rather than left to the dirty check: a value
    // we can't compare must not be savable, and two different uncanonicalizable values
    // would otherwise read as "no change" and leave Save dead with nothing said.
    try {
      canonicalJson(parsed);
    } catch {
      return "Metadata contains invalid Unicode (an unpaired surrogate).";
    }
    return null;
  }, [metadata]);

  const pending = save.isPending || update.isPending;
  // In edit mode, keep Save disabled until a field actually changes (a create is always savable).
  // Each field is compared the way it is PERSISTED, so an edit that would really change the row
  // can never be gated away as a no-op: `input` is stored verbatim AND its exact bytes are the
  // case's content-addressed id (`stableCaseId` hashes `canonicalJson(input)`, which does not
  // trim), so a whitespace-only input edit is a real change and compares raw; `expected` is
  // stored as `expected.trim() || null` so it compares trimmed, and `metadata` is stored
  // PARSED so it compares canonically (see `metadataSignature`) rather than as raw text.
  // Trimming `input` on the way in is not an option either: that id derivation is byte-parity
  // with the TS/Python SDKs, so a trimming UI would give `" hi "` a different `tc_` id than the
  // same input authored through an SDK, and a re-publish would duplicate the case, not upsert it.
  const hasChanges =
    mode.kind !== "edit" ||
    input !== mode.input ||
    expected.trim() !== (mode.expected ?? "").trim() ||
    // Both sides go through the seeded TEXT, so a case stored as `{}` (which `metadataToText`
    // renders blank) matches an untouched blank field instead of reading as an edit.
    metadataSignature(metadata) !== metadataSignature(metadataToText(mode.metadata));
  const canSave = !metadataError && !pending && hasChanges;

  const handleSave = () => {
    if (!canSave) return;
    const metadataObj: Record<string, unknown> | null = metadata.trim()
      ? (JSON.parse(metadata) as Record<string, unknown>)
      : null;
    const onSuccess = () => {
      toast({
        title: isEdit ? "Row saved — new version published" : "Row added",
        tone: "success",
      });
      onSaved();
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
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
