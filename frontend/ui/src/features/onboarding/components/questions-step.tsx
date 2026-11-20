"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  MAX_USES,
  ROLE_OPTIONS,
  SOURCE_OPTIONS,
  USE_OPTIONS,
  type AnswersPatch,
  type OnboardingAnswers,
  type RoleId,
  type SourceId,
  type UseId,
} from "@/lib/onboarding-questions";
import {
  finishOnboardingQuestions,
  getOnboardingAnswers,
  saveOnboardingAnswers,
} from "@/lib/api/onboarding-questions";
import { cn } from "@/lib/utils";

type Question = "role" | "company" | "uses" | "source";

interface Draft {
  role: RoleId | null;
  company: string;
  uses: UseId[];
  source: SourceId | null;
  sourceOther: string;
}

/** The answer one screen saves: what was picked, or nothing for Skip. */
function patchFor(question: Question, draft: Draft, skipped: boolean): AnswersPatch {
  switch (question) {
    case "role":
      return { role: skipped ? null : draft.role };
    case "company":
      return { company: skipped ? null : draft.company.trim() || null };
    case "uses":
      return { uses: skipped ? [] : draft.uses };
    case "source":
      return skipped
        ? { source: null, sourceOther: null }
        : { source: draft.source, sourceOther: draft.sourceOther.trim() || null };
  }
}

/**
 * The sign-up questions, one to a screen: what describes you, the company (only
 * for a personal-email sign-up), what you will use it for, where you heard of
 * us. Every one can be skipped. Each answer is saved as it is given; finishing
 * or skipping the last marks them done, which sends the answers on once and is
 * why someone who has been through them is never asked again (`onDone` is
 * called straight away for them).
 *
 * Saving never holds anyone up: a save that fails leaves that answer out, and
 * the sign-up goes on.
 */
export function QuestionsStep({ onDone }: { onDone: () => void }) {
  const { data: saved, isError } = useQuery({
    queryKey: ["onboarding-answers"],
    queryFn: getOnboardingAnswers,
    retry: 1,
    // Not kept for the next mount: the tab can be signed in as someone else by
    // then, and another account's "done" would skip this one's questions.
    gcTime: 0,
  });
  // Called once: `onDone` navigates, and a refetch must not do it again.
  const left = useRef(false);
  const leave = () => {
    if (left.current) return;
    left.current = true;
    onDone();
  };

  // Answers that cannot be read are not worth stopping a sign-up for.
  const skipAll = !!saved?.done || isError;
  useEffect(() => {
    if (skipAll) leave();
  });

  if (!saved || skipAll) {
    return <p className="py-6 text-center text-[12px] text-muted-foreground">Loading…</p>;
  }
  return <Questions saved={saved} onFinished={leave} />;
}

function Questions({ saved, onFinished }: { saved: OnboardingAnswers; onFinished: () => void }) {
  const questions: Question[] = saved.companyAsked
    ? ["role", "company", "uses", "source"]
    : ["role", "uses", "source"];
  const [index, setIndex] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const [draft, setDraft] = useState<Draft>({
    role: saved.role,
    company: saved.company ?? "",
    uses: saved.uses,
    source: saved.source === "other" ? null : saved.source,
    sourceOther: saved.sourceOther ?? "",
  });
  // Saves go one after another: an answer changed after Back lands after the
  // first one, and finishing waits for all of them, so the answers sent on
  // include every screen however quickly it was left.
  const saves = useRef<Promise<unknown>>(Promise.resolve());
  const question = questions[index];
  const last = index === questions.length - 1;

  async function next(skipped: boolean) {
    const patch = patchFor(question, draft, skipped);
    saves.current = saves.current.then(() =>
      saveOnboardingAnswers(patch).catch((err) =>
        console.error("[onboarding] could not save an answer:", err),
      ),
    );
    if (!last) {
      setIndex(index + 1);
      return;
    }
    setFinishing(true);
    await saves.current;
    await finishOnboardingQuestions().catch((err) =>
      console.error("[onboarding] could not finish the questions:", err),
    );
    onFinished();
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="flex gap-1" aria-hidden>
          {questions.map((q, i) => (
            <span
              key={q}
              className={cn("h-1 flex-1 rounded-full", i <= index ? "bg-primary" : "bg-muted")}
            />
          ))}
        </div>
        <p className="mt-2 text-[11.5px] text-muted-foreground">
          Step {index + 1} of {questions.length}
        </p>
      </div>

      {question === "role" && (
        <Screen title="What best describes you?" hint="Pick one">
          <Options
            name="What best describes you?"
            options={ROLE_OPTIONS}
            picked={draft.role ? [draft.role] : []}
            onPick={(id) => setDraft({ ...draft, role: draft.role === id ? null : id })}
          />
        </Screen>
      )}

      {question === "company" && (
        <Screen title="Which company or project is this for?" hint="A website is enough">
          <input
            type="text"
            value={draft.company}
            onChange={(event) => setDraft({ ...draft, company: event.target.value })}
            placeholder="acme.com"
            aria-label="Company or project"
            maxLength={200}
            autoFocus
            className="ph-no-capture h-8 w-full rounded-[3px] border border-border bg-background px-2.5 text-[13px] outline-none focus:border-ring"
          />
        </Screen>
      )}

      {question === "uses" && (
        <Screen
          title="What will you use TraceRoot for?"
          hint={`Pick up to ${MAX_USES}`}
          count={`${draft.uses.length} of ${MAX_USES}`}
        >
          <Options
            name="What will you use TraceRoot for?"
            multiple
            options={USE_OPTIONS}
            picked={draft.uses}
            full={draft.uses.length >= MAX_USES}
            onPick={(id) =>
              setDraft({
                ...draft,
                uses: draft.uses.includes(id)
                  ? draft.uses.filter((use) => use !== id)
                  : draft.uses.length < MAX_USES
                    ? [...draft.uses, id]
                    : draft.uses,
              })
            }
          />
        </Screen>
      )}

      {question === "source" && (
        <Screen title="Where did you hear about us?" hint="Pick one, or tell us">
          <Options
            name="Where did you hear about us?"
            options={SOURCE_OPTIONS}
            picked={draft.source ? [draft.source] : []}
            onPick={(id) => setDraft({ ...draft, source: draft.source === id ? null : id })}
          />
          {/* What is typed here stays in our database: `ph-no-capture` keeps
              analytics' autocapture and session replay off it. */}
          <input
            type="text"
            value={draft.sourceOther}
            onChange={(event) => setDraft({ ...draft, sourceOther: event.target.value })}
            placeholder="Somewhere else? Tell us"
            aria-label="Somewhere else"
            maxLength={200}
            className="ph-no-capture mt-2 h-8 w-full rounded-[3px] border border-border bg-background px-2.5 text-[13px] outline-none focus:border-ring"
          />
        </Screen>
      )}

      <div className="flex items-center gap-2">
        {index > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-3 text-[12px]"
            disabled={finishing}
            onClick={() => setIndex(index - 1)}
          >
            Back
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-8 px-3 text-[12px] text-muted-foreground"
          disabled={finishing}
          onClick={() => next(true)}
        >
          Skip
        </Button>
        <Button
          size="sm"
          className="h-8 px-4 text-[12px]"
          disabled={finishing}
          onClick={() => next(false)}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}

function Screen({
  title,
  hint,
  count,
  children,
}: {
  title: string;
  hint: string;
  count?: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title}>
      <h2 className="text-[14px] font-medium">{title}</h2>
      <p className="mb-3 flex text-[12px] text-muted-foreground">
        {hint}
        {count && <span className="ml-auto tabular-nums">{count}</span>}
      </p>
      {children}
    </section>
  );
}

function Options<Id extends string>({
  name,
  options,
  picked,
  onPick,
  multiple = false,
  full = false,
}: {
  name: string;
  options: readonly { id: Id; label: string }[];
  picked: readonly Id[];
  onPick: (id: Id) => void;
  multiple?: boolean;
  /** Every pick allowed is made: the rest wait until one is let go. */
  full?: boolean;
}) {
  return (
    <div role="group" aria-label={name} className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
      {options.map((option) => {
        const on = picked.includes(option.id);
        return (
          <button
            key={option.id}
            type="button"
            role={multiple ? "checkbox" : "radio"}
            aria-checked={on}
            disabled={!on && full}
            onClick={() => onPick(option.id)}
            className={cn(
              "min-h-8 rounded-[4px] border px-2.5 py-1.5 text-left text-[12.5px] transition-colors",
              on
                ? "border-primary bg-primary/10 font-medium text-foreground"
                : "border-border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
