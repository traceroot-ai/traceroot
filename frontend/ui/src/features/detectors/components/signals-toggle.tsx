"use client";

import { Switch } from "@/components/ui/switch";

interface SignalsToggleProps {
  /** Unique id so the label/switch pair doesn't collide across forms. */
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

/**
 * Per-detector "generate signals" toggle, shared by the create form and the
 * edit panel. Turning it on groups hits detected from then on, never earlier
 * ones.
 */
export function SignalsToggle({ id, checked, onCheckedChange }: SignalsToggleProps) {
  return (
    <div className="flex flex-col gap-2 p-3">
      <label htmlFor={id} className="cursor-pointer text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">Generate signals</span>
        <br />
        Group related findings into signals.
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

/** The bordered "Signals" card holding the toggle, as on the other form sections. */
export function SignalsCard(props: SignalsToggleProps) {
  return (
    <div className="border border-border">
      <div className="border-b border-border bg-muted/50 px-3 py-1.5">
        <span className="text-[12px] font-medium text-muted-foreground">Signals</span>
      </div>
      <SignalsToggle {...props} />
    </div>
  );
}
