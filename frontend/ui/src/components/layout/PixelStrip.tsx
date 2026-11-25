import { cn } from "@/lib/utils";

const COLUMNS = 34;
const ROWS = 5;
const PITCH = 6;
const TILE = 4.5;

// Deterministic lattice value in [0, 1): the same on server and client.
function lattice(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

// Smooth value noise, so neighbouring tiles share a strength and the field
// forms clusters, as the website's pixel artwork does, instead of static.
function noise(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const top = lattice(x0, y0) * (1 - sx) + lattice(x0 + 1, y0) * sx;
  const bottom = lattice(x0, y0 + 1) * (1 - sx) + lattice(x0 + 1, y0 + 1) * sx;
  return top * (1 - sy) + bottom * sy;
}

// The website's mosaic, measured from its artwork: 9px tiles on a 12px pitch
// (a quarter of each cell is gap), in the brand teal at two main strengths,
// faint (0.2) with strong (0.8) accents. Tiles gather in clusters that are
// dense along the top and thin out below, leaving open field.
const TILES = (() => {
  const tiles: { x: number; y: number; opacity: number }[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let column = 0; column < COLUMNS; column++) {
      const cluster = noise(column / 3.4 + 3, row / 2.2);
      const grain = lattice(column * 7 + 1, row * 13 + 5);
      // Fewer tiles survive on each row down.
      if (cluster * 0.7 + grain * 0.3 < 0.3 + row * 0.085) continue;
      const accent = lattice(column * 3 + 11, row * 5 + 2);
      tiles.push({
        x: column * PITCH + (PITCH - TILE) / 2,
        y: row * PITCH + (PITCH - TILE) / 2,
        opacity: accent < 0.1 + cluster * 0.3 ? 0.8 : 0.2,
      });
    }
  }
  return tiles;
})();

/** Decorative band of brand pixels, on a full mint field, for the top of a sidebar card. */
export function PixelStrip({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      data-testid="pixel-strip"
      viewBox={`0 0 ${COLUMNS * PITCH} ${ROWS * PITCH}`}
      preserveAspectRatio="xMidYMid slice"
      className={cn("block h-[30px] w-full bg-brand-soft text-primary", className)}
    >
      {TILES.map(({ x, y, opacity }) => (
        <rect
          key={`${x}-${y}`}
          x={x}
          y={y}
          width={TILE}
          height={TILE}
          fill="currentColor"
          opacity={opacity}
        />
      ))}
    </svg>
  );
}
