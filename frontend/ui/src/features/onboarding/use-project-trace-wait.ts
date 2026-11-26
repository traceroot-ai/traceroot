"use client";

import { useCallback, useRef } from "react";
import type { TraceApiUser } from "@/lib/api/client";
import { getProjectFirstTraceTime } from "@/lib/api/projects";
import {
  captureTraceBaseline,
  findFirstTrace,
  retryUnknownBaseline,
  type FirstTrace,
  type TraceBaseline,
} from "@/lib/first-trace";
import { useTraceWait, type RoundResult, type TraceWait } from "@/lib/hooks/use-trace-wait";

/**
 * How many rounds in a row may fail to read the project before the wait stops
 * early.
 *
 * Either read can fail: the baseline, or the search after it. A project whose
 * baseline never settles can never match — `findFirstTrace` skips it, having no
 * line to compare against — and a search that cannot read finds nothing either,
 * so a session that expires mid-wait would otherwise spin out the whole ten
 * minutes and then report that no trace arrived, which is a claim about the run
 * that this tab is in no position to make. A couple of rounds of slack keeps a
 * single blip from ending the wait.
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
 * id and it is certain. A trace that turns up here is this project's, and this
 * project is the one the command on screen was built to fill.
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
  projectReadAt?: string,
): TraceWait {
  // Read through refs so a re-render with an equivalent-but-new session object
  // does not restart the wait, and with it the baseline.
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const userRef = useRef(user);
  userRef.current = user;

  const readAtRef = useRef(projectReadAt);
  readAtRef.current = projectReadAt;

  const beginWait = useCallback((isCancelled: () => boolean) => {
    const watched = projectIdRef.current;
    const fallbackUrl = fallbackUrlFor(watched);
    let baseline: TraceBaseline | null = null;
    const readAt = readAtRef.current;
    let unreadableRounds = 0;

    /** A round that could not read the project, which ends the wait at the limit. */
    function unreadable(): RoundResult {
      unreadableRounds += 1;
      return unreadableRounds >= MAX_UNREADABLE_ROUNDS
        ? { kind: "stop", fallbackUrl, unreadable: true }
        : { kind: "again", fallbackUrl };
    }

    return async function round(): Promise<RoundResult | null> {
      if (!watched) {
        return { kind: "stop", fallbackUrl };
      }
      const firstRead = baseline === null;
      baseline =
        baseline === null
          ? await captureTraceBaseline([watched], userRef.current)
          : await retryUnknownBaseline(baseline, userRef.current);
      if (isCancelled()) return null;
      const entry = baseline.get(watched);
      if (entry?.kind === "newest") {
        // A list read can race with the command on screen. Compare ingestion
        // against the server's project read, independent of the SDK's clock.
        let receivedAt: string | null = null;
        if (readAt) {
          try {
            receivedAt = await getProjectFirstTraceTime(watched);
          } catch {
            return unreadable();
          }
          if (isCancelled()) return null;
        }
        if (!receivedAt || !readAt || Date.parse(receivedAt) < Date.parse(readAt)) {
          return { kind: "already-received", fallbackUrl };
        }
        baseline = new Map([[watched, { kind: "empty" }]]);
      } else if (firstRead) return { kind: "again", fallbackUrl };

      if (entry?.kind === "unknown") {
        // Still no line, so there is nothing a search could match against and
        // nothing to gain by making one. Counted rather than acted on at once,
        // because one failed read is a blip and three in a row is a tab that
        // has stopped being able to read this account.
        return unreadable();
      }

      let found: FirstTrace | null;
      try {
        found = await findFirstTrace(watched, baseline, userRef.current);
      } catch {
        // A search that cannot read is the same blip-or-ending as a baseline
        // that cannot, so it counts the same way. Only a search that read the
        // project starts the count over.
        return unreadable();
      }
      unreadableRounds = 0;
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
