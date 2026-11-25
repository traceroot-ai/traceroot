"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AccountLine } from "@/components/account-line";
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
import { ApiError } from "@/lib/api/errors";
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
interface Account {
  email: string | null;
  /** A switch is under way. */
  switching: boolean;
  /** Sign out, once `saved` (the answers still being saved) has settled. */
  onSwitch: (saved: Promise<unknown>) => void;
}

export function QuestionsStep({
  onDone,
  account,
  userId,
}: {
  onDone: () => void;
  account?: Account;
  /**
   * The signed-in account, as this tab knows it. The answers and the draft are
   * read for it, and start over when another tab signs this browser in as
   * someone else.
   */
  userId?: string;
}) {
  const { data: saved, isError } = useQuery({
    queryKey: ["onboarding-answers", userId],
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
  // Keyed by the account the answers belong to, so a draft never outlives it.
  return <Questions key={saved.userId} saved={saved} onFinished={leave} account={account} />;
}

function Questions({
  saved,
  onFinished,
  account,
}: {
  saved: OnboardingAnswers;
  onFinished: () => void;
  account?: Account;
}) {
  const questions: Question[] = saved.companyAsked
    ? ["role", "company", "uses", "source"]
    : ["role", "uses", "source"];
  const [index, setIndex] = useState(0);
  const [finishing, setFinishing] = useState(false);
  // A save refused because this browser is now signed in as someone else
  // (another tab switched): nothing more is saved from this draft.
  const [accountChanged, setAccountChanged] = useState(false);
  const changed = useRef(false);
  const refusedForAccount = (err: unknown) => {
    if (err instanceof ApiError && err.status === 409) {
      changed.current = true;
      setAccountChanged(true);
      return true;
    }
    return false;
  };
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
      saveOnboardingAnswers(saved.userId, patch).catch((err) => {
        if (!refusedForAccount(err)) console.error("[onboarding] could not save an answer:", err);
      }),
    );
    if (!last) {
      setIndex(index + 1);
      return;
    }
    setFinishing(true);
    await saves.current;
    if (changed.current) return;
    await finishOnboardingQuestions(saved.userId).catch((err) => {
      if (!refusedForAccount(err))
        console.error("[onboarding] could not finish the questions:", err);
    });
    if (changed.current) return;
    onFinished();
  }

  if (accountChanged) {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 py-2 text-center">
        <p className="text-[12px] text-muted-foreground">
          This browser is now signed in as a different account, so these answers were not saved to
          it. Reload to answer as that account.
        </p>
        <Button size="sm" className="h-8 px-4 text-[12px]" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    );
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
            wide={["leadership"]}
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
          title="What will you use traceroot for?"
          hint={`Pick up to ${MAX_USES}`}
          count={`${draft.uses.length} of ${MAX_USES}`}
        >
          <Options
            name="What will you use traceroot for?"
            multiple
            columns={1}
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
            wide={["friend", "search_ai"]}
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

      {/* The wrong account is likeliest noticed here, the first screen after
          sign-up. Answers already given are saved to the account they were
          given in before it is left; the next account starts its own. */}
      {account && (
        <AccountLine
          email={account.email}
          pending={finishing || account.switching}
          onSwitchAccount={() => account.onSwitch(saves.current)}
        />
      )}
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
  columns = 2,
  wide = [],
}: {
  name: string;
  options: readonly { id: Id; label: string }[];
  picked: readonly Id[];
  onPick: (id: Id) => void;
  multiple?: boolean;
  /** Every pick allowed is made: the rest wait until one is let go. */
  full?: boolean;
  /**
   * Short choices sit two to a row once the options are at least 20rem wide
   * (the width of the options, not of the window), one to a row below that;
   * long ones take one column throughout.
   */
  columns?: 1 | 2;
  /** Choices too long for half a row, which take a whole one. */
  wide?: readonly Id[];
}) {
  // The order on screen is the order of `options`, so the keyboard order is too.
  return (
    <div className="@container">
      <div
        role="group"
        aria-label={name}
        className={cn("grid grid-cols-1 gap-1.5", columns === 2 && "@[20rem]:grid-cols-2")}
      >
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
                wide.includes(option.id) && "@[20rem]:col-span-2",
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
    </div>
  );
}
