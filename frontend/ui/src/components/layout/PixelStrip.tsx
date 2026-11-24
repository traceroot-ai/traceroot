import { cn } from "@/lib/utils";

const COLUMNS = 50;
const ROWS = 4;
const CELL = 4;

// A fixed dither in the brand pixel style: a solid teal edge along the top
// that breaks up into scattered pixels towards the bottom. Seeded so server
// and client render the same.
const PIXELS = (() => {
  const cells: { x: number; y: number; opacity: number }[] = [];
  let seed = 20261124;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (let y = 0; y < ROWS; y++) {
    const density = 1 - (y / ROWS) ** 0.8;
    for (let x = 0; x < COLUMNS; x++) {
      const roll = next();
      const strength = next();
      if (roll > density) continue;
      cells.push({ x, y, opacity: (0.35 + 0.65 * strength) * (1 - (y / ROWS) * 0.5) });
    }
  }
  return cells;
})();

/** Decorative band of brand pixels for the top of a sidebar card. */
export function PixelStrip({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      data-testid="pixel-strip"
      viewBox={`0 0 ${COLUMNS * CELL} ${ROWS * CELL}`}
      preserveAspectRatio="xMidYMin slice"
      shapeRendering="crispEdges"
      className={cn("block h-4 w-full bg-brand-soft text-primary", className)}
    >
      {PIXELS.map(({ x, y, opacity }) => (
        <rect
          key={`${x}-${y}`}
          x={x * CELL}
          y={y * CELL}
          width={CELL}
          height={CELL}
          fill="currentColor"
          opacity={opacity.toFixed(2)}
        />
      ))}
    </svg>
  );
}
