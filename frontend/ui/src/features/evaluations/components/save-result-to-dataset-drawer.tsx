"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Database } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerBody,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { useToast } from "@/components/ui/toast";
import { EditableValueBlock } from "@/features/offline-eval/components";
import { useDatasets } from "../hooks";

/** Read-only fields never edit, so onChange is a no-op. */
const noop = () => {};

/** The three result→dataset actions the backend `dataset-case` route accepts. */
export type ResultDatasetAction = "update_existing_case" | "save_new_case" | "duplicate_as_variant";

export interface ResultForDataset {
  id: string;
  input: string;
  expectedOutput: string | null;
  candidateOutput: string | null;
  testCaseId: string;
}

const ACTION_META: Record<
  ResultDatasetAction,
  { title: string; blurb: string; cta: string; picksDataset: boolean }
> = {
  update_existing_case: {
    title: "Update source case",
    blurb:
      "Publishes a new immutable version of this run's dataset with this case updated. Runs already recorded keep pointing at the version they used.",
    cta: "Publish update",
    picksDataset: false,
  },
  save_new_case: {
    title: "Save as a new case",
    blurb:
      "Adds a brand-new case to the chosen dataset. Blocked if it would just recreate this result's own source case — use “Update source case” for that.",
    cta: "Save new case",
    picksDataset: true,
  },
  duplicate_as_variant: {
    title: "Duplicate as a variant",
    blurb:
      "Adds a new case tagged as a variant of the source case. Always allowed — useful for exploring a tweak without touching the original.",
    cta: "Duplicate case",
    picksDataset: true,
  },
};

function newIdempotencyKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // A stable-enough fallback for environments without crypto (older jsdom); the
    // server treats the key as opaque, so any per-open unique string is fine.
    return `res-ds-${performance.now()}`;
  }
}

/**
 * Save one evaluation RESULT back into a dataset — update its source case, save a
 * new case, or duplicate it as a variant. The action is chosen upstream (the
 * result's "Add to dataset" menu); this drawer only collects the case fields and
 * POSTs to the `results/[resultId]/dataset-case` route, which publishes a new
 * immutable dataset version.
 *
 * Two invariants are enforced HERE in the UI, matching the backend: a candidate's
 * output never becomes the expected answer unless the reviewer explicitly opts in
 * (the toggle, off by default), and "update" derives its dataset from the result
 * while "save/duplicate" require an explicit target dataset.
 */
export function SaveResultToDatasetDrawer({
  projectId,
  open,
  onOpenChange,
  action,
  result,
  sourceDatasetId,
  sourceDatasetName,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: ResultDatasetAction;
  result: ResultForDataset;
  sourceDatasetId: string;
  sourceDatasetName: string;
}) {
  const meta = ACTION_META[action];
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: datasetsData } = useDatasets(projectId, { limit: 200 });
  const datasets = datasetsData?.data ?? [];

  const [targetDatasetId, setTargetDatasetId] = React.useState(sourceDatasetId);
  const [input, setInput] = React.useState(result.input);
  const [expected, setExpected] = React.useState(result.expectedOutput ?? "");
  const [useCandidateAsExpected, setUseCandidateAsExpected] = React.useState(false);
  const [idempotencyKey, setIdempotencyKey] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  // Reseed every field when the drawer (re)opens for a result/action, and mint a
  // fresh idempotency key so a genuinely new save is never deduped against the last.
  React.useEffect(() => {
    if (!open) return;
    setTargetDatasetId(sourceDatasetId);
    setInput(result.input);
    setExpected(result.expectedOutput ?? "");
    setUseCandidateAsExpected(false);
    setIdempotencyKey(newIdempotencyKey());
    setError(null);
  }, [open, action, result.id, result.input, result.expectedOutput, sourceDatasetId]);

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        action,
        dataset_id: meta.picksDataset ? targetDatasetId : undefined,
        input,
        // The candidate output only lands in `expected` through the explicit flag —
        // never by copying the field. When the flag is off we send the typed expected
        // (empty string → no reference answer, not the candidate's text).
        expected: useCandidateAsExpected ? undefined : expected,
        use_candidate_as_expected: useCandidateAsExpected,
        idempotency_key: idempotencyKey,
      };
      const res = await fetch(
        `/api/projects/${projectId}/evaluations/results/${result.id}/dataset-case`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(payload.error || "Could not save to the dataset.");
      return payload;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["datasets"] });
      toast({
        title: action === "update_existing_case" ? "Dataset updated" : "Case added",
        description:
          action === "update_existing_case"
            ? "A new dataset version was published."
            : "The case was added and a new dataset version was published.",
        tone: "success",
      });
      onOpenChange(false);
    },
    onError: (e: unknown) => {
      setError(e instanceof Error ? e.message : "Could not save to the dataset.");
    },
  });

  const hasChanges =
    (meta.picksDataset && targetDatasetId !== sourceDatasetId) ||
    input !== result.input ||
    useCandidateAsExpected ||
    (!useCandidateAsExpected && expected !== (result.expectedOutput ?? ""));

  const canSave = !save.isPending && (!meta.picksDataset || !!targetDatasetId) && hasChanges;

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent width="w-[560px]">
        <DrawerHeader>
          <DrawerTitle className="flex items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" aria-hidden />
            {meta.title}
          </DrawerTitle>
          <DrawerDescription className="mt-2">{meta.blurb}</DrawerDescription>
        </DrawerHeader>

        <DrawerBody className="space-y-4">
          {/* Target dataset — fixed for update, chosen for save/duplicate. */}
          <div className="space-y-1.5">
            <div className="text-[11px] font-medium text-muted-foreground">Dataset</div>
            {meta.picksDataset ? (
              <Select value={targetDatasetId} onValueChange={setTargetDatasetId}>
                <SelectTrigger className="h-8 text-[12px]">
                  <SelectValue placeholder="Choose a dataset" />
                </SelectTrigger>
                <SelectContent>
                  {datasets.map((d) => (
                    <SelectItem key={d.id} value={d.id} className="text-[12px]">
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <div className="rounded-md border border-input bg-muted/40 px-2.5 py-1.5 text-[12px]">
                <span className="font-medium">{sourceDatasetName}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · case <span className="font-mono">{result.testCaseId}</span>
                </span>
              </div>
            )}
          </div>

          {/* Input — the stable scenario this case tests. */}
          <EditableValueBlock
            label="Input"
            text={input}
            onChange={setInput}
            ariaLabel="Input"
            boxed
            copyable
            seedJson="expanded"
            minRows={2}
          />

          {/* Expected — the reference answer, kept SEPARATE from the candidate output. */}
          <div className="space-y-2 rounded-md border border-border p-2.5">
            <label className="flex items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="text-[12px] font-medium">
                  Use this candidate output as the expected answer
                </span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  Off by default — a candidate&rsquo;s output never becomes the expected answer
                  unless you say so.
                </span>
              </span>
              <Switch
                checked={useCandidateAsExpected}
                onCheckedChange={setUseCandidateAsExpected}
              />
            </label>

            {useCandidateAsExpected ? (
              <EditableValueBlock
                label="Expected (from candidate output)"
                text={result.candidateOutput ?? "(this result produced no output)"}
                onChange={noop}
                readOnly
                boxed
                copyable
                seedJson="expanded"
                minRows={2}
              />
            ) : (
              <EditableValueBlock
                label="Expected answer (optional)"
                text={expected}
                onChange={setExpected}
                ariaLabel="Expected answer"
                boxed
                copyable
                seedJson="expanded"
                minRows={2}
              />
            )}
          </div>

          {error && (
            <div
              role="alert"
              className="rounded-md border border-destructive/50 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive"
            >
              {error}
            </div>
          )}
        </DrawerBody>

        <DrawerFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canSave} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
