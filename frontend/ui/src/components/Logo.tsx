import { cn } from "@/lib/utils";

interface LogoProps {
  className?: string;
  /** "wordmark" is the symbol plus the name; "mark" crops to the symbol alone. */
  variant?: "wordmark" | "mark";
  size?: "sm" | "md" | "lg";
}

const WORDMARK_HEIGHT = { sm: "h-5", md: "h-6", lg: "h-8" } as const;
const MARK_SIZE = { sm: "h-5 w-5", md: "h-6 w-6", lg: "h-8 w-8" } as const;

/**
 * TraceRoot logo. Both theme images are in the DOM and CSS picks one, so the
 * right one shows from the first paint with no theme lookup on the client.
 */
export function Logo({ className, variant = "wordmark", size = "sm" }: LogoProps) {
  const mark = variant === "mark";
  const img = "max-w-none";
  const fit = mark ? "h-full w-full object-cover object-left" : "h-full w-auto";
  return (
    <span
      role="img"
      aria-label="TraceRoot"
      className={cn(
        "inline-flex shrink-0 overflow-hidden",
        mark ? MARK_SIZE[size] : WORDMARK_HEIGHT[size],
        className,
      )}
    >
      <img src="/images/traceroot_logo_light.png" alt="" className={cn(img, fit, "dark:hidden")} />
      <img
        src="/images/traceroot_logo_dark.png"
        alt=""
        className={cn(img, fit, "hidden dark:block")}
      />
    </span>
  );
}
