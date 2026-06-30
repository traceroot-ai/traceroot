"use client";

import { useParams } from "next/navigation";
import { LayoutDashboard } from "lucide-react";
import { ProjectBreadcrumb } from "@/features/projects/components";

export default function DashboardPage() {
  const params = useParams();
  const projectId = params.projectId as string;

  return (
    <div className="relative flex h-full text-[13px]">
      <ProjectBreadcrumb projectId={projectId} />

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Page header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <h1 className="text-[13px] font-medium">Dashboard</h1>
        </div>

        {/* Coming soon placeholder */}
        <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-background">
          <LayoutDashboard className="h-8 w-8 text-muted-foreground/40" />
          <p className="text-[13px] text-muted-foreground">Coming soon</p>
          <p className="text-[12px] text-muted-foreground">
            The dashboard is under construction. Check back later.
          </p>
        </div>
      </div>
    </div>
  );
}
