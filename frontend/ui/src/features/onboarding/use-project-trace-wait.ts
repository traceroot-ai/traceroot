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
 * How many rounds may fail to read the project before the wait stops early.
 *
 * The device page's equivalent counts rounds that found nowhere to look; here
 * there is always somewhere, and what can fail is reading it. A project whose
 * baseline never settles can never match — `findFirstTrace` skips it, having no
 * line to compare against — so a session that expires mid-wait would otherwise
 * spin out the whole ten minutes and then report that no trace arrived, which
 * is a claim about the run that this tab is in no position to make. A couple of
 * rounds of slack keeps a single blip from ending the wait.
 */
export const MAX_UNREADABLE_ROUNDS = 3;

/**
 * Where to leave someone whose wait ended with nothing: the project's own
 * traces page, which is where this run's traces are going to land whenever they
 * do. `active` is false without a project, so the second branch is the
 * signed-out-of-the-question case rather than a reachable one.
 */
function fallbackUrlFor(projectId: string | null): string {
  return projectId ? `/projects/${encodeURIComponent(projectId)}/traces` : "/workspaces";
}

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
    const fallbackUrl = fallbackUrlFor(watched);
    let baseline: TraceBaseline | null = null;
    let unreadableRounds = 0;

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
      const settled = await retryUnknownBaseline(baseline, userRef.current);
      baseline = settled;
      if (isCancelled()) {
        return null;
      }

      if (settled.get(watched)?.kind === "unknown") {
        // Still no line, so there is nothing a search could match against and
        // nothing to gain by making one. Counted rather than acted on at once,
        // because one failed read is a blip and three in a row is a tab that
        // has stopped being able to read this account.
        unreadableRounds += 1;
        return unreadableRounds >= MAX_UNREADABLE_ROUNDS
          ? { kind: "stop", fallbackUrl, unreadable: true }
          : { kind: "again", fallbackUrl };
      }
      unreadableRounds = 0;

      const found = await findFirstTrace([watched], baseline, userRef.current);
      return found ? { kind: "found", found } : { kind: "again", fallbackUrl };
    };
  }, []);

  return useTraceWait(
    active && projectId !== null,
    beginWait,
    `${projectId ?? ""}|${user?.id ?? ""}`,
    fallbackUrlFor(projectId),
  );
}
