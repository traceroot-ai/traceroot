"use client";

import { Button } from "../../button";
// TODO: scroll-area component needs to be implemented or imported properly
// import {
//   ScrollArea,
//   ScrollBar,
// } from "../../scroll-area";

// Temporary fallback - using div instead of ScrollArea
const ScrollArea = ({ className, children, ...props }: any) => (
  <div className={className} {...props}>
    {children}
  </div>
);
const ScrollBar = ({ className, ...props }: any) => (
  <div className={className} {...props} />
);
import { cn } from "../../../../lib/utils";
import type { ComponentProps } from "react";

export type SuggestionsProps = ComponentProps<typeof ScrollArea>;

export const Suggestions = ({
  className,
  children,
  ...props
}: SuggestionsProps) => (
  <ScrollArea className="w-full overflow-x-auto whitespace-nowrap" {...props}>
    <div className={cn("flex w-max flex-nowrap items-center gap-2", className)}>
      {children}
    </div>
    <ScrollBar className="hidden" orientation="horizontal" />
  </ScrollArea>
);

export type SuggestionProps = Omit<ComponentProps<typeof Button>, "onClick"> & {
  suggestion: string;
  onClick?: (suggestion: string) => void;
};

export const Suggestion = ({
  suggestion,
  onClick,
  className,
  variant = "outline",
  size = "sm",
  children,
  ...props
}: SuggestionProps) => {
  const handleClick = () => {
    onClick?.(suggestion);
  };

  return (
    <Button
      className={cn("cursor-pointer rounded-full px-4", className)}
      onClick={handleClick}
      size={size}
      type="button"
      variant={variant}
      {...props}
    >
      {children || suggestion}
    </Button>
  );
};
