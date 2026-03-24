"use client";

import { type ReactNode, useEffect, useState } from "react";
import Link from "next/link";
import {
  type LucideIcon,
  SlidersHorizontal,
  Users,
  Puzzle,
  CreditCard,
  Bot,
  Key,
  ArrowLeftRight,
} from "lucide-react";
import { cn } from "@/lib/utils";

const LAST_PROJECT_KEY = "traceroot:lastProjectSettings";

interface SettingsTab {
  id: string;
  label: string;
  icon: LucideIcon;
  href: string;
}

export const WORKSPACE_SETTINGS_TABS: SettingsTab[] = [
  { id: "general", label: "General", icon: SlidersHorizontal, href: "general" },
  { id: "members", label: "Members", icon: Users, href: "members" },
  { id: "model-providers", label: "Model Providers", icon: Bot, href: "model-providers" },
  { id: "integrations", label: "Integrations", icon: Puzzle, href: "integrations" },
  { id: "billing", label: "Billing", icon: CreditCard, href: "billing" },
];

export const PROJECT_SETTINGS_TABS: SettingsTab[] = [
  { id: "general", label: "General", icon: SlidersHorizontal, href: "general" },
  { id: "accessKeys", label: "API Keys", icon: Key, href: "accessKeys" },
];

interface CrossLink {
  label: string;
  href: string;
}

interface SettingsLayoutProps {
  tabs: SettingsTab[];
  activeTab: string;
  basePath: string;
  children: ReactNode;
  /** Optional link at the bottom of the sidebar to navigate to the other settings context. */
  crossLink?: CrossLink;
}

export function SettingsLayout({
  tabs,
  activeTab,
  basePath,
  children,
  crossLink,
}: SettingsLayoutProps) {
  const [resolvedCrossLink, setResolvedCrossLink] = useState<CrossLink | undefined>(crossLink);

  useEffect(() => {
    // On project settings pages — save this projectId so workspace settings can link back directly.
    const projectMatch = basePath.match(/\/projects\/([^/]+)/);
    if (projectMatch) {
      sessionStorage.setItem(LAST_PROJECT_KEY, `/projects/${projectMatch[1]}/settings/general`);
      // Sync state when crossLink arrives asynchronously (useProject resolves after mount).
      setResolvedCrossLink(crossLink);
    }

    // On workspace settings pages — if the user previously visited a project settings page,
    // override the generic "projects list" crossLink with a direct link back to that project.
    const isWorkspacePage = /\/workspaces\//.test(basePath);
    if (isWorkspacePage && crossLink) {
      const lastProjectHref = sessionStorage.getItem(LAST_PROJECT_KEY);
      setResolvedCrossLink(
        lastProjectHref ? { label: "Project Settings", href: lastProjectHref } : crossLink,
      );
    }
  }, [basePath, crossLink]);

  return (
    <>
      <nav className="flex w-40 flex-col border-r">
        <ul className="flex-1">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <li key={tab.id}>
                <Link
                  href={`${basePath}/${tab.href}`}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-[13px] transition-colors",
                    tab.id === activeTab ? "bg-muted" : "hover:bg-muted/50",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {tab.label}
                </Link>
              </li>
            );
          })}
        </ul>

        {resolvedCrossLink && (
          <div className="border-t p-2">
            <Link
              href={resolvedCrossLink.href}
              className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-[13px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            >
              <ArrowLeftRight className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{resolvedCrossLink.label}</span>
            </Link>
          </div>
        )}
      </nav>

      <div className="flex-1 overflow-auto p-6">{children}</div>
    </>
  );
}
