// Categorical series palette: brand teal first, then hues chosen to be easy to tell
// apart at a glance (warm/cool alternation, no two neighbours alike) — a 2-3 series
// chart (the common case) gets maximally separated colors, and breakdowns up
// to a dozen categories stay distinct. No gray in the rotation: a gray series
// reads as muted/"other", not as real data. Amber and cyan are the -500 shades
// so thin line strokes keep contrast on a light background.
//
// Lives apart from the chart renderers (which import recharts) so anything
// that only needs the palette can take it without dragging recharts along.
export const SERIES_COLORS = [
  "#14b8b0", // teal (brand)
  "#f59e0b", // amber
  "#6366f1", // indigo
  "#ef4444", // red
  "#84cc16", // lime
  "#ec4899", // pink
  "#3b82f6", // blue
  "#a16207", // brown
  "#8b5cf6", // violet
  "#06b6d4", // cyan
  "#f97316", // orange
  "#d946ef", // fuchsia
];

/** The hue for the i-th series (or tile), cycling once the palette runs out. */
export const seriesColor = (i: number) => SERIES_COLORS[i % SERIES_COLORS.length];

// Series whose name carries meaning get a fixed hue: affected traces read as
// the problem (light red), their unaffected counterpart as the healthy teal.
// The pair is only ever plotted together, so reusing palette[0] teal cannot clash.
const NAMED_SERIES_COLORS: Record<string, string> = {
  Affected: "#f87171",
  Unaffected: "#14b8b0",
};

/** Hue for a named series: a reserved one when the name has meaning, else by index. */
export const seriesColorFor = (name: string, i: number) =>
  Object.hasOwn(NAMED_SERIES_COLORS, name) ? NAMED_SERIES_COLORS[name] : seriesColor(i);
