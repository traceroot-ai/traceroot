"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Check, Circle, CircleDashed } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { getProjectNextSteps, type ProjectNextSteps } from "@/lib/api";
import { useLocalStorage } from "@/lib/hooks/use-local-storage";
import { cn } from "@/lib/utils";

type StepId = keyof ProjectNextSteps;

interface Step {
  id: StepId;
  title: string;
  /** Optional steps can be skipped. */
  optional?: boolean;
  description?: string;
  /** Where the title leads while the step is still to do. */
  href?: (projectId: string) => string;
  action?: { label: string; href: (projectId: string) => string; external?: boolean };
}

/** Where evals start: they are written in code with the SDK, with nothing to click here. */
export const EVALS_DOCS_URL = "https://traceroot.ai/docs/evals/get-started";

export const NEXT_STEPS: readonly Step[] = [
  {
    id: "first_trace",
    title: "Send your first trace",
    // The traces page shows the setup instructions until a trace arrives.
    href: (projectId) => `/projects/${projectId}/traces`,
  },
  {
    id: "detector",
    title: "Create your first detector",
    optional: true,
    description: "Flag runs that miss the mark",
    action: { label: "Create", href: (projectId) => `/projects/${projectId}/detectors/new` },
  },
  {
    id: "signal",
    title: "Receive your first signal",
    optional: true,
    description: "Shows up once a detector finds a pattern",
    href: (projectId) => `/projects/${projectId}/signals`,
  },
  {
    id: "eval_run",
    title: "Run your first eval",
    description: "Check a change against real cases",
    action: { label: "Get started", href: () => EVALS_DOCS_URL, external: true },
  },
];

/** What this browser remembers for one project: the steps skipped and whether the card is folded. */
interface Choices {
  skipped: StepId[];
  /** Absent until the person folds or opens the card themselves. */
  hidden?: boolean;
}

export const nextStepsStorageKey = (projectId: string) =>
  `traceroot:home:next-steps:v1:${projectId}`;

/**
 * The project home's "Next steps": four steps from a first trace to a first eval.
 *
 * A step is done when the project's own data says so, read by
 * `GET /api/projects/[projectId]/next-steps`; nothing here records progress. The
 * count is the steps done, never the ones skipped. Skipping (the two optional
 * steps) and folding the card are this browser's, per project.
 *
 * With every step done the card goes away. With every step left skipped it folds
 * to one line, which opens again to undo a skip. Read-only visitors of the demo
 * workspace never see it: none of its steps are theirs to do.
 */
export function NextStepsChecklist({
  projectId,
  readOnly,
}: {
  projectId: string;
  /** A read-only visitor of the demo workspace. */
  readOnly: boolean;
}) {
  const { data: done } = useQuery({
    queryKey: ["project-next-steps", projectId],
    queryFn: () => getProjectNextSteps(projectId),
    enabled: !!projectId && !readOnly,
  });
  const [choices, setChoices] = useLocalStorage<Choices>(nextStepsStorageKey(projectId), {
    skipped: [],
  });

  // Nothing until the steps are known: a card drawn before its data would show
  // every step as still to do, then change under the reader.
  if (readOnly || !done) return null;

  const doneCount = NEXT_STEPS.filter((step) => done[step.id]).length;
  if (doneCount === NEXT_STEPS.length) return null;

  const skipped = new Set(choices.skipped);
  const isLeftSkipped = (ids: Set<StepId>) =>
    NEXT_STEPS.every((step) => done[step.id] || ids.has(step.id));
  const folded = choices.hidden ?? isLeftSkipped(skipped);

  const skip = (id: StepId) => {
    const next = new Set(skipped).add(id);
    // Skipping the last step left folds the card; it opens again to undo.
    setChoices({ skipped: [...next], hidden: isLeftSkipped(next) ? true : choices.hidden });
  };
  const undo = (id: StepId) =>
    setChoices({ ...choices, skipped: choices.skipped.filter((other) => other !== id) });

  return (
    <section aria-label="Next steps" className="rounded-[4px] border border-border text-[13px]">
      <div className={cn("flex items-center gap-2 px-3 py-2", !folded && "border-b border-border")}>
        <h2 className="font-medium text-foreground">Next steps</h2>
        <span className="text-[12px] text-muted-foreground">
          {doneCount} of {NEXT_STEPS.length} done
        </span>
        <button
          type="button"
          aria-expanded={!folded}
          onClick={() => setChoices({ ...choices, hidden: !folded })}
          className="ml-auto text-[12px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {folded ? "Show" : "Hide"}
        </button>
      </div>

      {!folded && (
        <ul className="divide-y divide-border">
          {NEXT_STEPS.map((step) => (
            <StepRow
              key={step.id}
              step={step}
              projectId={projectId}
              state={done[step.id] ? "done" : skipped.has(step.id) ? "skipped" : "todo"}
              onSkip={() => skip(step.id)}
              onUndo={() => undo(step.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function StepRow({
  step,
  projectId,
  state,
  onSkip,
  onUndo,
}: {
  step: Step;
  projectId: string;
  state: "done" | "skipped" | "todo";
  onSkip: () => void;
  onUndo: () => void;
}) {
  const title =
    state === "todo" && step.href ? (
      <Link
        href={step.href(projectId)}
        className="font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
      >
        {step.title}
      </Link>
    ) : (
      <span
        className={cn(
          "font-medium",
          state === "done" && "text-muted-foreground line-through",
          state === "skipped" && "text-muted-foreground/70",
        )}
      >
        {step.title}
      </span>
    );

  return (
    <li
      data-step={step.id}
      data-state={state}
      className="flex min-h-[37px] items-center gap-2.5 px-3 py-1.5"
    >
      <StateIcon state={state} />
      <span className="shrink-0">{title}</span>
      {step.optional && state !== "done" && (
        <span
          className={cn(
            "shrink-0 rounded-[2px] border border-border px-1.5 text-[11px] text-muted-foreground",
            state === "skipped" && "opacity-70",
          )}
        >
          Optional
        </span>
      )}
      {step.description && state !== "done" && (
        <span
          className={cn(
            "min-w-0 truncate text-[12px] text-muted-foreground",
            state === "skipped" && "opacity-70",
          )}
        >
          {step.description}
        </span>
      )}

      <span className="ml-auto flex shrink-0 items-center gap-2.5 text-[12px]">
        {state === "done" && <span className="text-muted-foreground">Done</span>}
        {state === "skipped" && (
          <>
            <span className="text-muted-foreground">Skipped</span>
            <button
              type="button"
              onClick={onUndo}
              aria-label={`Undo skipping "${step.title}"`}
              className="text-foreground underline underline-offset-4"
            >
              Undo
            </button>
          </>
        )}
        {state === "todo" && step.optional && (
          <button
            type="button"
            onClick={onSkip}
            aria-label={`Skip "${step.title}"`}
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            Skip
          </button>
        )}
        {state === "todo" && step.action && (
          <ActionLink action={step.action} projectId={projectId} />
        )}
      </span>
    </li>
  );
}

function ActionLink({
  action,
  projectId,
}: {
  action: NonNullable<Step["action"]>;
  projectId: string;
}) {
  const className = cn(
    buttonVariants({ variant: "outline", size: "sm" }),
    "h-6 px-2.5 text-[12px] font-medium",
  );
  if (action.external) {
    return (
      <a
        href={action.href(projectId)}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
      >
        {action.label}
      </a>
    );
  }
  return (
    <Link href={action.href(projectId)} className={className}>
      {action.label}
    </Link>
  );
}

function StateIcon({ state }: { state: "done" | "skipped" | "todo" }) {
  if (state === "done") {
    return (
      <span
        aria-label="Done"
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary"
      >
        <Check className="h-2.5 w-2.5 text-primary-foreground" strokeWidth={3} />
      </span>
    );
  }
  if (state === "skipped") {
    return (
      <CircleDashed aria-label="Skipped" className="h-4 w-4 shrink-0 text-muted-foreground/60" />
    );
  }
  return <Circle aria-label="To do" className="h-4 w-4 shrink-0 text-muted-foreground/60" />;
}
