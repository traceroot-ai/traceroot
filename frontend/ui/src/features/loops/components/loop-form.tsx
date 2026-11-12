"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  ModelSelector,
  type ModelSelection,
} from "@/features/ai-assistant/components/model-selector";
import { ApiError } from "@/lib/api/client";
import { useProject } from "@/features/projects/hooks";
import {
  getLoopTemplate,
  type CreateLoopInput,
  type LoopSchedule,
} from "@traceroot/core/loops/pure";
import type { Loop } from "../hooks/use-loops";
import {
  DEFAULT_SCHEDULE_DRAFT,
  ScheduleSection,
  draftToSchedule,
  scheduleProblem,
  type ScheduleDraft,
} from "./schedule-section";
import { TemplateChips } from "./template-chips";

/** What the form hands up: a create body (a patch for an edit is the same fields). */
export type LoopFormValues = Required<
  Pick<CreateLoopInput, "name" | "template" | "instructions" | "schedule" | "dryRun">
> &
  Pick<CreateLoopInput, "model" | "provider" | "source" | "lookbackHours">;

interface LoopFormProps {
  projectId: string;
  /** Present when editing. */
  loop?: Loop;
  isPending: boolean;
  error: Error | null;
  onSubmit: (values: LoopFormValues) => void;
  onCancel: () => void;
  /** The browser's zone: where a new daily or weekly schedule starts. */
  defaultTimezone?: string;
}

function draftFromSchedule(schedule: LoopSchedule, fallback: ScheduleDraft): ScheduleDraft {
  switch (schedule.kind) {
    case "interval":
      return { ...fallback, kind: "interval", intervalHours: schedule.intervalHours };
    case "daily":
      return { ...fallback, kind: "daily", hour: schedule.hour, timezone: schedule.timezone };
    case "weekly":
      return {
        ...fallback,
        kind: "weekly",
        weekday: schedule.weekday,
        hour: schedule.hour,
        timezone: schedule.timezone,
      };
  }
}

const SECTION = "border border-border";
const SECTION_HEAD = "flex h-9 items-center border-b border-border px-4";

export function LoopForm({
  projectId,
  loop,
  isPending,
  error,
  onSubmit,
  onCancel,
  defaultTimezone,
}: LoopFormProps) {
  const { data: project } = useProject(projectId);
  const editing = loop !== undefined;
  const browserZone = defaultTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const startDraft: ScheduleDraft = { ...DEFAULT_SCHEDULE_DRAFT, timezone: browserZone };

  const initialTemplate = loop ? loop.template : "coding-agents";
  const [template, setTemplate] = useState<string | null>(initialTemplate);
  const [name, setName] = useState(loop?.name ?? getLoopTemplate(initialTemplate)?.name ?? "");
  const [nameEdited, setNameEdited] = useState(editing);
  const [instructions, setInstructions] = useState(loop?.instructions ?? "");
  const [schedule, setSchedule] = useState<ScheduleDraft>(
    loop
      ? draftFromSchedule(loop.schedule, startDraft)
      : getTemplateDraft(initialTemplate, startDraft),
  );
  const [dryRun, setDryRun] = useState(loop?.dryRun ?? false);
  // Seeded from what the Loop stores, or else the project's Agent model, until
  // the person picks something: an untouched picker means "follow the project".
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const stored: ModelSelection | null = loop?.model
    ? {
        model: loop.model,
        provider: loop.provider ?? "",
        source: loop.source === "byok" ? "byok" : "system",
        adapter: "",
      }
    : null;
  const seeded: ModelSelection = stored ?? {
    model: project?.rca_model ?? "",
    provider: project?.rca_provider ?? "",
    source: (project?.rca_source as "system" | "byok" | null) ?? "system",
    adapter: "",
  };
  const selection = picked ?? seeded;

  const handleTemplateChange = (id: string | null) => {
    setTemplate(id);
    const tpl = getLoopTemplate(id);
    if (!nameEdited) setName(tpl?.name ?? "");
    if (!editing && tpl) setSchedule(getTemplateDraft(id, startDraft));
  };

  const scheduleError = scheduleProblem(schedule);
  const needsInstructions = template === null && instructions.trim().length === 0;
  // A 409 is also the Loop limit; only the name collision belongs under the field.
  const isDuplicateName =
    error instanceof ApiError && error.status === 409 && /name already exists/.test(error.message);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const model =
      picked !== null
        ? {
            model: picked.model || null,
            provider: picked.provider || null,
            source: picked.source,
          }
        : editing
          ? {}
          : { model: null, provider: null, source: null };
    onSubmit({
      name: name.trim(),
      template,
      instructions: instructions.trim(),
      schedule: draftToSchedule(schedule),
      dryRun,
      ...(template ? { lookbackHours: getLoopTemplate(template)?.lookbackHours } : {}),
      ...model,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
      <div className={SECTION}>
        <div className={SECTION_HEAD}>
          <span className="text-[13px] font-medium text-foreground">Template</span>
        </div>
        <div className="p-4">
          <TemplateChips value={template} onChange={handleTemplateChange} />
        </div>
      </div>

      <div className={SECTION}>
        <div className={SECTION_HEAD}>
          <span className="text-[13px] font-medium text-foreground">Name</span>
        </div>
        <div className="p-4">
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameEdited(true);
            }}
            placeholder="e.g. Coding agents"
            className="h-7 text-[13px]"
            aria-label="Name"
            required
          />
          {isDuplicateName && (
            <p className="mt-1.5 text-[12px] text-destructive">{error?.message}</p>
          )}
        </div>
      </div>

      <div className={SECTION}>
        <div className={SECTION_HEAD}>
          <span className="text-[13px] font-medium text-foreground">
            {template ? "Additional instructions" : "Instructions"}
          </span>
        </div>
        <div className="p-4">
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={8}
            aria-label="Instructions"
            placeholder={
              template
                ? "Optional: anything this project needs the template to know."
                : "Describe what this Loop should look for..."
            }
            className="resize-vertical w-full border border-input bg-background px-3 py-2 font-mono text-[12px] leading-relaxed placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>

      <ScheduleSection value={schedule} onChange={setSchedule} />

      <div className={SECTION}>
        <div className={SECTION_HEAD}>
          <span className="text-[13px] font-medium text-foreground">Model</span>
        </div>
        <div className="p-4">
          <ModelSelector
            value={selection}
            onChange={setPicked}
            workspaceId={project?.workspace_id}
            field
          />
          <p className="mt-1 text-[12px] text-muted-foreground">
            Starts as the project&apos;s Agent model. Pick another to give this Loop its own.
          </p>
        </div>
      </div>

      <div className={SECTION}>
        <div className="flex items-center justify-between gap-4 p-4">
          <label htmlFor="loop-dry-run" className="cursor-pointer">
            <span className="block text-[13px] font-medium text-foreground">Dry run</span>
            <span className="block text-[12px] text-muted-foreground">
              Run and record a summary, but write no findings.
            </span>
          </label>
          <Switch id="loop-dry-run" checked={dryRun} onCheckedChange={setDryRun} />
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        {error && !isDuplicateName && (
          <span className="mr-auto text-[12px] text-destructive">{error.message}</span>
        )}
        {needsInstructions && (
          <span className="text-[12px] text-muted-foreground">Custom Loops need instructions.</span>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onCancel}
          className="h-7 text-[12px]"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          className="h-7 text-[12px]"
          disabled={isPending || !name.trim() || needsInstructions || scheduleError !== null}
        >
          {isPending ? "Saving..." : editing ? "Save changes" : "Create Loop"}
        </Button>
      </div>
    </form>
  );
}

function getTemplateDraft(templateId: string | null, base: ScheduleDraft): ScheduleDraft {
  const tpl = getLoopTemplate(templateId);
  return tpl ? { ...base, kind: "daily", hour: tpl.defaultSchedule.hour } : base;
}
