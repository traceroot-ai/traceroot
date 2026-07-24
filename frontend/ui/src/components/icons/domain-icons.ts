import type { LucideIcon } from "lucide-react";
import {
  AlertCircle,
  ArrowRight,
  Bot,
  BotMessageSquare,
  Box,
  CircleCheck,
  CircleDollarSign,
  CircleStop,
  Clock,
  Eye,
  FolderKanban,
  Globe,
  Hash,
  LayoutDashboard,
  LayoutGrid,
  Layers,
  Shapes,
  Sparkle,
  Users,
  Workflow,
  Wrench,
} from "lucide-react";

/**
 * Single source of truth for domain-concept icons. Every surface that draws
 * one of these concepts (filter fields, span kinds, nav tabs, chips, …)
 * should import from here instead of picking a lucide icon directly — that's
 * what let "model" drift to four different glyphs across the app.
 *
 * `project` and `workspace` are deliberately separate entries: they read as
 * the same concept in the original issue text, but they're distinct concepts
 * in this app (a workspace contains projects), each already icon-consistent
 * on its own.
 */
export const DOMAIN_ICONS = {
  tokens: CircleStop,
  cost: CircleDollarSign,
  model: Box,
  agent: Bot,
  llm: Sparkle,
  tool: Wrench,
  // Default/generic span kind (anything that isn't trace/llm/agent/tool).
  span: ArrowRight,
  assistant: BotMessageSquare,
  user: Users,
  session: Layers,
  trace: Workflow,
  id: Hash,
  // Distinct concept from `id` (a count of things vs. an identifier) that
  // happens to share the same glyph today.
  count: Hash,
  // "Category of kinds" — e.g. the span_kind filter/widget field, which
  // covers all kinds at once rather than meaning one specific kind.
  kind: Shapes,
  status: CircleCheck,
  latency: Clock,
  error: AlertCircle,
  project: FolderKanban,
  workspace: LayoutGrid,
  detector: Eye,
  environment: Globe,
  dashboard: LayoutDashboard,
  // Neutral "unknown field" fallback for filter/widget dropdowns. Kept
  // decoupled from `model` even though both currently render as Box — if the
  // model glyph ever changes, unmapped fields shouldn't silently change with
  // it.
  fallback: Box,
} satisfies Record<string, LucideIcon>;
