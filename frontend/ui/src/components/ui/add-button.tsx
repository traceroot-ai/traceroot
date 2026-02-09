import * as React from "react";
import { Plus } from "lucide-react";
import { Button, type ButtonProps } from "./button";
import { cn } from "@/lib/utils";

export interface AddButtonProps extends ButtonProps {
  iconClassName?: string;
}

const AddButton = React.forwardRef<HTMLButtonElement, AddButtonProps>(
  ({ children, className, iconClassName, variant = "outline", size = "sm", ...props }, ref) => {
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
