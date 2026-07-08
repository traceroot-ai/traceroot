import { AlertCircle, Box, CircleStop, type LucideIcon } from "lucide-react";
import { FIELD_ICONS } from "@/features/filters/filter-builder";

// The trace-list filter icons, extended with the widget registry's field
// names the trace list spells differently (errors -> error_count) plus the
// token variants only the spans view has. Box is the same generic fallback
// the trace list uses.
const WIDGET_FIELD_ICONS: Record<string, LucideIcon> = {
  ...FIELD_ICONS,
  error_count: AlertCircle,
  input_tokens: CircleStop,
  output_tokens: CircleStop,
};

export const fieldIcon = (field: string): LucideIcon => WIDGET_FIELD_ICONS[field] ?? Box;
