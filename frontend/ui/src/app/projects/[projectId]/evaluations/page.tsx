"use client";

import { useParams } from "next/navigation";
import { EvaluationsView } from "@/features/evaluations/views/evaluations-view";

export default function EvaluationsPage() {
  const params = useParams();
  return <EvaluationsView projectId={params.projectId as string} />;
}
