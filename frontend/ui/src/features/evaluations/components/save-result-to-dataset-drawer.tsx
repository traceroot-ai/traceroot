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
  SelectEmpty,
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
import { encodeEditedText } from "@/lib/eval/json-value";
import { useT } from "@/lib/i18n/provider";
import { Slots } from "@/lib/i18n/slots";
import type { MessageKey } from "@/lib/i18n/messages/en";
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
  { titleKey: MessageKey; blurbKey: MessageKey; picksDataset: boolean }
> = {
  update_existing_case: {
    titleKey: "evalsSaveResult.updateTitle",
    blurbKey: "evalsSaveResult.updateBlurb",
    picksDataset: false,
  },
  save_new_case: {
    titleKey: "evalsSaveResult.saveNewTitle",
    blurbKey: "evalsSaveResult.saveNewBlurb",
    picksDataset: true,
  },
  duplicate_as_variant: {
    titleKey: "evalsSaveResult.duplicateTitle",
    blurbKey: "evalsSaveResult.duplicateBlurb",
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
  const t = useT();
  const meta = ACTION_META[action];
  const qc = useQueryClient();
  const { toast } = useToast();
  const {
    data: datasetsData,
    isLoading: datasetsLoading,
    isError: datasetsError,
  } = useDatasets(projectId, { limit: 200 });
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
      if (!res.ok) throw new Error(payload.error || t("evalsSaveResult.saveFailed"));
      return payload;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["datasets"] });
      toast({
        title:
          action === "update_existing_case"
            ? t("evalsSaveResult.toastUpdatedTitle")
            : t("evalsSaveResult.toastAddedTitle"),
        description:
          action === "update_existing_case"
            ? t("evalsSaveResult.toastUpdatedText")
            : t("evalsSaveResult.toastAddedText"),
        tone: "success",
      });
      onOpenChange(false);
    },
    onError: (e: unknown) => {
      setError(e instanceof Error ? e.message : t("evalsSaveResult.saveFailed"));
    },
  });

  // Only "update" republishes an existing case, so only it needs a dirty gate; save/duplicate
  // always create a case and are savable as they stand. Every field is compared the way it is
  // PERSISTED — `input` and `expected` compare encoded values against their stored seed so
  // structured values that EditableValueBlock pretty-prints on mount do not start dirty, while
  // real value edits (and string whitespace edits) enable Save.
  const hasChanges =
    action === "update_existing_case"
      ? encodeEditedText(result.input, input) !== encodeEditedText(result.input, result.input) ||
        (useCandidateAsExpected
          ? result.candidateOutput === null
            ? result.expectedOutput !== null
            : result.expectedOutput === null ||
              encodeEditedText(result.expectedOutput, result.candidateOutput) !==
                encodeEditedText(result.expectedOutput, result.expectedOutput)
          : encodeEditedText(result.expectedOutput, expected) !==
            encodeEditedText(result.expectedOutput, result.expectedOutput ?? ""))
      : true;

  const canSave =
    !save.isPending &&
    (!meta.picksDataset || datasets.some((d) => d.id === targetDatasetId)) &&
    hasChanges;

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent width="w-[560px]">
        <DrawerHeader>
          <DrawerTitle className="flex items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" aria-hidden />
            {t(meta.titleKey)}
          </DrawerTitle>
          <DrawerDescription className="mt-2">{t(meta.blurbKey)}</DrawerDescription>
        </DrawerHeader>

        <DrawerBody className="space-y-4">
          {/* Target dataset — fixed for update, chosen for save/duplicate. */}
          <div className="space-y-1.5">
            <div className="text-[12px] font-medium text-muted-foreground">
              {t("evalsShared.dataset")}
            </div>
            {meta.picksDataset ? (
              <Select
                value={datasets.some((d) => d.id === targetDatasetId) ? targetDatasetId : ""}
                onValueChange={setTargetDatasetId}
              >
                <SelectTrigger className="h-8 text-[13px]">
                  <SelectValue placeholder={t("evalsSaveResult.chooseDataset")} />
                </SelectTrigger>
                <SelectContent>
                  {datasets.length ? (
                    datasets.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}
                      </SelectItem>
                    ))
                  ) : (
                    <SelectEmpty>
                      {datasetsLoading
                        ? t("evalsSave.loadingDatasets")
                        : datasetsError
                          ? t("evalsSave.loadDatasetsFailed")
                          : t("evalsSave.noDatasets")}
                    </SelectEmpty>
                  )}
                </SelectContent>
              </Select>
            ) : (
              <div className="rounded-md border border-input bg-muted px-2.5 py-1.5 text-[12px]">
                <span className="font-medium">{sourceDatasetName}</span>
                <span className="text-muted-foreground">
                  {" "}
                  <Slots
                    text={t("evalsSaveResult.caseRef")}
                    slots={{ id: <span className="font-mono">{result.testCaseId}</span> }}
                  />
                </span>
              </div>
            )}
          </div>

          {/* Input — the stable scenario this case tests. */}
          <EditableValueBlock
            label={t("evalsShared.input")}
            text={input}
            onChange={setInput}
            ariaLabel={t("evalsShared.input")}
            boxed
            copyable
            seedJson="expanded"
            minRows={2}
          />

          {/* Expected — the reference answer, kept SEPARATE from the candidate output. */}
          <div className="space-y-2 rounded-md border border-border p-2.5">
            <label className="flex items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="text-[12px] font-medium">{t("evalsSaveResult.useCandidate")}</span>
                <span className="mt-0.5 block text-[12px] text-muted-foreground">
                  {t("evalsSaveResult.useCandidateHint")}
                </span>
              </span>
              <Switch
                checked={useCandidateAsExpected}
                onCheckedChange={setUseCandidateAsExpected}
              />
            </label>

            {useCandidateAsExpected ? (
              <EditableValueBlock
                label={t("evalsSaveResult.expectedFromCandidate")}
                text={result.candidateOutput ?? t("evalsSaveResult.noCandidateOutput")}
                onChange={noop}
                readOnly
                boxed
                copyable
                seedJson="expanded"
                minRows={2}
              />
            ) : (
              <EditableValueBlock
                label={t("evalsSaveResult.expectedOptional")}
                text={expected}
                onChange={setExpected}
                ariaLabel={t("evalsSaveResult.expectedAria")}
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
              className="rounded-md border border-destructive/50 bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive"
            >
              {error}
            </div>
          )}
        </DrawerBody>

        <DrawerFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" disabled={!canSave} onClick={() => save.mutate()}>
            {save.isPending ? t("evalsShared.saving") : t("common.save")}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
