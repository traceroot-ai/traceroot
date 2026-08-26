"use client";

import { useParams } from "next/navigation";
import { DatasetDetailView } from "@/features/evaluations/views/dataset-detail-view";

export default function DatasetDetailPage() {
  const params = useParams();
  return (
    <DatasetDetailView
      projectId={params.projectId as string}
      datasetId={params.datasetId as string}
    />
  );
}
