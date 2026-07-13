import {
  AlertCircle,
  Box,
  CircleCheck,
  CircleStop,
  Hash,
  Layers,
  Shapes,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { FIELD_ICONS } from "@/features/filters/filter-controls";

// The trace-list filter icons, extended with the widget registry's field
// names the trace list spells differently (errors -> error_count), the token
// variants, a distinct count symbol (the shared map's Box doubles as the
// model icon, so count falling back to it read as "model"), and the user /
// session symbols the trace-page tabs use. Box stays the generic fallback.
const WIDGET_FIELD_ICONS: Record<string, LucideIcon> = {
  ...FIELD_ICONS,
  error_count: AlertCircle,
  input_tokens: CircleStop,
  output_tokens: CircleStop,
  count: Hash,
  user_id: Users,
  session_id: Layers,
  // The sidebar's Tracing symbol; `name` is the trace/span name on both views.
  name: Workflow,
  // A category-of-kinds field; the per-kind glyphs (Sparkle/Bot/Wrench) would
  // each wrongly imply one specific kind.
  span_kind: Shapes,
  status: CircleCheck,
};

export const fieldIcon = (field: string): LucideIcon => WIDGET_FIELD_ICONS[field] ?? Box;
