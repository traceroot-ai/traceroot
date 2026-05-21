"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { IntegrationOption } from "./integrations";

interface IntegrationPickerCardProps {
  integration: IntegrationOption;
  selected: boolean;
  onSelect: () => void;
}

export function IntegrationPickerCard({
  integration,
  selected,
  onSelect,
}: IntegrationPickerCardProps) {
  const { name, logo, logoDark } = integration;

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "group flex items-center gap-2.5 rounded-xl border p-3 text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        selected ? "border-primary bg-primary/5" : "border-border bg-card hover:border-primary",
      )}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
        <img
          src={logo}
          alt=""
          className={cn("h-5 w-5 object-contain", logoDark && "dark:hidden")}
        />
        {logoDark && (
          <img src={logoDark} alt="" className="hidden h-5 w-5 object-contain dark:block" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{name}</span>
      {selected && <Check className="h-4 w-4 shrink-0 text-primary" />}
    </button>
  );
}
