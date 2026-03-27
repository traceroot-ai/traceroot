"use client";

import { type ReactNode } from "react";
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
  /** Optional link to navigate to a related settings context (e.g. Org Settings from project). */
  crossLink?: CrossLink;
}

export function SettingsLayout({
  tabs,
  activeTab,
  basePath,
  children,
  crossLink,
}: SettingsLayoutProps) {
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

          {crossLink && (
            <li>
              <Link
                href={crossLink.href}
                className="flex w-full items-center gap-2 px-3 py-2 text-[13px] transition-colors hover:bg-muted/50"
              >
                <ArrowLeftRight className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{crossLink.label}</span>
              </Link>
            </li>
          )}
        </ul>
      </nav>

      <div className="flex-1 overflow-auto p-6">{children}</div>
    </>
  );
}
