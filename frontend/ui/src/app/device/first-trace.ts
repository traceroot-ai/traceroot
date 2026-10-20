/**
 * Which projects the device page watches for an authorized run's first trace,
 * and in what order.
 *
 * This is the part the device page cannot share with onboarding. The tab knows
 * the account and therefore its workspaces, but it does NOT know a project:
 * approval is the *first* step of the run, and the project is chosen — or
 * created — by the terminal afterwards. So there is no id to watch, only a set
 * of places a trace could land, and that set can grow while we watch.
 *
 * The search itself, and the baseline it compares against, live in
 * `lib/first-trace` and are shared with the onboarding page, which does know
 * its project.
 */
import { getProjects } from "@/lib/api/projects";
import type { TraceBaseline } from "@/lib/first-trace";
import type { Project, Workspace } from "@/types/api";

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
 * oldest one in the account. An older one it did resolve is not lost to the
 * cap, though: see `MAX_KEYED_PROJECTS`.
 */
export const MAX_WATCHED_PROJECTS = 3;

/**
 * How many projects past the newest few a round will also look in, because
 * each has gained an API key since the wait began.
 *
 * The run needs one. `traceroot setup` mints its keys in the project it settled
 * on right after sign-in, long before anything it instruments can send a trace,
 * and those keys are scoped to that project, so a project whose key count has
 * grown is where this run's traces will land, however old it is. A bare
 * `traceroot login` mints nothing and leaves the watch as it was.
 *
 * The rest of the allowance absorbs a teammate minting a key elsewhere in the
 * same minutes, and the cap keeps unrelated key churn across a large org from
 * reopening the fan-out `MAX_WATCHED_PROJECTS` exists to prevent.
 */
export const MAX_KEYED_PROJECTS = 3;

/**
 * Each project's API-key count the first time the wait saw it.
 *
 * Recorded on first sight and never moved, so a key minted at any point in the
 * wait still reads as growth against it. A project only ever seen after the
 * terminal minted into it reads as no growth, which leaves it exactly where it
 * would have been without this.
 */
export type KeyCounts = ReadonlyMap<string, number>;

/** One round's answer to "where could the trace land?". */
export interface WatchedProjects {
  /**
   * The projects to look in: the newest created first, capped, then any older
   * one that has gained a key since the wait began.
   */
  projects: Project[];
  /**
   * Whether this is the whole account, or only the part of it this round could
   * see.
   *
   * False when a workspace failed to list, and false when the account has more
   * projects than the cap keeps. Either way some project exists that this
   * listing does not name, so its absence from the listing says nothing about
   * when it was created — which is the one thing `watchOrder` reads absence as
   * meaning.
   */
  complete: boolean;
  /** The key counts the next round compares against. */
  keyCounts: KeyCounts;
}

/**
 * The projects this account can see, newest first and capped, plus any older
 * project the terminal has minted a key in.
 *
 * Re-read on every round rather than once, because the terminal may create its
 * project after approval — a project that does not exist yet is the single most
 * likely destination for the trace we are waiting for.
 *
 * The device flow never tells this tab which project the terminal chose, but
 * the listing already counts each project's keys, so the choice shows up here
 * without a single extra read: the chosen project's count goes up. Only a
 * project past the cap is added on that evidence. One inside it is already
 * watched, and stays exactly where it was.
 *
 * A workspace that cannot be listed is skipped rather than failing the round:
 * one unreadable workspace must not blind the tab to a trace landing in
 * another. It is reported, though, because a partial listing is not the same
 * answer as a whole one.
 */
export async function readWatchedProjects(
  workspaces: Workspace[],
  keyCounts: KeyCounts = new Map(),
): Promise<WatchedProjects> {
  const found: Project[] = [];
  let missedWorkspace = false;
  for (const workspace of workspaces) {
    try {
      found.push(...(await getProjects(workspace.id)));
    } catch {
      // Skipped, not fatal — see above.
      missedWorkspace = true;
    }
  }
  const byAge = found.slice().sort((a, b) => Date.parse(b.create_time) - Date.parse(a.create_time));
  const keyed = byAge
    .slice(MAX_WATCHED_PROJECTS)
    .filter((project) => gainedKey(project, keyCounts))
    .slice(0, MAX_KEYED_PROJECTS);

  const seen = new Map(keyCounts);
  for (const project of found) {
    if (!seen.has(project.id) && project.access_key_count !== undefined) {
      seen.set(project.id, project.access_key_count);
    }
  }

  return {
    projects: [...byAge.slice(0, MAX_WATCHED_PROJECTS), ...keyed],
    complete: !missedWorkspace && found.length <= MAX_WATCHED_PROJECTS,
    keyCounts: seen,
  };
}

/** Whether `project` holds more keys now than when the wait first saw it. */
function gainedKey(project: Project, keyCounts: KeyCounts): boolean {
  const before = keyCounts.get(project.id);
  return (
    before !== undefined &&
    project.access_key_count !== undefined &&
    project.access_key_count > before
  );
}

/**
 * The order to search the watched projects in: the ones that did not exist when
 * the wait began, then the rest.
 *
 * That ordering is the strongest binding available here. The device page cannot
 * name the run it authorized — nothing the terminal sends carries the device
 * code, so there is no field to match on — but a project that was absent from
 * the baseline is one the terminal made after approval, and its traces belong
 * to this run. Only after those come the projects that already existed, where
 * "arrived after approval" is all we have.
 *
 * Absence has to be made to mean that, though, and only the caller can do it:
 * a project missing from an incomplete listing was never observed rather than
 * newly created. `useFirstTraceWait` closes that gap by drawing a baseline for
 * such a project on first sight, which puts it in the second group here.
 *
 * The onboarding page needs no equivalent: it watches the project it created
 * itself, so there is nothing to rank and nothing left to infer.
 */
export function watchOrder(projects: Project[], baseline: TraceBaseline): string[] {
  const ids = projects.map((project) => project.id);
  return [...ids.filter((id) => !baseline.has(id)), ...ids.filter((id) => baseline.has(id))];
}
