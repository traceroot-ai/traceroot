"use client";

import * as React from "react";
import { Trash2 } from "lucide-react";
import { Button, type ButtonProps } from "./button";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/provider";

export interface DeleteButtonProps extends Omit<ButtonProps, "variant"> {
  iconClassName?: string;
}

/**
 * Destructive delete button with Trash icon and text
 */
const DeleteButton = React.forwardRef<HTMLButtonElement, DeleteButtonProps>(
  ({ children, className, iconClassName, size = "sm", ...props }, ref) => {
    return (
      <Button
        ref={ref}
        variant="outline"
        size={size}
        className={cn("border-destructive text-destructive hover:bg-destructive/10", className)}
        {...props}
      >
        <Trash2 className={cn("mr-2 h-3.5 w-3.5", iconClassName)} />
        {children}
      </Button>
    );
  },
);
DeleteButton.displayName = "DeleteButton";

/**
 * Icon-only delete button for table rows
 */
const DeleteIconButton = React.forwardRef<HTMLButtonElement, Omit<ButtonProps, "variant" | "size">>(
  ({ className, ...props }, ref) => {
    const t = useT();
    return (
      <Button
        ref={ref}
        variant="ghost"
        size="sm"
        className={cn("h-7 w-7 p-0", className)}
        {...props}
        aria-label={props["aria-label"] ?? props.title ?? t("common.delete")}
        title={props.title ?? props["aria-label"] ?? t("common.delete")}
      >
        <Trash2 className="h-4 w-4 text-destructive" />
      </Button>
    );
  },
);
DeleteIconButton.displayName = "DeleteIconButton";

export { DeleteButton, DeleteIconButton };
