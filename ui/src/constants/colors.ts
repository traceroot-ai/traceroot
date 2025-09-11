export const PERCENTILE_COLORS = {
  P50: "#71D175", // Light Green
  P90: "#F7EB07", // Yellow
  P95: "#FF9800", // Orange
  P99: "#F44336", // Red
} as const;

// Type for the percentile keys
export type PercentileKey = keyof typeof PERCENTILE_COLORS;

// Helper function to get color for a percentile
export const getPercentileColor = (percentile: PercentileKey): string => {
  return PERCENTILE_COLORS[percentile];
};

// Color for trace entries
export const TRACE_ENTRY_COLOR = "#F5F5F5"; // Light grey
