"use client";

import Link from "next/link";
import { useLayout } from "@/components/layout/app-layout";
import { useLoopRuns } from "../hooks/use-loops";

/** How many of the latest runs are named. */
const LATEST_RUNS_NAMED = 3;

/**
 * Which of the Loop's runs recorded this signal, newest first: "Seen in run #12",
 * or "Seen in 5 runs · latest #12, #9, #7" when it was found again. The count is
 * the route's total, so it holds however many runs there are. Each number opens
 * that run's transcript on the Loop's page, where its evidence is.
 * Renders nothing before any run is linked to it, or where loops are switched off.
 */
export function FoundInRuns({
  projectId,
  loop,
  signalId,
}: {
  projectId: string;
  /** The Loop that recorded the signal. */
  loop: { id: string; name: string };
  signalId: string;
}) {
  const { loopsEnabled } = useLayout();
  const { data } = useLoopRuns(
    projectId,
    loop.id,
    { signalId, limit: LATEST_RUNS_NAMED },
    { enabled: loopsEnabled },
  );
  if (!loopsEnabled || !data || data.data.length === 0) return null;
  const total = data.meta.total;
  const runLink = (run: { id: string; seq: number }) => (
    <Link
      href={`/projects/${projectId}/loops/${loop.id}?run=${run.id}`}
      className="text-foreground hover:underline"
      aria-label={`Open run #${run.seq} of ${loop.name}`}
    >
      #{run.seq}
    </Link>
  );
  if (total === 1) return <span>Seen in run {runLink(data.data[0])}</span>;
  return (
    <span>
      Seen in {total} runs · latest{" "}
      {data.data.map((run, i) => (
        <span key={run.id}>
          {i > 0 && ", "}
          {runLink(run)}
        </span>
      ))}
    </span>
  );
}
