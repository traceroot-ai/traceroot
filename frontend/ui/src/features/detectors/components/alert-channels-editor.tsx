"use client";

import { Mail, X, Plus } from "lucide-react";
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
    <>
      {/* Card header */}
      <div className="flex items-center justify-between border-b border-border bg-muted/50 px-3 py-1.5">
        <span className="text-[12px] font-medium text-muted-foreground">Alerts</span>
        <button
          type="button"
          onClick={add}
          className="flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <Plus className="h-3 w-3" />
          Add alert
        </button>
      </div>

      {/* Card body */}
      <div className="p-3">
        {emailAddresses.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            No alerts configured. Findings will be recorded but not sent anywhere.
          </p>
        ) : (
          <div className="space-y-1.5">
            {emailAddresses.map((addr, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <div className="flex h-7 w-[72px] shrink-0 items-center gap-1.5 rounded-sm border border-border bg-muted/40 px-2">
                  <Mail className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="text-[11px] text-muted-foreground">Email</span>
                </div>
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
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
