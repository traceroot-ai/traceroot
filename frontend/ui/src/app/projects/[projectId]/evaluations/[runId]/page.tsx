"use client";

import { useParams } from "next/navigation";
import { RunDetailView } from "@/features/evaluations/views/run-detail-view";

export default function RunDetailPage() {
  const params = useParams();
  return <RunDetailView projectId={params.projectId as string} runId={params.runId as string} />;
}
