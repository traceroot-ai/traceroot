/**
 * Finding the first trace an authorized terminal produces, from the browser tab
 * that authorized it.
 *
 * The tab knows the account and therefore its workspaces, but it does NOT know
 * a project: approval is the *first* step of the run, and the project is chosen
 * — or created — by the terminal afterwards. So there is no id to watch, only a
 * set of places a trace could land, and that set can grow while we watch.
 *
 * Everything here is a read. The browser must not create a workspace or a
 * project (see the device page's own notes on why), so a wait that finds
 * nowhere to look simply finds nothing.
 */
import { getProjects } from "@/lib/api/projects";
import { getTraces } from "@/lib/api/traces";
import type { TraceApiUser } from "@/lib/api/client";
import type { Project, TraceListItem, Workspace } from "@/types/api";

/**
 * How many projects one round of a wait will look in.
 *
 * A fresh account has one. The cap is for the established account that happens
 * to authorize a terminal: polling every project it owns would turn one tab
 * into a fan-out across the whole org for as long as the tab stays open, and
 * trace reads share one rate-limit budget with the dashboard the person is
 * about to land in — a wait that throttles the destination it is heading for
 * has made things worse, not better. The newest projects are kept, because the
 * project a terminal just resolved is far likelier to be recent than to be the
 * oldest one in the account.
 */
export const MAX_WATCHED_PROJECTS = 3;

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
 * between "was already here" and "arrived after approval".
 *
 * The line is drawn with a value the server supplied rather than with the
 * browser's clock. A tab whose clock runs fast would otherwise filter out the
 * very trace it is waiting for, and one running slow would pounce on a trace
 * that predates the approval — both compare a local `Date.now()` against a
 * timestamp stamped elsewhere. Comparing two `trace_start_time` values from the
 * same column has no such failure mode.
 */
export type TraceBaseline = ReadonlyMap<string, BaselineEntry>;

/** The trace a wait settled on, and the project to open it in. */
export type FirstTrace = { projectId: string; traceId: string };

/**
 * The projects this account can see, newest first and capped.
 *
 * Re-read on every round rather than once, because the terminal may create its
 * project after approval — a project that does not exist yet is the single most
 * likely destination for the trace we are waiting for.
 *
 * A workspace that cannot be listed is skipped rather than failing the round:
 * one unreadable workspace must not blind the tab to a trace landing in
 * another.
 */
export async function readWatchedProjects(workspaces: Workspace[]): Promise<Project[]> {
  const found: Project[] = [];
  for (const workspace of workspaces) {
    try {
      found.push(...(await getProjects(workspace.id)));
    } catch {
      // Skipped, not fatal — see above.
    }
  }
  return found
    .slice()
    .sort((a, b) => Date.parse(b.create_time) - Date.parse(a.create_time))
    .slice(0, MAX_WATCHED_PROJECTS);
}

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
 * Captured after approval, never before it: reading a project list is not
 * something the approval should wait on, and a snapshot taken while the consent
 * screen sits unattended would go stale the longer the person takes to click.
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
 * Without this a transient failure at the moment of approval would stay with
 * the wait for its whole life, and the project it affected — quite possibly the
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
  const after =
    cut === null
      ? traces
      : traces.filter((trace) => Date.parse(trace.trace_start_time) > Date.parse(cut));
  if (after.length === 0) {
    return null;
  }
  // The page arrives newest-first, so its last qualifying row is the earliest
  // one we can see. A run that sent more than a page of traces between two
  // rounds would push its own first trace off the end — a bounded
  // imprecision, and always in the direction of a trace the same run produced.
  return after.reduce((earliest, trace) =>
    Date.parse(trace.trace_start_time) < Date.parse(earliest.trace_start_time) ? trace : earliest,
  );
}

/**
 * One round of looking: the first trace to arrive in any watched project since
 * the baseline was taken, or null when none has.
 *
 * Projects absent from the baseline are searched first, and that ordering is
 * the strongest binding available here. The device page cannot name the run it
 * authorized — nothing the terminal sends carries the device code, so there is
 * no field to match on — but a project that did not exist when the person
 * clicked Approve is one the terminal made, and its traces belong to this run.
 * Only after those come the projects that already existed, where "arrived after
 * approval" is all we have.
 */
export async function findFirstTrace(
  projects: Project[],
  baseline: TraceBaseline,
  user: TraceApiUser | undefined,
): Promise<FirstTrace | null> {
  const fresh = projects.filter((project) => !baseline.has(project.id));
  const known = projects.filter((project) => baseline.has(project.id));
  for (const project of [...fresh, ...known]) {
    const entry = baseline.get(project.id);
    if (entry?.kind === "unknown") {
      // No line to compare against, so any trace here could be one that was
      // already present. Skipped until the baseline for it settles.
      continue;
    }
    let traces: TraceListItem[];
    try {
      traces = await probeTraces(project.id, user, PROBE_PAGE_SIZE);
    } catch {
      // One unreadable project does not end the round; another may hold the trace.
      continue;
    }
    const match = firstTraceAfter(traces, entry?.kind === "newest" ? entry.at : null);
    if (match) {
      return { projectId: project.id, traceId: match.trace_id };
    }
  }
  return null;
}

/** The dashboard's deep link to one trace, the destination a finished wait opens. */
export function traceUrl(found: FirstTrace): string {
  return `/projects/${encodeURIComponent(found.projectId)}/traces?traceId=${encodeURIComponent(
    found.traceId,
  )}`;
}
