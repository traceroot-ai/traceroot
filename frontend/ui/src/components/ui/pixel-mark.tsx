import { cn } from "@/lib/utils";

/**
 * A small pixel-grid mark in the brand teal, echoing the website's pixel
 * language. Decorative: always aria-hidden. `lit` squares are solid; the rest
 * are faint, so the same mark can scale up for empty states.
 */
const LIT = [0, 4, 5, 8]; // a descending trace: top-left, centre, right, bottom-right

export function PixelMark({ className, size = 3 }: { className?: string; size?: number }) {
  const cell = size;
  const gap = 1;
  const side = cell * 3 + gap * 2;
  return (
    <svg
      aria-hidden="true"
      width={side}
      height={side}
      viewBox={`0 0 ${side} ${side}`}
      className={cn("shrink-0 text-brand", className)}
      shapeRendering="crispEdges"
    >
      {Array.from({ length: 9 }, (_, i) => (
        <rect
          key={i}
          x={(i % 3) * (cell + gap)}
          y={Math.floor(i / 3) * (cell + gap)}
          width={cell}
          height={cell}
          fill="currentColor"
          opacity={LIT.includes(i) ? 1 : 0.18}
        />
      ))}
    </svg>
  );
}
