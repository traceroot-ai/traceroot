"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

// Re-export utilities for convenience
export { LOGO_SVG_CONTENT, getLogoSvgString } from "./logo-utils";

interface LogoProps {
  className?: string;
  size?: "sm" | "md" | "lg";
}

/**
 * TraceRoot Logo React component with theme support
 */
export function Logo({ className, size = "sm" }: LogoProps) {
  const { theme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const isDark = mounted && theme === "dark";

  const sizeClasses = {
    sm: "h-5 w-5",
    md: "h-6 w-6",
    lg: "h-8 w-8",
  };

  const paddingClasses = {
    sm: "p-1.5",
    md: "p-2",
    lg: "p-2.5",
  };

  return (
    <div
      className={cn(
        "rounded-md",
        paddingClasses[size],
        isDark ? "bg-white" : "bg-black",
        className,
      )}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className={cn(sizeClasses[size], isDark ? "text-black" : "text-white")}
        viewBox="0 0 23 23"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="11.5" cy="3.5" r="2.5" />
        <circle cx="5.5" cy="11.5" r="2.5" />
        <circle cx="17.5" cy="11.5" r="2.5" />
        <line x1="11.5" y1="6" x2="11.5" y2="8" />
        <line x1="11.5" y1="8" x2="7.5" y2="10" />
        <line x1="11.5" y1="8" x2="15.5" y2="10" />
        <line x1="5.5" y1="14" x2="5.5" y2="17" />
        <line x1="17.5" y1="14" x2="17.5" y2="17" />
        <circle cx="5.5" cy="19.5" r="2.5" />
        <circle cx="17.5" cy="19.5" r="2.5" />
      </svg>
    </div>
  );
}
