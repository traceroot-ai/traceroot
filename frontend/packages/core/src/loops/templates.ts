/**
 * Loop templates. Metadata only: what the create form offers and what a
 * template sets as defaults. The instruction text a template adds at run time
 * ships with the run path, not here.
 */
import type { LoopScheduleInput } from "./schedule.ts";

export interface LoopTemplate {
  id: string;
  name: string;
  description: string;
  /** Bumped when the template's run-time instructions change. */
  version: number;
  /** The timezone is the project's when the form fills it in. */
  defaultSchedule: Extract<LoopScheduleInput, { kind: "daily" }>;
  lookbackHours: number;
}

export const LOOP_TEMPLATES: readonly LoopTemplate[] = [
  {
    id: "coding-agents",
    name: "Coding agents",
    description:
      "Reads coding-agent sessions, groups failing ones by the first thing that went wrong, and proposes one concrete change per recurring problem.",
    version: 1,
    defaultSchedule: { kind: "daily", hour: 9, timezone: "UTC" },
    lookbackHours: 24,
  },
];

export const LOOP_TEMPLATE_IDS = LOOP_TEMPLATES.map((t) => t.id) as [string, ...string[]];

export function getLoopTemplate(id: string | null | undefined): LoopTemplate | null {
  return LOOP_TEMPLATES.find((t) => t.id === id) ?? null;
}
