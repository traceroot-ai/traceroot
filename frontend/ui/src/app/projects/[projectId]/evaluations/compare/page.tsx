"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { CompareRunsView } from "@/features/evaluations/views/compare-runs-view";

// Shareable comparison route: /evaluations/compare?runs=<id,id,…>&baseline=<id>.
// The static `compare` segment takes priority over the sibling `[runId]` route, so
// run-detail URLs are unaffected. The run set + baseline live in the URL so the view
// is shareable and works with browser back/forward.
export default function CompareRunsPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params.projectId as string;

  const runIds = (searchParams.get("runs") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const baselineId = searchParams.get("baseline");

  const setBaseline = (baseline: string | null) => {
    const q = new URLSearchParams();
    if (runIds.length) q.set("runs", runIds.join(","));
    if (baseline) q.set("baseline", baseline);
    const qs = q.toString();
    router.push(`/projects/${projectId}/evaluations/compare${qs ? `?${qs}` : ""}`);
  };

  return (
    <CompareRunsView
      projectId={projectId}
      runIds={runIds}
      baselineId={baselineId}
      onChangeBaseline={setBaseline}
    />
  );
}
