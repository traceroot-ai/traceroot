"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

interface TraceRootLogoProps {
  size?: number;
  className?: string;
}

export default function TraceRootLogo({
  size = 24,
  className = "",
}: TraceRootLogoProps) {
  const { theme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const isDark = mounted && theme === "dark";

  return (
    <div
      className={`rounded-lg p-1.5 ${isDark ? "bg-white" : "bg-black"} ${className}`}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        style={{ width: size, height: size }}
        className={isDark ? "text-black" : "text-white"}
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
