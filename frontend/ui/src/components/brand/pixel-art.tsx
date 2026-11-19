import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * The pixel "traceroot" wordmark from the option 3 sign-up design, drawn exactly as
 * exported (public/images/auth-pixel-wordmark.svg). It keeps the artwork's
 * proportions; give it a width to size it.
 */
export function PixelWordmark({ className }: { className?: string }) {
  return (
    <div
      role="img"
      aria-label="traceroot"
      className={cn(
        "aspect-[538/76] w-full bg-[url(/images/auth-pixel-wordmark.svg)] bg-contain bg-left-top bg-no-repeat",
        className,
      )}
    />
  );
}

/**
 * The pixel field from the option 3 sign-up design, drawn exactly as exported
 * (public/images/auth-pixel-field.svg, 769x400). It spans its positioned parent's
 * width from the top edge and keeps the artwork's proportions at every width.
 */
export function PixelField({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-x-0 top-0 aspect-[769/400] bg-[url(/images/auth-pixel-field.svg)] bg-contain bg-left-top bg-no-repeat",
        className,
      )}
    />
  );
}

/** "Backed by Y Combinator" tag with YC's orange mark. */
export function YCBadge({ className }: { className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-[26px] gap-[7px] rounded-[2px] bg-background px-2 py-0 font-mono text-[11px] font-normal",
        className,
      )}
    >
      <b
        aria-hidden="true"
        className="grid h-3.5 w-3.5 place-items-center rounded-[1px] bg-[#f26522] text-[10px] font-semibold text-white"
      >
        Y
      </b>
      Backed by Y Combinator
    </Badge>
  );
}
