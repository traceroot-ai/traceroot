"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { CompareRunsView } from "@/features/evaluations/views/compare-runs-view";

// Shareable comparison route: /evaluations/compare?baseline=<run>&candidate=<run>.
// The static `compare` segment takes priority over the sibling `[runId]` route, so
// run-detail URLs are unaffected. Baseline/candidate live in the URL so the view is
// shareable and works with browser back/forward.
export default function CompareRunsPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params.projectId as string;

  const setPair = (baseline: string | null, candidate: string | null) => {
    const q = new URLSearchParams();
    if (baseline) q.set("baseline", baseline);
    if (candidate) q.set("candidate", candidate);
    const qs = q.toString();
    router.push(`/projects/${projectId}/evaluations/compare${qs ? `?${qs}` : ""}`);
  };

  return (
    <CompareRunsView
      projectId={projectId}
      candidateId={searchParams.get("candidate")}
      baselineId={searchParams.get("baseline")}
      onChange={setPair}
    />
  );
}
