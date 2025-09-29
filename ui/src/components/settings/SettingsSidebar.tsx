import React from "react";
import { FaChartLine, FaCrown } from "react-icons/fa";
import { Cloud } from "lucide-react";

interface SettingsSidebarProps {
  activeTab: "usage" | "plan" | "provider";
  onTabChange: (tab: "usage" | "plan" | "provider") => void;
}

export function SettingsSidebar({
  activeTab,
  onTabChange,
}: SettingsSidebarProps) {
  const tabs = [
    {
      id: "provider" as const,
      label: "Provider",
      icon: Cloud,
      description: "Cloud Service Provider",
    },
    {
      id: "usage" as const,
      label: "Usage",
      icon: FaChartLine,
      description: "LLM Tokens and Trace Logs",
    },
    {
      id: "plan" as const,
      label: "Plan",
      icon: FaCrown,
      description: "Plan and Billing",
    },
  ];

  return (
    <div className="w-64 bg-background border-r border-border">
      <div className="p-4">
        <nav className="space-y-2">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;

            return (
              <button
                key={tab.id}
                onClick={() => onTabChange(tab.id)}
                className={`
                  w-full flex items-start space-x-3 p-3 rounded-md text-left transition-colors
                  ${
                    isActive
                      ? "bg-primary/10 text-primary border border-primary/20"
                      : "hover:bg-muted text-muted-foreground hover:text-foreground"
                  }
                `}
              >
                <Icon size={18} className="mt-0.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div
                    className={`text-sm font-medium ${isActive ? "text-primary" : ""}`}
                  >
                    {tab.label}
                  </div>
                  <div
                    className={`text-xs mt-0.5 ${isActive ? "text-primary/70" : "text-muted-foreground"}`}
                  >
                    {tab.description}
                  </div>
                </div>
              </button>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
