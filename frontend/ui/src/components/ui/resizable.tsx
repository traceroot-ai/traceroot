"use client";

import { Group, Panel, Separator } from "react-resizable-panels";
import { cn } from "@/lib/utils";

export function ResizablePanelGroup({ className, ...props }: React.ComponentProps<typeof Group>) {
  return <Group className={cn("flex h-full w-full", className)} {...props} />;
}

export function ResizablePanel({ ...props }: React.ComponentProps<typeof Panel>) {
  return <Panel {...props} />;
}

export function ResizableHandle({ className, ...props }: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      className={cn(
        "relative w-px flex-shrink-0 !cursor-col-resize bg-border/20 transition-colors hover:bg-border focus-visible:outline-none",
        className,
      )}
      {...props}
    />
  );
}
