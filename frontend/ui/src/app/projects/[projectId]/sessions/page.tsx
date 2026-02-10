"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Workflow, Users, Layers } from "lucide-react";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { cn } from "@/lib/utils";

const tabs = [
  { id: "traces", label: "Traces", icon: Workflow, href: "traces" },
  { id: "users", label: "Users", icon: Users, href: "users" },
  { id: "sessions", label: "Sessions", icon: Layers, href: "sessions" },
];

export default function SessionsPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const projectId = params.projectId as string;

  // Build URL with preserved filter and pagination params
  const buildUrlWithFilters = (path: string) => {
    const urlParams = new URLSearchParams();

    // Preserve pagination params
    const pageIndex = searchParams.get("page_index");
    const pageLimit = searchParams.get("page_limit");

    if (pageIndex) urlParams.set("page_index", pageIndex);
    if (pageLimit) urlParams.set("page_limit", pageLimit);

    // Preserve date filter params
    const dateFilter = searchParams.get("date_filter");
    const start = searchParams.get("start");
    const end = searchParams.get("end");

    if (dateFilter) urlParams.set("date_filter", dateFilter);
    if (start) urlParams.set("start", start);
    if (end) urlParams.set("end", end);

    const queryString = urlParams.toString();
    return queryString ? `${path}?${queryString}` : path;
  };

  return (
    <div className="relative flex h-full text-[13px]">
      <ProjectBreadcrumb projectId={projectId} />

      {/* Main content */}
      <div className="flex flex-1 flex-col">
        {/* Tab navigation */}
        <div className="border-b border-border bg-background">
          <div className="flex">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = tab.id === "sessions";
              return (
                <Link
                  key={tab.id}
                  href={buildUrlWithFilters(`/projects/${projectId}/${tab.href}`)}
                  className={cn(
                    "flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-[13px] font-medium transition-colors",
                    isActive
                      ? "border-foreground bg-muted text-foreground"
                      : "border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {tab.label}
                </Link>
              );
            })}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto bg-background">
          <div className="flex h-64 flex-col items-center justify-center gap-3">
            <Layers className="h-10 w-10 text-muted-foreground" />
            <p className="text-[13px] text-muted-foreground">Sessions view coming soon</p>
          </div>
        </div>
      </div>
    </div>
  );
}
