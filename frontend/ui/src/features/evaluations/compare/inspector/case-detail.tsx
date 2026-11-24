"use client";

import * as React from "react";
import { CopyButton } from "@/components/ui/copy-button";
import { DiffBox, DiffChoice } from "@/features/traces/components/DiffBox";
import { ValueDiff, type DiffSide } from "@/features/traces/components/ValueDiff";
import { canonicalInputKey } from "@/lib/eval/json-value";
import { normalizeForDiff } from "@/lib/eval/line-diff";
import type { ResultRow } from "../../types";
import { Dot } from "../cells";
import { CELL_STATE_LABEL, taskErrorOf } from "../cell-state";
import { compareCase, expectedKeyOf, type CaseRow, type CompareModel } from "../model";
import { OUTPUT_MODES, type OutputMode } from "./output-modes";
import { UsageDetails, type UsageSide } from "./pair-usage";
import { ScoresTable } from "./scores-table";

const copyButtonClass = "h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground";

function Value({ text, empty }: { text: string | null; empty: string }) {
  if (text === null) return <p className="text-muted-foreground">{empty}</p>;
  return (
    <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed">
      {text}
    </pre>
  );
}

/** A result's values as the trace panel shows and compares them, each decoded once. */
interface Shown {
  input: string;
  /** Whether two inputs are the same input: the alignment key, so inputs aligned across
   *  datasets in another encoding count as one. */
  inputKey: string;
  expected: string | null;
  /** Whether two expected outputs are the same one (`expectedKeyOf`), as the table's
   *  Expected column decides it. */
  expectedKey: string;
  output: string | null;
}

function shownOf(r: ResultRow | undefined): Shown | null {
  if (!r) return null;
  return {
    input: normalizeForDiff(r.input),
    inputKey: canonicalInputKey(r.input),
    expected: r.expectedOutput === null ? null : normalizeForDiff(r.expectedOutput),
    expectedKey: expectedKeyOf(r),
    output: r.candidateOutput ? normalizeForDiff(r.candidateOutput) : null,
  };
}

interface Side {
  label: "Baseline" | "Candidate";
  runId: string;
  /** The run's tag, e.g. "#2". */
  tag: string;
  heading: string;
  dot: string;
  result: ResultRow | undefined;
  shown: Shown | null;
}

/** A value both runs have for the case, shown once when they agree on it (`sameOn`) and
 *  once per run, labelled, when they don't. */
function SharedValue({
  title,
  sides,
  get,
  sameOn,
  empty,
}: {
  title: string;
  sides: Side[];
  get: (shown: Shown) => string | null;
  sameOn: (shown: Shown) => string;
  empty: string;
}) {
  const present = sides.flatMap((s) =>
    s.shown ? [{ ...s, text: get(s.shown), key: sameOn(s.shown) }] : [],
  );
  if (new Set(present.map((p) => p.key)).size <= 1) {
    const text = present[0]?.text ?? null;
    return (
      <DiffBox
        title={title}
        actions={
          text !== null && (
            <CopyButton
              value={text}
              className={copyButtonClass}
              aria-label={`Copy ${title.toLowerCase()}`}
              title={`Copy ${title.toLowerCase()}`}
            />
          )
        }
      >
        <Value text={text} empty={empty} />
      </DiffBox>
    );
  }
  return (
    <DiffBox title={title}>
      <div className="space-y-2">
        {present.map((p) => (
          <div key={p.runId}>
            <div className="flex items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 font-medium">
                <Dot color={p.dot} />
                {p.heading}
              </p>
              {p.text !== null && (
                <CopyButton
                  value={p.text}
                  className={copyButtonClass}
                  aria-label={`Copy ${p.label.toLowerCase()} ${title.toLowerCase()}`}
                  title={`Copy ${p.label.toLowerCase()} ${title.toLowerCase()}`}
                />
              )}
            </div>
            <Value text={p.text} empty={empty} />
          </div>
        ))}
      </div>
    </DiffBox>
  );
}

/** A run's output as one side of a diff, or why it has none. */
function outputSide(side: Side): DiffSide {
  const common = { label: side.label, tag: side.tag, dot: side.dot };
  const r = side.result;
  if (!r) return { ...common, text: null, missing: "No result in this run" };
  const taskError = taskErrorOf(r);
  return {
    ...common,
    text: side.shown?.output ?? null,
    // A failed task says so above its output, so "No output" would only repeat it.
    missing: taskError === null ? "No output" : "",
    error: taskError === null ? null : { label: CELL_STATE_LABEL.task_error, message: taskError },
  };
}

/**
 * The case at the root of the trace panel in diff mode, in the panel's own boxes: its input
 * and expected output (once, or per run when they differ), both runs' outputs compared word
 * by word (or the candidate against the expected output), every scorer's value on both runs
 * with its explanation, error and the change, and each run's usage, folded away.
 */
export function CaseDetail({
  model,
  row,
  pair,
  tagOf,
  dotFor,
  mode,
  onModeChange,
  usage,
}: {
  model: CompareModel;
  row: CaseRow;
  pair: readonly [string, string];
  tagOf: (runId: string) => string;
  dotFor: (runId: string) => string;
  /** How the outputs are compared; the trace panel keeps it across cases. */
  mode: OutputMode;
  onModeChange: (mode: OutputMode) => void;
  usage: [UsageSide, UsageSide];
}) {
  const [baselineId, candidateId] = pair;
  const comparison = React.useMemo(
    () => compareCase(model, row.key, baselineId, candidateId),
    [model, row.key, baselineId, candidateId],
  );

  // Decoding and canonicalizing a long output isn't free: once per result, not per render.
  const baselineResult = row.byRun.get(baselineId);
  const candidateResult = row.byRun.get(candidateId);
  const baselineShown = React.useMemo(() => shownOf(baselineResult), [baselineResult]);
  const candidateShown = React.useMemo(() => shownOf(candidateResult), [candidateResult]);

  const side = (label: Side["label"], runId: string, result: ResultRow | undefined): Side => ({
    label,
    runId,
    tag: tagOf(runId),
    heading: `${label} · ${tagOf(runId)}`,
    dot: dotFor(runId),
    result,
    shown: label === "Baseline" ? baselineShown : candidateShown,
  });
  const baseline = side("Baseline", baselineId, baselineResult);
  const candidate = side("Candidate", candidateId, candidateResult);
  if (!baseline.result && !candidate.result) {
    return <p className="text-muted-foreground">Neither run has a result for this case.</p>;
  }

  // The candidate is held to the expected output its own result recorded, even when that is
  // none; the baseline's stands in only when the candidate has no result for the case.
  const expectedSide: DiffSide = {
    label: "Expected",
    text: (candidate.shown ?? baseline.shown)?.expected ?? null,
    missing: "No expected output",
  };

  return (
    <>
      <SharedValue
        title="Input"
        sides={[baseline, candidate]}
        get={(v) => v.input}
        sameOn={(v) => v.inputKey}
        empty="No input"
      />
      <DiffBox
        title="Output"
        actions={
          <DiffChoice
            label="Output view"
            options={OUTPUT_MODES}
            value={mode}
            onChange={onModeChange}
          />
        }
      >
        {mode === "vs_expected" ? (
          <ValueDiff before={expectedSide} after={outputSide(candidate)} layout="columns" />
        ) : (
          <ValueDiff
            before={outputSide(baseline)}
            after={outputSide(candidate)}
            layout={mode === "inline" ? "inline" : "columns"}
          />
        )}
      </DiffBox>
      <SharedValue
        title="Expected"
        sides={[baseline, candidate]}
        get={(v) => v.expected}
        sameOn={(v) => v.expectedKey}
        empty="No expected output"
      />
      <DiffBox title="Scores" flush={model.scorers.length > 0}>
        {model.scorers.length === 0 ? (
          <p className="text-muted-foreground">No scores were recorded.</p>
        ) : (
          <ScoresTable
            scorers={model.scorers}
            baseline={baseline}
            candidate={candidate}
            comparison={comparison}
          />
        )}
      </DiffBox>
      <UsageDetails sides={usage} />
    </>
  );
}
