"use client";

import { type ReactNode } from "react";
import Link from "next/link";
import {
  type LucideIcon,
  SlidersHorizontal,
  Users,
  Blocks,
  CreditCard,
  Bot,
  Key,
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
  { id: "integrations", label: "Integrations", icon: Blocks, href: "integrations" },
  { id: "billing", label: "Billing", icon: CreditCard, href: "billing" },
];

export const PROJECT_SETTINGS_TABS: SettingsTab[] = [
  { id: "general", label: "General", icon: SlidersHorizontal, href: "general" },
  { id: "accessKeys", label: "API Keys", icon: Key, href: "accessKeys" },
];

interface SettingsLayoutProps {
  tabs: SettingsTab[];
  activeTab: string;
  basePath: string;
  children: ReactNode;
}

export function SettingsLayout({ tabs, activeTab, basePath, children }: SettingsLayoutProps) {
  return (
    <>
      <nav className="w-40 border-r">
        <ul>
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
      </nav>

      <div className="flex-1 overflow-auto p-6">{children}</div>
    </>
  );
}
