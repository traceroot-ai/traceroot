"use client";

import { useParams } from "next/navigation";
import { RunDetailView } from "@/features/evaluations/views/run-detail-view";

export default function RunDetailPage() {
  const params = useParams();
  const runId = params.runId as string;
  // Key on runId so switching runs (same dynamic route) fully remounts the view —
  // fresh data + reset panel/filter state — instead of reusing a stale instance.
  return <RunDetailView key={runId} projectId={params.projectId as string} runId={runId} />;
}
