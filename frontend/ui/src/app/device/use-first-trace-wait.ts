"use client";

import { useCallback, useMemo, useRef } from "react";
import type { TraceApiUser } from "@/lib/api/client";
import {
  captureTraceBaseline,
  findFirstTrace,
  retryUnknownBaseline,
  type TraceBaseline,
} from "@/lib/first-trace";
import { useTraceWait, type RoundResult, type TraceWait } from "@/lib/hooks/use-trace-wait";
import type { Project, Workspace } from "@/types/api";
import { readWatchedProjects, watchOrder } from "./first-trace";

/**
 * How many rounds may find nowhere to look before the wait stops early.
 *
 * Reaching the approved panel means the account had a project a moment ago, so
 * a round that turns up no project at all is a round that could not read the
 * account rather than an account with nothing in it. Spinning out the full
 * budget on that tells the person less than saying so does, and a couple of
 * rounds of slack keeps a single network blip from ending the wait.
 *
 * The onboarding page needs no equivalent: it was handed a project id, so a
 * round of its own can never find nowhere to look.
 */
export const MAX_BARREN_ROUNDS = 3;

const WORKSPACES_URL = "/workspaces";

function fallbackUrlFor(projects: Project[]): string {
  const newest = projects[0];
  return newest ? `/projects/${encodeURIComponent(newest.id)}/traces` : WORKSPACES_URL;
}

/**
 * Watch for the first trace the terminal this tab just authorized sends, and
 * report where that wait stands.
 *
 * The pacing, the budget and the cancellation are `useTraceWait`'s. What is
 * here is the part only this page has to do: find the projects to watch at all.
 * Approval is the *first* step of the run, so the project is chosen — or
 * created — afterwards, and every round has to go looking again.
 *
 * The approval already happened before `active` turns true, so nothing here can
 * gate or alter it. The terminal stays the authority on how the run turned out;
 * whatever this reports, the panel keeps pointing the person back to it.
 */
export function useFirstTraceWait(
  active: boolean,
  workspaces: Workspace[],
  user: TraceApiUser | undefined,
): TraceWait {
  // The round reads these through refs so a re-render with an
  // equivalent-but-new workspace array or session object does not restart the
  // wait, and with it the baseline.
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  const userRef = useRef(user);
  userRef.current = user;

  // Identity that genuinely should restart the wait: a different account, or a
  // different set of places to look.
  const workspaceKey = useMemo(() => workspaces.map((w) => w.id).join(","), [workspaces]);

  const beginWait = useCallback((isCancelled: () => boolean) => {
    let baseline: TraceBaseline | null = null;
    // Whether the listing the baseline was drawn from was the whole account.
    // When it was not, a project turning up later may be one that was there all
    // along, so absence from the baseline stops meaning "the terminal made it".
    let baselineIsWholeAccount = false;
    let barrenRounds = 0;

    return async function round(): Promise<RoundResult | null> {
      const { projects, complete } = await readWatchedProjects(workspacesRef.current);
      if (isCancelled()) {
        return null;
      }
      const fallbackUrl = fallbackUrlFor(projects);

      if (projects.length === 0) {
        barrenRounds += 1;
        return barrenRounds >= MAX_BARREN_ROUNDS
          ? { kind: "stop", fallbackUrl }
          : { kind: "again", fallbackUrl };
      }
      barrenRounds = 0;

      if (baseline === null) {
        // First round draws the line and stops there. Nothing the run produces
        // can have arrived in the instant between approval and this read, so
        // treating anything already present as the run's trace would land the
        // tab on an unrelated trace from the same workspace.
        baseline = await captureTraceBaseline(
          projects.map((project) => project.id),
          userRef.current,
        );
        baselineIsWholeAccount = complete;
        return isCancelled() ? null : { kind: "again", fallbackUrl };
      }

      if (!baselineIsWholeAccount) {
        // The line was drawn across part of the account, so a project showing
        // up now is as likely to be one that was hidden then as one the
        // terminal has just made — and treating a hidden one as new would make
        // its months-old traces qualify and send the tab to the wrong trace
        // entirely. Drawing its line on first sight costs only the ranking in
        // `watchOrder`: a project the terminal really did just create reads as
        // empty, so anything that arrives in it still qualifies.
        const unlined = projects
          .map((project) => project.id)
          .filter((projectId) => !baseline?.has(projectId));
        if (unlined.length > 0) {
          baseline = new Map([
            ...baseline,
            ...(await captureTraceBaseline(unlined, userRef.current)),
          ]);
          if (isCancelled()) {
            return null;
          }
        }
      }

      // Any project whose baseline read failed gets another go first: until it
      // settles, nothing in that project can match, and it may be the only one
      // the run will ever touch.
      baseline = await retryUnknownBaseline(baseline, userRef.current);
      if (isCancelled()) {
        return null;
      }

      const found = await findFirstTrace(watchOrder(projects, baseline), baseline, userRef.current);
      return found ? { kind: "found", found } : { kind: "again", fallbackUrl };
    };
  }, []);

  return useTraceWait(
    active,
    beginWait,
    `${workspaceKey}|${user?.id ?? ""}`,
    // Nowhere better to send someone until a round has read the account.
    WORKSPACES_URL,
  );
}
