import { seriesColor } from "@/features/dashboards/series-colors";

/** Topics drawn in their own colour in the chart; the rest share one grey. */
export const MAX_COLOURED_TOPICS = 12;

/** The colour of the topic at this rank (0 = most sampled traces); grey past the palette. */
export function topicColor(rank: number): string {
  return rank < MAX_COLOURED_TOPICS ? seriesColor(rank) : "hsl(var(--muted-foreground))";
}
