"use client";

import * as React from "react";
import { Check, Info, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Small toast system.
 *
 * The repo has no toast library and no global mount point — the established
 * feedback pattern is inline `text-destructive` text tied to a mutation's
 * error state. Confirmation of a *transient, non-blocking* action (row
 * duplicated, baseline set) has no existing home, so this adds one without
 * pulling in `sonner`. Mount <ToastProvider> around the subtree that needs it.
 */

export type ToastTone = "default" | "success" | "warning";

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Milliseconds before auto-dismiss. */
  duration?: number;
}

interface ToastRecord extends ToastOptions {
  id: number;
}

interface ToastContextValue {
  toast: (options: ToastOptions) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

const TONE_ICON: Record<ToastTone, React.ComponentType<{ className?: string }>> = {
  default: Info,
  success: Check,
  warning: TriangleAlert,
};

const TONE_GLYPH: Record<ToastTone, string> = {
  default: "text-muted-foreground",
  success: "text-emerald-600 dark:text-emerald-400",
  warning: "text-amber-600 dark:text-amber-400",
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastRecord[]>([]);
  const nextId = React.useRef(0);
  const timers = React.useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = React.useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = React.useCallback(
    (options: ToastOptions) => {
      const id = nextId.current++;
      setToasts((current) => [...current, { ...options, id }]);
      const timer = setTimeout(() => dismiss(id), options.duration ?? 4000);
      timers.current.set(id, timer);
    },
    [dismiss],
  );

  // Clear pending timers if the provider unmounts mid-flight.
  React.useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((timer) => clearTimeout(timer));
      pending.clear();
    };
  }, []);

  const value = React.useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role="region"
        aria-label="Notifications"
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[340px] flex-col gap-2"
      >
        {toasts.map((item) => {
          const tone = item.tone ?? "default";
          const Icon = TONE_ICON[tone];
          return (
            <div
              key={item.id}
              role="status"
              aria-live="polite"
              className="pointer-events-auto flex items-start gap-2 rounded-md border border-border bg-popover px-3 py-2 shadow-md"
            >
              <Icon className={cn("mt-px h-3.5 w-3.5 shrink-0", TONE_GLYPH[tone])} />
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-medium text-foreground">{item.title}</p>
                {item.description && (
                  <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                    {item.description}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                aria-label="Dismiss notification"
                className="shrink-0 rounded-sm text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
