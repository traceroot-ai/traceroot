"use client";

import * as React from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { cn } from "@/lib/utils";

export function ResizablePanelGroup({ className, ...props }: React.ComponentProps<typeof Group>) {
  return <Group className={cn("flex h-full w-full", className)} {...props} />;
}

export function ResizablePanel({ ...props }: React.ComponentProps<typeof Panel>) {
  return <Panel {...props} />;
}

export function ResizableHandle({
  className,
  onPointerDown,
  ...props
}: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      className={cn(
        "relative z-50 w-px flex-shrink-0 cursor-ew-resize bg-transparent focus-visible:outline-none",
        "before:absolute before:left-1/2 before:top-0 before:h-full before:w-1 before:-translate-x-1/2",
        "before:bg-transparent before:transition-colors",
        "hover:before:bg-primary/30 active:before:bg-primary/50 data-[dragging=true]:before:bg-primary/50",
        className,
      )}
      onPointerDown={(event) => {
        const el = event.currentTarget;
        el.dataset.dragging = "true";

        const stop = () => {
          delete el.dataset.dragging;
          window.removeEventListener("pointerup", stop);
          window.removeEventListener("pointercancel", stop);
          window.removeEventListener("blur", stop);
        };

        window.addEventListener("pointerup", stop);
        window.addEventListener("pointercancel", stop);
        window.addEventListener("blur", stop);

        onPointerDown?.(event);
      }}
      {...props}
    />
  );
}
