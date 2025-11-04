"use client";
import * as React from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface Navbar13Option<T = string> {
  value: T;
  name: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}

export interface Navbar13Props<T = string>
  extends React.HTMLAttributes<HTMLDivElement> {
  options: Navbar13Option<T>[];
  selectedValue: T;
  onValueChange: (value: T) => void;
  label?: string;
}

export const Navbar13 = React.forwardRef<HTMLDivElement, Navbar13Props<any>>(
  (
    {
      className,
      options,
      selectedValue,
      onValueChange,
      label = "Options",
      ...props
    },
    ref,
  ) => {
    const currentOption =
      options.find((option) => option.value === selectedValue) || options[0];

    const handleValueChange = (value: string) => {
      const option = options.find((opt) => String(opt.value) === value);
      if (option) {
        onValueChange(option.value);
      }
    };

    return (
      <div ref={ref} className={cn("", className)} {...props}>
        <Select value={String(selectedValue)} onValueChange={handleValueChange}>
          <SelectTrigger
            size="sm"
            className="gap-1.5 px-2.5 bg-zinc-50 dark:bg-zinc-900 text-xs"
          >
            {currentOption && (
              <>
                <currentOption.icon className="w-4 h-4 dark:text-zinc-200 text-zinc-900" />
                <span className="text-xs dark:text-zinc-200 text-zinc-900 font-medium">
                  {currentOption.name}
                </span>
              </>
            )}
          </SelectTrigger>
          <SelectContent side="top" align="start" className="w-80">
            <SelectGroup>
              <SelectLabel className="ps-2">{label}</SelectLabel>
              {options.map((option) => (
                <SelectItem
                  key={String(option.value)}
                  value={String(option.value)}
                  className="p-3"
                >
                  <div className="flex flex-col items-start gap-1">
                    <div className="flex items-center gap-2">
                      <option.icon className="w-4 h-4 dark:text-zinc-200 text-zinc-900" />
                      <span className="font-medium dark:text-zinc-200 text-zinc-900">
                        {option.name}
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  </div>
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
    );
  },
);

Navbar13.displayName = "Navbar13";
