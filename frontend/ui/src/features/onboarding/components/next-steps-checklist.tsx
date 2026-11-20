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
  /** The title still leads there once the step is done. */
  linkWhenDone?: boolean;
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
    // Once one has arrived, it is the thing to go and read.
    linkWhenDone: true,
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
  /**
   * Folded or opened by the person, while some step is still to do. Absent
   * until they do either.
   */
  hidden?: boolean;
  /**
   * Opened again after every step left was skipped, to undo a skip: the steps
   * left at that moment. The card stays open for them; any other set of steps
   * left, all skipped, folds it again.
   */
  reopenedFor?: string;
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
  // Every step left is skipped, however it got there (the last skip, or the last
  // required step done): the card folds, and opens again to undo a skip. An
  // earlier "Show" does not hold it open, because it was about other steps.
  const settled = isLeftSkipped(skipped);
  const settledFor = NEXT_STEPS.filter((step) => !done[step.id])
    .map((step) => step.id)
    .join(",");
  const folded = settled ? choices.reopenedFor !== settledFor : (choices.hidden ?? false);
  const toggle = () =>
    setChoices(
      settled
        ? { ...choices, hidden: !folded, reopenedFor: folded ? settledFor : undefined }
        : { ...choices, hidden: !folded },
    );

  const skip = (id: StepId) => setChoices({ ...choices, skipped: [...new Set(skipped).add(id)] });
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
          onClick={toggle}
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
    step.href && (state === "todo" || (state === "done" && step.linkWhenDone)) ? (
      <Link
        href={step.href(projectId)}
        className={cn(
          "font-medium",
          state === "done"
            ? "text-muted-foreground line-through hover:text-foreground"
            : "text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground",
        )}
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
