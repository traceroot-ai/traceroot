import { type LucideIcon } from "lucide-react";
import { FIELD_ICONS } from "@/features/filters/filter-controls";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";

// The trace-list filter icons, extended with the widget registry's field
// names the trace list spells differently (errors -> error_count), the token
// variants, a distinct count symbol (the shared map's Box doubles as the
// model icon, so count falling back to it read as "model"), and the user /
// session symbols the trace-page tabs use. DOMAIN_ICONS.fallback (Box) stays
// the generic fallback for unmapped fields.
const WIDGET_FIELD_ICONS: Record<string, LucideIcon> = {
  ...FIELD_ICONS,
  error_count: DOMAIN_ICONS.error,
  input_tokens: DOMAIN_ICONS.tokens,
  output_tokens: DOMAIN_ICONS.tokens,
  count: DOMAIN_ICONS.count,
  user_id: DOMAIN_ICONS.user,
  session_id: DOMAIN_ICONS.session,
  // The sidebar's Tracing symbol; `name` is the trace/span name on both views.
  name: DOMAIN_ICONS.trace,
  // A category-of-kinds field; the per-kind glyphs (Sparkle/Bot/Wrench) would
  // each wrongly imply one specific kind.
  span_kind: DOMAIN_ICONS.kind,
  status: DOMAIN_ICONS.status,
};

export const fieldIcon = (field: string): LucideIcon =>
  WIDGET_FIELD_ICONS[field] ?? DOMAIN_ICONS.fallback;
