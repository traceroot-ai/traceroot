"use client";

import * as React from "react";
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Creation UI, modelled on the existing "Create Detector" flow.
 *
 * Create Detector uses bordered "cards" — a `bg-muted/50` label strip over a
 * padded body — inside a single flat form with a Save/Cancel footer. We render
 * that exact field style inside the shared `Drawer` primitive so New Dataset and
 * New Evaluation look native and open as an overlay rather than a new page.
 */

/** One labelled field, matching the detector form's bordered card. */
export function FormCard({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("border border-border", className)}>
      <div className="flex items-center justify-between border-b border-border bg-muted/50 px-3 py-1.5">
        <span className="text-[12px] font-medium text-muted-foreground">{label}</span>
        {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

/** Collapsed <details> for advanced/optional fields, matching the app's density. */
export function AdvancedSection({
  label = "Advanced",
  children,
}: {
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group border border-border">
      <summary className="flex cursor-pointer list-none items-center border-border bg-muted/50 px-3 py-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring group-open:border-b">
        {label}
      </summary>
      <div className="flex flex-col gap-3 p-3">{children}</div>
    </details>
  );
}

/**
 * The creation drawer shell: header + scrollable form body + Save/Cancel footer.
 * The caller supplies the fields and the save handler.
 */
export function CreateDrawer({
  title,
  open,
  onOpenChange,
  onSave,
  saveLabel = "Save",
  saveDisabled,
  children,
  width = "w-[560px]",
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: () => void;
  saveLabel?: string;
  saveDisabled?: boolean;
  children: React.ReactNode;
  width?: string;
}) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent width={width}>
        <DrawerHeader className="pr-10">
          <DrawerTitle>{title}</DrawerTitle>
        </DrawerHeader>
        <DrawerBody className="flex flex-col gap-3">{children}</DrawerBody>
        <DrawerFooter className="justify-end">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[12px]"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button size="sm" className="h-7 text-[12px]" onClick={onSave} disabled={saveDisabled}>
            {saveLabel}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
