"use client";

import { useParams } from "next/navigation";
import { EditAlertPage } from "@/features/alerts/components/edit-alert-page";

export default function EditAlertRoute() {
  const params = useParams();
  return (
    <EditAlertPage projectId={params.projectId as string} alertId={params.alertId as string} />
  );
}
