"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Right-anchored, NON-MODAL slide-in panel for multi-step flows.
 *
 * Built on @radix-ui/react-dialog (already a dependency) rather than adding
 * `vaul`: this reuses Radix's Escape handling and a11y wiring. It is deliberately
 * non-modal and backdrop-less so it reads as a side panel over a still-visible,
 * still-interactive page — the same treatment as the hand-built "Save as test
 * case" panel — rather than a dialog that greys the page out. It differs from
 * ui/dialog.tsx only in placement, sizing, and modality, so it lives beside it
 * instead of overloading DialogContent with a side variant.
 */

const Drawer = ({ modal = false, ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) => (
  <DialogPrimitive.Root modal={modal} {...props} />
);
const DrawerTrigger = DialogPrimitive.Trigger;
const DrawerClose = DialogPrimitive.Close;
const DrawerPortal = DialogPrimitive.Portal;

export interface DrawerContentProps extends React.ComponentPropsWithoutRef<
  typeof DialogPrimitive.Content
> {
  /** Tailwind width class for the panel. */
  width?: string;
}

const DrawerContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DrawerContentProps
>(({ className, children, width = "w-[720px]", ...props }, ref) => (
  <DrawerPortal>
    <DialogPrimitive.Content
      ref={ref}
      // Non-modal: a click on the page behind interacts with it (and never closes
      // this panel) — it closes only via Escape or the X, matching the "Save as test
      // case" panel. No overlay is rendered, so the page is never greyed out.
      onInteractOutside={(e) => e.preventDefault()}
      className={cn(
        "animate-slide-in-right fixed inset-y-0 right-0 z-50 flex max-w-[96vw] flex-col border-l border-border bg-background shadow-xl",
        "focus:outline-none",
        width,
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        className="absolute right-3 top-3 rounded-sm text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-1 focus:ring-ring"
        aria-label="Close"
      >
        <X className="h-4 w-4" />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DrawerPortal>
));
DrawerContent.displayName = "DrawerContent";

const DrawerHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("shrink-0 border-b border-border px-4 py-3", className)} {...props} />
);
DrawerHeader.displayName = "DrawerHeader";

const DrawerBody = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("min-h-0 flex-1 overflow-auto px-4 py-3", className)} {...props} />
);
DrawerBody.displayName = "DrawerBody";

const DrawerFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex shrink-0 items-center justify-between gap-2 border-t border-border px-4 py-3",
      className,
    )}
    {...props}
  />
);
DrawerFooter.displayName = "DrawerFooter";

const DrawerTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-[13px] font-semibold leading-none tracking-tight", className)}
    {...props}
  />
));
DrawerTitle.displayName = "DrawerTitle";

const DrawerDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-[12px] text-muted-foreground", className)}
    {...props}
  />
));
DrawerDescription.displayName = "DrawerDescription";

export {
  Drawer,
  DrawerTrigger,
  DrawerClose,
  DrawerPortal,
  DrawerContent,
  DrawerHeader,
  DrawerBody,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
};
