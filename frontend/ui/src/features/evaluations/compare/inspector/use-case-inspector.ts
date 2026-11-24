"use client";

import * as React from "react";
import { caseUrlToken, findCaseByToken } from "../case-token";
import type { CaseRow, CompareModel } from "../model";
import { openingCandidate, resolvePair } from "./pair";

/** The case open in the trace panel, by its URL token (`caseUrlToken`), and the two runs
 *  it is compared on, `[baseline, candidate]`; a null pair means the default pair. */
export interface InspectedCase {
  caseToken: string;
  pair: [string, string] | null;
}

/**
 * The comparison table's side of the trace panel: which row is open and on which two runs
 * (both from the URL), each row's way of opening it, moving and closing it, and putting
 * focus back on the row once it closes. The URL is the only state, so a reload or a
 * shared link reopens the same case on the same runs.
 */
export function useCaseInspector({
  projectId,
  model,
  rows,
  inspected,
  onInspect,
}: {
  projectId: string;
  model: CompareModel;
  /** The table's rows in their current order. */
  rows: readonly CaseRow[];
  inspected: InspectedCase | null;
  onInspect: (next: InspectedCase | null) => void;
}) {
  /** The table's scroll container, where the rows are looked up to take focus back. */
  const tableRef = React.useRef<HTMLDivElement>(null);
  const token = inspected?.caseToken ?? null;
  // A token no case has (a stale link, a run since removed) leaves the panel closed.
  const openRow = React.useMemo(
    () => (token ? findCaseByToken(model.cases, token) : null),
    [model.cases, token],
  );

  // The candidate last shown, so the next case opened without naming a run keeps it.
  const lastCandidate = React.useRef<string | null>(null);
  const pair = openRow ? resolvePair(model, inspected?.pair ?? null, lastCandidate.current) : null;
  const candidate = pair?.[1] ?? null;
  React.useEffect(() => {
    if (candidate) lastCandidate.current = candidate;
  }, [candidate]);

  // Rows only re-render when their own props change, so they share one open handler that
  // lives as long as the table and reads the latest model and onInspect when called.
  const latest = React.useRef({ model, onInspect });
  React.useEffect(() => {
    latest.current = { model, onInspect };
  });
  /** Open a case on the table's baseline and the run whose value was clicked, if any. */
  const onOpenRow = React.useCallback((row: CaseRow, clickedRunId: string | null) => {
    const { model, onInspect } = latest.current;
    const opening = openingCandidate(model, clickedRunId, lastCandidate.current);
    if (!opening) return;
    onInspect({ caseToken: caseUrlToken(row.key), pair: [model.baselineRunId, opening] });
  }, []);
  const move = (row: CaseRow) => onInspect({ caseToken: caseUrlToken(row.key), pair });
  const setPair = (next: [string, string]) => token && onInspect({ caseToken: token, pair: next });
  const close = () => onInspect(null);
  /** The id of the text telling a screen reader how to open a row. */
  const hintId = React.useId();
  const rowProps = (row: CaseRow) => ({
    open: row === openRow,
    onOpenRow,
    describedBy: hintId,
  });
  // Focus goes back to the case's row, scrolling the table only if the row is out of view.
  const returnFocus = (row: CaseRow) => {
    const el = tableRef.current?.querySelector<HTMLElement>(`tr[data-row="${row.order}"]`);
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView?.({ block: "nearest" });
  };

  return {
    projectId,
    model,
    rows,
    tableRef,
    hintId,
    rowProps,
    openRow,
    pair,
    move,
    setPair,
    close,
    returnFocus,
  };
}

export type CaseInspectorState = ReturnType<typeof useCaseInspector>;
