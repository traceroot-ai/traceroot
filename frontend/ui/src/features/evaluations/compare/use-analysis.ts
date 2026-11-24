"use client";

import * as React from "react";
import { DEBOUNCE_DELAY_MS } from "@/lib/hooks/use-keyword-search";
import type { CaseAnalysis } from "./filters";
import { serializeCompareUrl } from "./url-state";

/** The analysis as the URL writes it, so two that read the same compare equal. */
const urlForm = (a: CaseAnalysis) => serializeCompareUrl({ runs: [], baseline: null, ...a });

/**
 * The table's search, filters and sort. A change shows at once and is handed to
 * `onChange` (which writes the URL) once things have been still for a moment, so typing
 * a search writes the URL once rather than per key. One that arrives from the URL itself
 * (back or forward, a link) replaces what's on screen; this hook's own write coming back
 * doesn't, so typing carries on. `commit` takes an analysis the caller writes itself,
 * along with another change, so nothing is left to write after it.
 *
 * `place` names the runs and baseline the URL holds the analysis for. A new one, as on
 * back or forward to another entry, shows the URL's analysis even when it reads the same,
 * and drops a change not yet written, which belongs to the entry left.
 */
export function useCaseAnalysis(
  fromUrl: CaseAnalysis,
  onChange: ((next: CaseAnalysis) => void) | undefined,
  place: string,
): [CaseAnalysis, (next: CaseAnalysis) => void, (written: CaseAnalysis) => void] {
  const [analysis, setAnalysis] = React.useState(fromUrl);
  const urlKey = urlForm(fromUrl);
  // What the URL holds, and for which runs and baseline, as far as this hook knows.
  const committed = React.useRef(urlKey);
  const committedPlace = React.useRef(place);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = React.useRef({ fromUrl, onChange });
  latest.current = { fromUrl, onChange };

  React.useEffect(() => {
    if (urlKey === committed.current && place === committedPlace.current) return;
    committed.current = urlKey;
    committedPlace.current = place;
    clearTimeout(timer.current);
    setAnalysis(latest.current.fromUrl);
  }, [urlKey, place]);
  React.useEffect(() => () => clearTimeout(timer.current), []);

  const change = React.useCallback((next: CaseAnalysis) => {
    setAnalysis(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const key = urlForm(next);
      if (key === committed.current) return;
      committed.current = key;
      latest.current.onChange?.(next);
    }, DEBOUNCE_DELAY_MS);
  }, []);

  const commit = React.useCallback((written: CaseAnalysis) => {
    clearTimeout(timer.current);
    committed.current = urlForm(written);
    setAnalysis(written);
  }, []);

  return [analysis, change, commit];
}
