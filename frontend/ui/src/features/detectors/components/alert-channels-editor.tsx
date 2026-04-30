"use client";

import { X, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";

interface AlertChannelsEditorProps {
  emailAddresses: string[];
  onChange: (addresses: string[]) => void;
}

export function AlertChannelsEditor({ emailAddresses, onChange }: AlertChannelsEditorProps) {
  const add = () => onChange([...emailAddresses, ""]);
  const remove = (i: number) => onChange(emailAddresses.filter((_, idx) => idx !== i));
  const update = (i: number, value: string) =>
    onChange(emailAddresses.map((a, idx) => (idx === i ? value : a)));

  return (
    <div className="space-y-1.5">
      {emailAddresses.map((addr, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input
            type="email"
            value={addr}
            onChange={(e) => update(i, e.target.value)}
            placeholder="you@example.com"
            className="h-7 flex-1 text-[12px]"
          />
          <button
            type="button"
            onClick={() => remove(i)}
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Remove recipient"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <Plus className="h-3 w-3" />
        Add recipient
      </button>
    </div>
  );
}
