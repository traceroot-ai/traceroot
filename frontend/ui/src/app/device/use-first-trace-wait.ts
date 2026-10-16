"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { TraceApiUser } from "@/lib/api/client";
import type { Project, Workspace } from "@/types/api";
import {
  captureTraceBaseline,
  findFirstTrace,
  retryUnknownBaseline,
  type FirstTrace,
  type TraceBaseline,
} from "@/lib/first-trace";
import { readWatchedProjects, watchOrder } from "./first-trace";

/**
 * How long between rounds of looking.
 *
 * A round costs one project listing per workspace plus one trace read per
 * watched project, and trace reads come out of the same per-workspace budget as
 * the dashboard's. Ten seconds keeps a whole wait well inside the smallest
 * plan's allowance while still opening the trace within a few seconds of it
 * landing — and nobody is watching this tab in the meantime, because it just
 * sent them back to their terminal.
 */
export const POLL_INTERVAL_MS = 10_000;

/**
 * How long a tab will wait in total.
 *
 * Long enough to cover installing the SDK, instrumenting a service and running
 * it, and finite because a spinner with no end is the one outcome this wait
 * must never produce. When the budget runs out the tab says so.
 */
export const WAIT_BUDGET_MS = 10 * 60 * 1000;

/**
 * How many rounds may find nowhere to look before the wait stops early.
 *
 * Reaching the approved panel means the account had a project a moment ago, so
 * a round that turns up no project at all is a round that could not read the
 * account rather than an account with nothing in it. Spinning out the full
 * budget on that tells the person less than saying so does, and a couple of
 * rounds of slack keeps a single network blip from ending the wait.
 */
export const MAX_BARREN_ROUNDS = 3;

/**
 * Where the approved panel stands: still watching, settled on a trace, or
 * finished without one.
 *
 * `gave-up` carries somewhere to go, because a wait that ends empty still owes
 * the person a way into the product.
 */
export type TraceWait =
  | { kind: "waiting" }
  | { kind: "found"; found: FirstTrace }
  | { kind: "gave-up"; fallbackUrl: string };

const WORKSPACES_URL = "/workspaces";

function fallbackUrlFor(projects: Project[]): string {
  const newest = projects[0];
  return newest ? `/projects/${encodeURIComponent(newest.id)}/traces` : WORKSPACES_URL;
}

/**
 * Watch for the first trace the terminal this tab just authorized sends, and
 * report where that wait stands.
 *
 * Strictly additive, in both directions. The approval already happened before
 * `active` turns true, so nothing here can gate or alter it; and nothing here
 * writes, so a tab that is closed — or never opened — changes nothing about the
 * run. The terminal stays the authority on how the run turned out. Whatever
 * this hook reports, the panel keeps pointing the person back to it.
 *
 * The loop is a chain of timeouts rather than an interval, so a slow round
 * cannot overlap the next one, and `cancelled` closes over the whole chain so
 * an unmount stops it without a late state update.
 */
export function useFirstTraceWait(
  active: boolean,
  workspaces: Workspace[],
  user: TraceApiUser | undefined,
): TraceWait {
  const [wait, setWait] = useState<TraceWait>({ kind: "waiting" });

  // The loop reads these through refs so a re-render with an equivalent-but-new
  // workspace array or session object does not restart the wait — and with it
  // the baseline, which would then be drawn after the run had already started.
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  const userRef = useRef(user);
  userRef.current = user;

  // Identity that genuinely should restart the wait: a different account, or a
  // different set of places to look.
  const workspaceKey = useMemo(() => workspaces.map((w) => w.id).join(","), [workspaces]);

  useEffect(() => {
    if (!active) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let baseline: TraceBaseline | null = null;
    let barrenRounds = 0;
    const deadline = Date.now() + WAIT_BUDGET_MS;

    function giveUp(projects: Project[]) {
      setWait({ kind: "gave-up", fallbackUrl: fallbackUrlFor(projects) });
    }

    async function round(): Promise<void> {
      const projects = await readWatchedProjects(workspacesRef.current);
      if (cancelled) {
        return;
      }

      if (projects.length === 0) {
        barrenRounds += 1;
        if (barrenRounds >= MAX_BARREN_ROUNDS) {
          giveUp(projects);
          return;
        }
        schedule(projects);
        return;
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
        if (cancelled) {
          return;
        }
        schedule(projects);
        return;
      }

      // Any project whose baseline read failed gets another go first: until it
      // settles, nothing in that project can match, and it may be the only one
      // the run will ever touch.
      baseline = await retryUnknownBaseline(baseline, userRef.current);
      if (cancelled) {
        return;
      }

      const found = await findFirstTrace(watchOrder(projects, baseline), baseline, userRef.current);
      if (cancelled) {
        return;
      }
      if (found) {
        setWait({ kind: "found", found });
        return;
      }
      schedule(projects);
    }

    function schedule(projects: Project[]) {
      if (Date.now() + POLL_INTERVAL_MS > deadline) {
        giveUp(projects);
        return;
      }
      timer = setTimeout(() => {
        void round();
      }, POLL_INTERVAL_MS);
    }

    void round();

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
    // workspacesRef/userRef hold the current values; workspaceKey and the user
    // id are the identities a restart should actually follow.
  }, [active, workspaceKey, user?.id]);

  return wait;
}
