"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LOOP_TEMPLATES } from "@traceroot/core/loops/pure";

interface TemplateChipsProps {
  /** Template id, or null for custom instructions. */
  value: string | null;
  onChange: (templateId: string | null) => void;
}

/** The template picker: one chip per template, plus Custom for the Loop's own instructions. */
export function TemplateChips({ value, onChange }: TemplateChipsProps) {
  const description =
    LOOP_TEMPLATES.find((t) => t.id === value)?.description ??
    "Write your own instructions for what this Loop should look for.";
  const chip = (id: string | null, label: string) => (
    <Button
      key={id ?? "custom"}
      type="button"
      size="sm"
      variant="outline"
      aria-pressed={value === id}
      onClick={() => onChange(id)}
      className={cn("h-7 text-[12px]", value === id && "border-brand bg-accent text-brand")}
    >
      {label}
    </Button>
  );
  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {LOOP_TEMPLATES.map((t) => chip(t.id, t.name))}
        {chip(null, "Custom")}
      </div>
      <p className="mt-2 min-h-[1rem] text-[12px] text-muted-foreground">{description}</p>
    </>
  );
}
