import * as React from "react";
import { Plus } from "lucide-react";
import { Button, buttonVariants, type ButtonProps } from "./button";
import { cn } from "@/lib/utils";

/** Class for create actions rendered as something other than a <button> (e.g. a Link). */
export function addButtonClassName(className?: string) {
  return cn(buttonVariants({ variant: "default", size: "sm" }), "h-7 gap-2 text-[12px]", className);
}

export interface AddButtonProps extends ButtonProps {
  iconClassName?: string;
}

/**
 * The one create-action button ("New detector", "New dataset", ...): filled
 * primary, plus icon, sentence-case label.
 */
const AddButton = React.forwardRef<HTMLButtonElement, AddButtonProps>(
  ({ children, className, iconClassName, variant = "default", size = "sm", ...props }, ref) => {
    return (
      <Button
        ref={ref}
        variant={variant}
        size={size}
        className={cn("h-7 text-[12px]", className)}
        {...props}
      >
        <Plus className={cn("mr-2 h-3 w-3", iconClassName)} />
        {children}
      </Button>
    );
  },
);
AddButton.displayName = "AddButton";

export { AddButton };
