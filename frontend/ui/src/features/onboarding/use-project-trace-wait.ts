"use client";

import { useCallback, useRef } from "react";
import type { TraceApiUser } from "@/lib/api/client";
import {
  captureTraceBaseline,
  findFirstTrace,
  retryUnknownBaseline,
  type TraceBaseline,
} from "@/lib/first-trace";
import { useTraceWait, type RoundResult, type TraceWait } from "@/lib/hooks/use-trace-wait";

/**
 * Watch one known project for the first trace a setup run sends it.
 *
 * This is the whole of what onboarding has to add to the shared wait, and it is
 * short because of what this page knows. It made the project, so there is one
 * id and it is certain: no listing every workspace on every round, no cap on
 * how many projects a round may look in, no ranking of which project the trace
 * probably belongs to, and no round that can find nowhere to look. A trace that
 * turns up here is this project's, and this project is the one the command on
 * screen was built to fill.
 *
 * The baseline stays, though, and is not ceremony. Creating a project is
 * idempotent on its name within a workspace (see lib/write-services/projects):
 * a run that lands on a name the workspace already uses is handed the existing
 * project back, traces and all. Without a line drawn first, such a run would
 * "find" a trace from last week in its first round. With one, a project that is
 * genuinely new simply reads as empty and anything that arrives qualifies.
 */
export function useProjectTraceWait(
  active: boolean,
  /** The project this page created. Null until it exists. */
  projectId: string | null,
  user: TraceApiUser | undefined,
): TraceWait {
  // Read through refs so a re-render with an equivalent-but-new session object
  // does not restart the wait, and with it the baseline.
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const userRef = useRef(user);
  userRef.current = user;

  const beginWait = useCallback((isCancelled: () => boolean) => {
    const watched = projectIdRef.current;
    // The project's own traces page: where this run's traces are going to land
    // whenever they do, and the right place to leave someone whose wait ended
    // with nothing. `active` is false without a project, so this is the
    // signed-out-of-the-question case rather than a reachable one.
    const fallbackUrl = watched ? `/projects/${encodeURIComponent(watched)}/traces` : "/workspaces";
    let baseline: TraceBaseline | null = null;

    return async function round(): Promise<RoundResult | null> {
      if (!watched) {
        return { kind: "stop", fallbackUrl };
      }
      if (baseline === null) {
        // Drawn before anything can match, exactly as the device page draws it
        // — and for the same reason, which here is a project that turned out
        // not to be new.
        baseline = await captureTraceBaseline([watched], userRef.current);
        // A tab that left part-way through a round does not go on to fetch the
        // rest of it.
        return isCancelled() ? null : { kind: "again", fallbackUrl };
      }
      // A baseline read that failed gets another go: until it settles nothing
      // in the project can match, and there is no second project to fall back
      // on.
      baseline = await retryUnknownBaseline(baseline, userRef.current);
      if (isCancelled()) {
        return null;
      }

      const found = await findFirstTrace([watched], baseline, userRef.current);
      return found ? { kind: "found", found } : { kind: "again", fallbackUrl };
    };
  }, []);

  return useTraceWait(
    active && projectId !== null,
    beginWait,
    `${projectId ?? ""}|${user?.id ?? ""}`,
  );
}
