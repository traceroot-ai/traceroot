"use client";

import { Switch } from "@/components/ui/switch";

interface RcaToggleProps {
  /** Unique id so the label/switch pair doesn't collide across forms. */
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

/**
 * Per-detector "run root cause analysis" toggle. Shared by the create form and
 * the edit panel so the label, copy, and layout stay in one place.
 */
export function RcaToggle({ id, checked, onCheckedChange }: RcaToggleProps) {
  return (
    <div className="mt-3 flex flex-col gap-2">
      <label htmlFor={id} className="cursor-pointer text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">Run root cause analysis on findings</span>
        <br />
        Uses the agent model when this detector fires. Turn off to reduce cost.
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}
