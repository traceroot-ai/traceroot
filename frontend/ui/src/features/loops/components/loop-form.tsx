"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SectionBox } from "@/features/dashboards/components/SectionBox";
import {
  ModelSelector,
  type ModelSelection,
} from "@/features/ai-assistant/components/model-selector";
import { ApiError } from "@/lib/api/client";
import { useProject } from "@/features/projects/hooks";
import {
  LOOP_INSTRUCTIONS_REQUIRED,
  LOOP_LIMITS,
  LOOP_NAME_TAKEN,
  LOOP_NAME_TAKEN_BY_DETECTOR,
  getLoopTemplate,
  templateLoopInput,
  type CreateLoopInput,
} from "@traceroot/core/loops/pure";
import { loopModelFields, useLoopModelDefaults, type Loop } from "../hooks/use-loops";
import { useBrowserTimezone } from "../hooks/use-now";
import {
  DEFAULT_SCHEDULE_DRAFT,
  ScheduleSection,
  draftFromSchedule,
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
  /** Read-only sections between the editable ones and the actions. */
  children?: React.ReactNode;
}

const DEFAULT_TEMPLATE = "coding-agents";

const NO_MODEL: ModelSelection = { model: "", provider: "", source: "system", adapter: "" };

export function LoopForm({
  projectId,
  loop,
  isPending,
  error,
  onSubmit,
  onCancel,
  children,
}: LoopFormProps) {
  const { data: project } = useProject(projectId);
  const editing = loop !== undefined;
  const browserZone = useBrowserTimezone();
  const startZone = browserZone ?? DEFAULT_SCHEDULE_DRAFT.timezone;
  const startDraft: ScheduleDraft = { ...DEFAULT_SCHEDULE_DRAFT, timezone: startZone };

  // A new loop starts as the first template sets it up.
  const start = loop ?? templateLoopInput(DEFAULT_TEMPLATE, startZone)!;
  const [template, setTemplate] = useState<string | null>(start.template);
  const [name, setName] = useState(start.name);
  const [nameEdited, setNameEdited] = useState(editing);
  // The instructions are the whole prompt a run follows; a template only pre-fills
  // them. A templated loop saved before that (with none) starts from the template's.
  const [instructions, setInstructions] = useState(
    start.instructions || getLoopTemplate(start.template)?.defaultInstructions || "",
  );
  const [schedule, setSchedule] = useState<ScheduleDraft>(
    draftFromSchedule(start.schedule, startDraft),
  );
  const [scheduleEdited, setScheduleEdited] = useState(editing);
  // The server (and the hydrating render) has no browser zone; a new loop's
  // schedule moves to it as soon as it is known.
  useEffect(() => {
    if (editing || browserZone === null) return;
    setSchedule((draft) => ({ ...draft, timezone: browserZone }));
  }, [editing, browserZone]);
  const [dryRun, setDryRun] = useState(loop?.dryRun ?? false);

  // A new loop starts on the current default model rather than the project's
  // Agent model, which may be a legacy one, but only when the workspace offers
  // it; otherwise it follows the project. An existing loop with no model of its
  // own follows the project too. Empty, the picker shows what the loop runs on
  // as its default row.
  const defaults = useLoopModelDefaults(project?.workspace_id);
  const initialSelection: ModelSelection = loop?.model
    ? {
        model: loop.model,
        provider: loop.provider ?? "",
        source: loop.source === "byok" ? "byok" : "system",
        adapter: "",
      }
    : NO_MODEL;
  const [selection, setSelection] = useState(initialSelection);
  const startModel = editing ? null : defaults.loopDefault;
  const followsProject = !initialSelection.model && !startModel;
  // Following the project, its Agent model; a BYOK Agent model has no row and shows as its id.
  const defaultModelId = initialSelection.model
    ? undefined
    : (startModel?.model ?? project?.rca_model ?? defaults.agentDefault?.model);
  // The picker backfills a stored provider or adapter it can match, so only the model
  // and its source tell a pick from the stored or default one.
  const modelChanged =
    selection.model !== initialSelection.model || selection.source !== initialSelection.source;

  // Only a new loop picks a template; an edit has no picker.
  const handleTemplateChange = (id: string | null) => {
    setTemplate(id);
    const next = templateLoopInput(id, startZone);
    if (!nameEdited) setName(next?.name ?? "");
    // Swap the pre-filled instructions and schedule with the template's, but never over what the person set.
    const previous = getLoopTemplate(template)?.defaultInstructions ?? "";
    if (instructions === previous || instructions.trim() === "") {
      setInstructions(next?.instructions ?? "");
    }
    if (!scheduleEdited && next) setSchedule(draftFromSchedule(next.schedule, startDraft));
  };

  const scheduleError = scheduleProblem(schedule);
  const needsInstructions = instructions.trim().length === 0;
  // A 409 is also the loop limit; only the name collisions belong under the field.
  const isDuplicateName =
    error instanceof ApiError &&
    (error.message === LOOP_NAME_TAKEN || error.message === LOOP_NAME_TAKEN_BY_DETECTOR);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // An untouched edit leaves the model alone; an untouched create sends the start model, or nulls.
    const model = modelChanged
      ? loopModelFields(selection)
      : editing
        ? {}
        : loopModelFields(startModel);
    onSubmit({
      name: name.trim(),
      template,
      instructions: instructions.trim(),
      schedule: draftToSchedule(schedule),
      dryRun,
      // A template sets a new loop's lookback; an edit leaves it as stored.
      ...(!editing && template ? { lookbackHours: getLoopTemplate(template)?.lookbackHours } : {}),
      ...model,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
      {!editing && (
        <SectionBox label="Template">
          <div className="p-4">
            <TemplateChips value={template} onChange={handleTemplateChange} />
          </div>
        </SectionBox>
      )}

      <SectionBox label="Name">
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
            maxLength={LOOP_LIMITS.nameMaxLength}
            required
          />
          {isDuplicateName && (
            <p className="mt-1.5 text-[12px] text-destructive">{error?.message}</p>
          )}
        </div>
      </SectionBox>

      <SectionBox label="Model">
        <div className="p-4">
          <ModelSelector
            value={selection}
            onChange={setSelection}
            workspaceId={project?.workspace_id}
            defaultModelId={defaultModelId}
            field
          />
          <p className="mt-1 text-[12px] text-muted-foreground">
            {modelHint({ picked: modelChanged, followsProject, editing })}
          </p>
        </div>
      </SectionBox>

      <SectionBox label="Instructions">
        <div className="p-4">
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={8}
            aria-label="Instructions"
            aria-invalid={needsInstructions || undefined}
            aria-describedby={needsInstructions ? "loop-instructions-required" : undefined}
            placeholder={"Describe what this loop should look for..."}
            className="resize-vertical w-full border border-input bg-background px-3 py-2 font-mono text-[12px] leading-relaxed placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {needsInstructions && (
            <p id="loop-instructions-required" className="mt-1.5 text-[12px] text-muted-foreground">
              {LOOP_INSTRUCTIONS_REQUIRED}
            </p>
          )}
        </div>
      </SectionBox>

      <ScheduleSection
        value={schedule}
        onChange={(draft) => {
          setSchedule(draft);
          setScheduleEdited(true);
        }}
      />

      <SectionBox label="Findings">
        <div className="flex items-center justify-between gap-4 p-4">
          <label htmlFor="loop-dry-run" className="cursor-pointer">
            <span className="block text-[13px] font-medium text-foreground">Dry run</span>
            <span className="block text-[12px] text-muted-foreground">
              Run and record a summary, but write no findings.
            </span>
          </label>
          <Switch id="loop-dry-run" checked={dryRun} onCheckedChange={setDryRun} />
        </div>
      </SectionBox>

      {children}

      <div className="flex items-center justify-end gap-2 pt-1">
        {error && !isDuplicateName && (
          <span className="mr-auto text-[12px] text-destructive">{error.message}</span>
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
          disabled={
            isPending ||
            !name.trim() ||
            needsInstructions ||
            scheduleError !== null ||
            // A create needs to know whether the default model is on offer.
            (!editing && !modelChanged && defaults.isPending)
          }
        >
          {isPending ? (editing ? "Saving..." : "Creating...") : editing ? "Save" : "Create loop"}
        </Button>
      </div>
    </form>
  );
}

function modelHint(state: { picked: boolean; followsProject: boolean; editing: boolean }) {
  if (state.picked) return "This loop runs on the model picked here.";
  if (state.followsProject) {
    return "Follows the project's Agent model. Pick another to give this loop its own.";
  }
  if (state.editing) return "Pick another model to change what this loop runs on.";
  return "Starts on the latest default model. Pick another to give this loop its own.";
}
