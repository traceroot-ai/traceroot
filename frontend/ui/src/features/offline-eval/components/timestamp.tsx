"use client";

import * as React from "react";
import { cn, parseAsUTC } from "@/lib/utils";
import { formatStamp } from "../utils";

/**
 * Deterministic UTC render of `formatStamp`'s format. Server and browser both
 * produce this identical string, so it is safe for SSR / first client paint.
 */
function formatStampUTC(iso: string): string {
  const d = parseAsUTC(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(
    d.getUTCHours(),
  )}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/**
 * Hydration-safe absolute timestamp.
 *
 * These screens render hardcoded fixtures during SSR, so `formatStamp` (local
 * time) would mismatch between the UTC server and the browser's timezone. We
 * render the deterministic UTC value on the server and first client render —
 * which match exactly — then swap to the local-time format the rest of the app
 * uses once mounted.
 */
export function Timestamp({ iso, className }: { iso: string; className?: string }) {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  return (
    <span className={cn("whitespace-nowrap", className)}>
      {mounted ? formatStamp(iso) : formatStampUTC(iso)}
    </span>
  );
}
