// Categorical series palette: 12 hues spread evenly round the wheel and
// ORDERED so consecutive series sit on opposite sides of it — a 2-3 series
// chart (the common case) gets maximally separated colors, and breakdowns up
// to a dozen categories stay distinct. No gray in the rotation: a gray series
// reads as muted/"other", not as real data. Amber and cyan are the -500 shades
// so thin line strokes keep contrast on a light background.
//
// Lives apart from the chart renderers (which import recharts) so anything
// that only needs the palette can take it without dragging recharts along.
export const SERIES_COLORS = [
  "#fb7185", // rose
  "#06b6d4", // cyan
  "#4ade80", // green
  "#a78bfa", // violet
  "#fb923c", // orange
  "#60a5fa", // blue
  "#10b981", // emerald
  "#e879f9", // fuchsia
  "#f59e0b", // amber
  "#818cf8", // indigo
  "#2dd4bf", // teal
  "#f472b6", // pink
];

/** The hue for the i-th series (or tile), cycling once the palette runs out. */
export const seriesColor = (i: number) => SERIES_COLORS[i % SERIES_COLORS.length];
