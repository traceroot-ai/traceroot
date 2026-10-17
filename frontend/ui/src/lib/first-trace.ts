/**
 * Finding the first trace a setup run produces, from the browser tab that
 * started it.
 *
 * Two pages watch for this, and they know different amounts about where to
 * look. The device page approves a terminal before that terminal has chosen a
 * project, so it has a *set* of places a trace could land and that set can grow
 * while it watches. The onboarding page made the project itself, so it has one
 * id and no guessing to do. What they share is everything after "which
 * projects": where each one stood when the wait began, and which row in it is
 * the trace the run produced.
 *
 * So this module takes project ids and never discovers them. Deciding what to
 * watch — and in what order — is the caller's, because only the caller knows
 * how firmly it can bind a trace to its own run.
 *
 * Everything here is a read. Neither page may create a workspace or a project
 * on the user's behalf (see the device page's own notes on why), so a wait that
 * finds nowhere to look simply finds nothing.
 */
import { getTraces } from "@/lib/api/traces";
import type { TraceApiUser } from "@/lib/api/client";
import type { TraceListItem } from "@/types/api";

/**
 * How many traces one probe reads from a project.
 *
 * The list comes back newest-first and there is no ascending order to ask for,
 * so reading a short page and taking its oldest qualifying row is how we land
 * on the run's *first* trace rather than whatever it has sent most recently.
 */
const PROBE_PAGE_SIZE = 10;

/**
 * What one project's trace list held when the wait began.
 *
 * `unknown` is its own answer rather than a missing entry, because absence from
 * the baseline means something else entirely — it means the project did not
 * exist yet — and conflating the two would rank a project we merely failed to
 * read above a project the terminal actually just created.
 */
export type BaselineEntry =
  | { kind: "newest"; at: string }
  | { kind: "empty" }
  | { kind: "unknown" };

/**
 * Where each watched project's trace list stood when the wait began: the line
 * between "was already here" and "arrived after the run started".
 *
 * The line is drawn with a value that came back with the traces rather than
 * with the browser's clock. A tab whose clock runs fast would otherwise filter
 * out the very trace it is waiting for, and one running slow would pounce on a
 * trace that predates the run — both compare a local `Date.now()` against a
 * timestamp stamped elsewhere. Comparing two `trace_start_time` values keeps
 * the comparison inside one column.
 *
 * Not inside one clock, though: `trace_start_time` is copied from a span's
 * start time, so it is the producing process's clock. Two services writing to
 * the same project with skewed clocks can therefore still hide a run's first
 * trace behind the baseline. Nothing in the trace list carries an ingestion
 * time to compare instead, and the skew that matters here is between two
 * processes the user is deploying together, which is a far narrower exposure
 * than one browser against the fleet.
 */
export type TraceBaseline = ReadonlyMap<string, BaselineEntry>;

/** The trace a wait settled on, and the project to open it in. */
export type FirstTrace = { projectId: string; traceId: string };

/**
 * The newest traces in a project, newest first, or an empty list when it has
 * none.
 *
 * No `start_after`: the window is whatever the plan's retention allows, which
 * is the same window the baseline was captured in. Passing a browser-clock
 * lower bound here is the mistake `TraceBaseline` exists to avoid.
 */
async function probeTraces(
  projectId: string,
  user: TraceApiUser | undefined,
  limit: number,
): Promise<TraceListItem[]> {
  const response = await getTraces(projectId, "", { page: 0, limit }, user);
  return response.data ?? [];
}

/**
 * Where each project's trace list stood at the moment the wait began.
 *
 * Captured once the run is under way, never before it: a snapshot taken while a
 * consent screen or a sign-up form sits unattended would go stale the longer
 * the person takes.
 *
 * A project that cannot be read is recorded as `unknown` rather than guessed
 * at. Nothing in it can win until the read succeeds, and the caller is expected
 * to come back for it — guessing "it had none" would let a trace that was
 * already there pass for the one the run produced.
 */
export async function captureTraceBaseline(
  projectIds: string[],
  user: TraceApiUser | undefined,
): Promise<TraceBaseline> {
  const baseline = new Map<string, BaselineEntry>();
  for (const projectId of projectIds) {
    try {
      const traces = await probeTraces(projectId, user, 1);
      const newest = traces[0]?.trace_start_time;
      baseline.set(projectId, newest ? { kind: "newest", at: newest } : { kind: "empty" });
    } catch {
      baseline.set(projectId, { kind: "unknown" });
    }
  }
  return baseline;
}

/**
 * Re-read the baseline for the projects whose first read failed, leaving the
 * settled ones alone.
 *
 * Without this a transient failure at the start of the run would stay with the
 * wait for its whole life, and the project it affected — quite possibly the
 * only one that matters — would never be able to produce a match.
 */
export async function retryUnknownBaseline(
  baseline: TraceBaseline,
  user: TraceApiUser | undefined,
): Promise<TraceBaseline> {
  const unknown = [...baseline]
    .filter(([, entry]) => entry.kind === "unknown")
    .map(([projectId]) => projectId);
  if (unknown.length === 0) {
    return baseline;
  }
  return new Map([...baseline, ...(await captureTraceBaseline(unknown, user))]);
}

/** The oldest of `traces` that started after `cut`, or null when none did. */
function firstTraceAfter(traces: TraceListItem[], cut: string | null): TraceListItem | null {
  const cutAt = cut === null ? null : Date.parse(cut);
  const after = traces.filter((trace) => {
    const at = Date.parse(trace.trace_start_time);
    // A row whose start time does not parse cannot be placed on either side of
    // the line. `trace_start_time` is typed as a plain string, so "" arrives
    // here without anything being wrong upstream — and left in, such a row is
    // the one no comparison can beat (every `<` against NaN is false), so on
    // the common path where there is no cut at all it would be returned as the
    // run's first trace and deep-linked to.
    if (Number.isNaN(at)) {
      return false;
    }
    return cutAt === null || at > cutAt;
  });
  if (after.length === 0) {
    return null;
  }
  // The page arrives newest-first, so its last qualifying row is the earliest
  // one we can see. A run that sent more than a page of traces between two
  // rounds would push its own first trace off the end — a bounded
  // imprecision, and always in the direction of a trace the same run produced.
  return after.reduce((earliest, trace) => {
    const gap = Date.parse(trace.trace_start_time) - Date.parse(earliest.trace_start_time);
    // Ties are broken on the id rather than on position, so which trace the
    // person lands on does not depend on how the server happened to order two
    // rows stamped in the same millisecond.
    return gap < 0 || (gap === 0 && trace.trace_id < earliest.trace_id) ? trace : earliest;
  });
}

/**
 * One round of looking: the first trace to arrive in any of `projectIds` since
 * the baseline was taken, or null when none has.
 *
 * The ids are searched in the order given and the first match wins, so a caller
 * that can rank its candidates should rank them before calling. A caller
 * watching exactly one project has nothing to rank and gets the only answer
 * there is.
 */
export async function findFirstTrace(
  projectIds: string[],
  baseline: TraceBaseline,
  user: TraceApiUser | undefined,
): Promise<FirstTrace | null> {
  for (const projectId of projectIds) {
    const entry = baseline.get(projectId);
    if (entry?.kind === "unknown") {
      // No line to compare against, so any trace here could be one that was
      // already present. Skipped until the baseline for it settles.
      continue;
    }
    let traces: TraceListItem[];
    try {
      traces = await probeTraces(projectId, user, PROBE_PAGE_SIZE);
    } catch {
      // One unreadable project does not end the round; another may hold the trace.
      continue;
    }
    const match = firstTraceAfter(traces, entry?.kind === "newest" ? entry.at : null);
    if (match) {
      return { projectId, traceId: match.trace_id };
    }
  }
  return null;
}

/** The dashboard's deep link to one trace, the destination a finished wait offers. */
export function traceUrl(found: FirstTrace): string {
  return `/projects/${encodeURIComponent(found.projectId)}/traces?traceId=${encodeURIComponent(
    found.traceId,
  )}`;
}
