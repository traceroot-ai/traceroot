"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useDashboards } from "@/features/dashboards/hooks/use-dashboards";

export default function DashboardIndexPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.projectId as string;
  const { data: dashboards, error, refetch } = useDashboards(projectId);

  useEffect(() => {
    // The list endpoint lazily seeds the default Overview, so there is always
    // at least one dashboard once the query resolves.
    if (dashboards && dashboards.length > 0) {
      const target = dashboards.find((d) => d.isDefault) ?? dashboards[0];
      router.replace(`/projects/${projectId}/dashboard/${target.id}`);
    }
  }, [dashboards, projectId, router]);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px]">
        <span className="text-destructive">Failed to load dashboards — retry</span>
        <button
          type="button"
          onClick={() => void refetch()}
          className="rounded border border-border px-3 py-1 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">
      Loading dashboards…
    </div>
  );
}
