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
 * oldest one in the account.
 */
export const MAX_WATCHED_PROJECTS = 3;

/** One round's answer to "where could the trace land?". */
export interface WatchedProjects {
  /** The projects to look in: newest created first, and capped. */
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
}

/**
 * The projects this account can see, newest first and capped.
 *
 * Re-read on every round rather than once, because the terminal may create its
 * project after approval — a project that does not exist yet is the single most
 * likely destination for the trace we are waiting for.
 *
 * A workspace that cannot be listed is skipped rather than failing the round:
 * one unreadable workspace must not blind the tab to a trace landing in
 * another. It is reported, though, because a partial listing is not the same
 * answer as a whole one.
 */
export async function readWatchedProjects(workspaces: Workspace[]): Promise<WatchedProjects> {
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
  return {
    projects: found
      .slice()
      .sort((a, b) => Date.parse(b.create_time) - Date.parse(a.create_time))
      .slice(0, MAX_WATCHED_PROJECTS),
    complete: !missedWorkspace && found.length <= MAX_WATCHED_PROJECTS,
  };
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
