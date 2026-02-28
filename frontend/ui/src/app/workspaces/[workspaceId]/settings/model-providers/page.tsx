"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { SlidersHorizontal, Users, Blocks, CreditCard, Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import { WorkspaceBreadcrumb } from "@/features/workspaces/components";
import { ModelProvidersTab } from "@/features/settings/workspace";

const settingsTabs = [
  { id: "general", label: "General", icon: SlidersHorizontal, href: "general" },
  { id: "members", label: "Members", icon: Users, href: "members" },
  { id: "model-providers", label: "Model Providers", icon: Bot, href: "model-providers" },
  { id: "integrations", label: "Integrations", icon: Blocks, href: "integrations" },
  { id: "billing", label: "Billing", icon: CreditCard, href: "billing" },
] as const;

export default function WorkspaceSettingsModelProvidersPage() {
  const params = useParams();
  const workspaceId = params.workspaceId as string;

  return (
    <div className="flex h-full">
      <WorkspaceBreadcrumb workspaceId={workspaceId} current="Settings" />

      <nav className="w-40 border-r">
        <ul>
          {settingsTabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <li key={tab.id}>
                <Link
                  href={`/workspaces/${workspaceId}/settings/${tab.href}`}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-[13px] transition-colors",
                    tab.id === "model-providers" ? "bg-muted" : "hover:bg-muted/50",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {tab.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="flex-1 overflow-auto p-6">
        <ModelProvidersTab workspaceId={workspaceId} />
      </div>
    </div>
  );
}
