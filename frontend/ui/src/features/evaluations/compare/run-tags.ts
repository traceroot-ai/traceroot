/**
 * How the comparison page names a run: "#2", or "support-routing #2" when the compared
 * runs span evaluations (run numbers restart per evaluation).
 */
import type { RunDetail } from "../types";

type Tagged = {
  run: Pick<RunDetail, "id" | "runNumber" | "evaluationId" | "evaluationName" | "startedAt">;
};
type Labelled = { run: Pick<RunDetail, "id" | "candidateVersion"> };

export function runTagger(bundles: readonly Tagged[]): (runId: string) => string {
  // Evaluations are told apart by id, since two can share a name: the later one reads
  // "support-routing (2)". "Later" is by earliest run start, then id, never by the order the
  // runs are shown in, so making another run the baseline can't rename them.
  const first = new Map<string, { name: string; start: number }>();
  for (const { run } of bundles) {
    const start = Date.parse(run.startedAt);
    const known = first.get(run.evaluationId);
    if (!known) first.set(run.evaluationId, { name: run.evaluationName, start });
    else if (start < known.start) known.start = start;
  }
  const stable = [...first.entries()].sort(
    ([idA, a], [idB, b]) => a.start - b.start || (idA < idB ? -1 : idA > idB ? 1 : 0),
  );
  // The later one takes the first "(n)" that is neither an evaluation's own name nor a
  // label already given, so an evaluation actually named "support-routing (2)" still
  // reads as itself.
  const taken = new Set(stable.map(([, { name }]) => name));
  const seen = new Set<string>();
  const names = new Map<string, string>();
  for (const [id, { name }] of stable) {
    let label = name;
    if (seen.has(name)) {
      for (let n = 2; taken.has(label); n++) label = `${name} (${n})`;
      taken.add(label);
    }
    seen.add(name);
    names.set(id, label);
  }
  const spansEvaluations = names.size > 1;
  return (runId) => {
    const run = bundles.find((b) => b.run.id === runId)?.run;
    if (!run) return "";
    return `${spansEvaluations ? `${names.get(run.evaluationId)} ` : ""}#${run.runNumber}`;
  };
}

/** "#2 v3": a run's tag and candidate version, naming each value the table stacks. */
export function runLabeler(
  bundles: readonly Labelled[],
  tagOf: (runId: string) => string,
): (runId: string) => string {
  return (runId) => {
    const run = bundles.find((b) => b.run.id === runId)?.run;
    return run ? `${tagOf(runId)} ${run.candidateVersion}` : "";
  };
}
