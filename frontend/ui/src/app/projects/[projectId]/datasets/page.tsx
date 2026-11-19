"use client";

import { useParams } from "next/navigation";
import { DatasetsView } from "@/features/evaluations/views/datasets-view";

export default function DatasetsPage() {
  const params = useParams();
  return <DatasetsView projectId={params.projectId as string} />;
}
