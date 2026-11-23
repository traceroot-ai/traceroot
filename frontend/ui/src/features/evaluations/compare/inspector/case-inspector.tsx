"use client";

import * as React from "react";
import { useLayout } from "@/components/layout/app-layout";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";
import { TraceViewerPanel, type TraceDiffBaseline } from "@/features/traces/components";
import { normalizeForDiff } from "@/lib/eval/line-diff";
import { cn } from "@/lib/utils";
import { PendingTraceNotice } from "../../components/pending-trace-notice";
import { ReconstructedTraceTag } from "../../components/reconstructed-trace-tag";
import type { CaseRow, CompareModel } from "../model";
import { useCaseTrace, type CaseTrace } from "./case-traces";
import { PairPicker } from "./pair-picker";
import type { CaseInspectorState } from "./use-case-inspector";

export interface CaseInspectorProps {
  projectId: string;
  /** The comparison: its runs (either side of the pair is one of them) and scorers. */
  model: CompareModel;
  /** The case shown. */
  row: CaseRow;
  /** The table's rows in their current order, for previous/next. */
  rows: readonly CaseRow[];
  /** The two runs compared, `[baseline, candidate]`. */
  pair: readonly [string, string];
  tagOf: (runId: string) => string;
  dotFor: (runId: string) => string;
  /** Show another case (previous/next), keeping the pair. */
  onMove: (row: CaseRow) => void;
  /** Compare the case on other runs, or the same two swapped; the table is unaffected. */
  onChangePair: (pair: [string, string]) => void;
  onClose: () => void;
  /** Put focus back on the case's row once the panel has closed. */
  returnFocus: (row: CaseRow) => void;
}

/** The baseline's trace for the panel's diff mode, or why there is none to compare with. */
function diffTraceOf(
  side: CaseTrace,
  tag: string,
): Pick<TraceDiffBaseline, "trace" | "reconstructed" | "unavailable"> {
  switch (side.kind) {
    case "no_result":
      return { trace: null, unavailable: `${tag} has no result for this case` };
    case "pending":
      return { trace: null, unavailable: `${tag}'s trace is still being ingested` };
    case "reconstructed":
      return { trace: side.trace, reconstructed: true };
    case "reported":
      return side.trace
        ? { trace: side.trace }
        : { trace: null, unavailable: `Loading ${tag}'s trace…` };
  }
}

/**
 * One case of the comparison in the trace panel: the candidate's trace, in diff mode
 * against the baseline's. The table stays usable behind it; clicking another row shows
 * that case here instead.
 */
export function CaseInspector({
  projectId,
  model,
  row,
  rows,
  pair,
  tagOf,
  dotFor,
  onMove,
  onChangePair,
  onClose,
  returnFocus,
}: CaseInspectorProps) {
  const [fullscreen, setFullscreen] = React.useState(false);
  const contentRef = React.useRef<HTMLDivElement>(null);

  // Claim the assistant's slot while open, as the trace viewer does, so the page's assistant
  // rail and its resize handle step aside instead of painting over this panel.
  const { registerAiHost } = useLayout();
  React.useEffect(() => registerAiHost(), [registerAiHost]);

  const index = rows.indexOf(row);
  const previous = index > 0 ? rows[index - 1] : null;
  const next = index >= 0 && index < rows.length - 1 ? rows[index + 1] : null;

  const caseText = index >= 0 ? `Case ${index + 1} of ${rows.length}` : "Case";
  // Announced only when the case itself changes: filtering the table behind the open panel
  // moves the position without moving the case, and shouldn't be read out again.
  const latched = React.useRef({ row, text: caseText, n: 0 });
  if (latched.current.row !== row) {
    latched.current = { row, text: caseText, n: latched.current.n + 1 };
  }
  const announced = latched.current;

  const [baselineId, candidateId] = pair;
  const runOf = (runId: string) => model.runs.find((b) => b.run.id === runId)!.run;
  const baselineRun = runOf(baselineId);
  const candidateRun = runOf(candidateId);
  const baselineResult = row.byRun.get(baselineId);
  const candidateResult = row.byRun.get(candidateId);
  const input = (baselineResult ?? candidateResult ?? [...row.byRun.values()][0])?.input;
  const preview = React.useMemo(
    () => (input ? normalizeForDiff(input).replace(/\s+/g, " ").trim() : ""),
    [input],
  );

  // Only the open case's two traces are fetched.
  const { trace: baselineTrace } = useCaseTrace(projectId, baselineResult, baselineRun);
  const { fetch: candidateFetch, trace: candidateTrace } = useCaseTrace(
    projectId,
    candidateResult,
    candidateRun,
  );

  const baselineTag = tagOf(baselineId);
  const candidateTag = tagOf(candidateId);

  // With no trace of the candidate's to show, the panel says why in its place.
  const notice =
    candidateTrace.kind === "no_result" ? (
      <p className="px-4 pt-4 text-[12px] text-muted-foreground">
        {`${candidateTag} has no result for this case.`}
      </p>
    ) : candidateTrace.kind === "pending" ? (
      <PendingTraceNotice
        traceId={candidateTrace.traceId}
        isFetching={candidateFetch.isFetching}
        onRetry={() => candidateFetch.refetch()}
      />
    ) : undefined;
  const override = candidateTrace.kind === "reconstructed" ? candidateTrace.trace : undefined;
  const traceId =
    candidateTrace.kind === "reported" ? candidateTrace.traceId : (override?.trace_id ?? "");

  const diffBaseline: TraceDiffBaseline = {
    ...diffTraceOf(baselineTrace, baselineTag),
    sides: {
      baseline: { label: "Baseline", tag: baselineTag, dot: dotFor(baselineId) },
      candidate: { label: "Candidate", tag: candidateTag, dot: dotFor(candidateId) },
    },
  };

  return (
    <Drawer open onOpenChange={(open) => !open && onClose()}>
      <DrawerContent
        ref={contentRef}
        hideClose
        // In place, not portalled: full screen sizes itself with the app shell's
        // --app-header-h and --app-nav-w, which only resolve inside the shell.
        portal={false}
        width={
          fullscreen
            ? "w-[calc(100%-var(--app-nav-w))] max-md:w-full"
            : "w-full md:w-[70vw] md:min-w-[720px]"
        }
        className={cn(
          "max-w-none text-[12px] transition-[width,top] duration-200",
          // Full screen stays clear of the app header and sidebar, like the trace viewer.
          fullscreen && "top-[var(--app-header-h)] border-l-0 shadow-none",
        )}
        // Start on the panel itself, not on the first control in its header: moving to
        // another case shouldn't be one keypress away on open.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          contentRef.current?.focus();
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          returnFocus(row);
        }}
      >
        <TraceViewerPanel
          // No key: moving between cases updates the panel in place, its view, diff mode
          // and size kept, as stepping through results on run detail does.
          projectId={projectId}
          traceId={traceId}
          traceOverride={override}
          notice={notice}
          embedded
          hideDetectors
          headerItem={{
            title: (
              <>
                <DrawerTitle className="shrink-0 text-[13px] font-medium">{caseText}</DrawerTitle>
                <span key={announced.n} role="status" aria-live="polite" className="sr-only">
                  {announced.text}
                </span>
                <DrawerDescription className="truncate text-xs">
                  {preview || "No input"}
                </DrawerDescription>
              </>
            ),
            noun: "case",
            onFullscreenChange: setFullscreen,
          }}
          onNavigate={(direction) => {
            const to = direction === "up" ? previous : next;
            if (to) onMove(to);
          }}
          canNavigateUp={!!previous}
          canNavigateDown={!!next}
          onClose={onClose}
          defaultDiffOn
          diffBaseline={diffBaseline}
          diffToolbar={
            <PairPicker
              runs={model.runs}
              pair={pair}
              tagOf={tagOf}
              dotFor={dotFor}
              onChange={onChangePair}
            />
          }
          spanExtraTags={() => (override ? <ReconstructedTraceTag /> : null)}
        />
      </DrawerContent>
    </Drawer>
  );
}

/** The trace panel's place on the page: the hint the rows point screen readers to, and the
 *  panel itself while a case is open. */
export function InspectorHost({
  inspector,
  tagOf,
  dotFor,
}: {
  inspector: CaseInspectorState;
  tagOf: (runId: string) => string;
  dotFor: (runId: string) => string;
}) {
  const { openRow, pair } = inspector;
  return (
    <>
      <p id={inspector.hintId} className="sr-only">
        Press Enter to open this case.
      </p>
      {openRow && pair && (
        <CaseInspector
          projectId={inspector.projectId}
          model={inspector.model}
          row={openRow}
          rows={inspector.rows}
          pair={pair}
          tagOf={tagOf}
          dotFor={dotFor}
          onMove={inspector.move}
          onChangePair={inspector.setPair}
          onClose={inspector.close}
          returnFocus={inspector.returnFocus}
        />
      )}
    </>
  );
}
