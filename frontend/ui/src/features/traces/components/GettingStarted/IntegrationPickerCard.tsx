"use client";

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
        "group flex h-8 items-center gap-2 rounded-[2px] border px-3 text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        selected ? "border-brand-border bg-accent" : "border-border bg-background hover:bg-muted",
      )}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        <img
          src={logo}
          alt=""
          className={cn("h-4 w-4 object-contain", logoDark && "dark:hidden")}
        />
        {logoDark && (
          <img src={logoDark} alt="" className="hidden h-4 w-4 object-contain dark:block" />
        )}
      </span>
      <span className="whitespace-nowrap text-[13px] font-medium text-foreground">{name}</span>
    </button>
  );
}
