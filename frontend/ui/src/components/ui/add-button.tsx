import * as React from "react";
import { Button, type ButtonProps } from "./button";

export type AddButtonProps = ButtonProps;

/** The one create-button: primary, small, sentence-case label, no icon. */
const AddButton = React.forwardRef<HTMLButtonElement, AddButtonProps>(
  ({ variant = "default", size = "sm", ...props }, ref) => {
    return <Button ref={ref} variant={variant} size={size} {...props} />;
  },
);
AddButton.displayName = "AddButton";

export { AddButton };
