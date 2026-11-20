/**
 * The sign-up questions: their options as stable ids, which the database, the
 * `onboarding_answers_submitted` event and the lead service's scoring all read,
 * and the words shown for each, which can change without touching any of them.
 */
import { z } from "zod";

export const ROLE_OPTIONS = [
  { id: "engineering", label: "Software engineering" },
  { id: "data", label: "Data or ML" },
  { id: "product_management", label: "Product management" },
  { id: "founder", label: "Founder" },
  { id: "leadership", label: "Engineering or company leadership" },
  { id: "student", label: "Student" },
  { id: "other", label: "Something else" },
] as const;

export const USE_OPTIONS = [
  { id: "chat_support", label: "A support bot or chat assistant" },
  { id: "rag", label: "Answering questions from our own documents" },
  { id: "workflow_automation", label: "Automating a business process with AI" },
  { id: "autonomous_agents", label: "Agents that plan and act on their own" },
  { id: "coding_agents", label: "Watching what my coding agents do" },
  { id: "exploring", label: "Just looking around for now" },
  { id: "other", label: "Something else" },
] as const;

export const SOURCE_OPTIONS = [
  { id: "x", label: "X" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "github", label: "GitHub" },
  { id: "yc", label: "Y Combinator" },
  { id: "friend", label: "A friend or coworker" },
  { id: "search_ai", label: "A search engine or AI assistant" },
] as const;

/** Uses one person can pick. */
export const MAX_USES = 3;

type Ids<T extends readonly { id: string }[]> = T[number]["id"];
export type RoleId = Ids<typeof ROLE_OPTIONS>;
export type UseId = Ids<typeof USE_OPTIONS>;
/** `other` is what a typed answer alone counts as; there is no button for it. */
export type SourceId = Ids<typeof SOURCE_OPTIONS> | "other";

const ids = <T extends readonly { id: string }[]>(options: T) =>
  options.map((option) => option.id) as [Ids<T>, ...Ids<T>[]];

/**
 * One save: the answers given so far, each saved as it is given. A field left
 * out is left as it is; `null` (or `[]`) clears it, which is what going back
 * and skipping a question does.
 */
export const answersPatchSchema = z
  .object({
    role: z.enum(ids(ROLE_OPTIONS)).nullable(),
    company: z.string().trim().max(200).nullable(),
    uses: z.array(z.enum(ids(USE_OPTIONS))).max(MAX_USES),
    source: z.enum([...ids(SOURCE_OPTIONS), "other"]).nullable(),
    sourceOther: z.string().trim().max(200).nullable(),
  })
  .partial()
  .strict();

export type AnswersPatch = z.infer<typeof answersPatchSchema>;

/** The saved answers and whether the questions are behind this person. */
export interface OnboardingAnswers {
  role: RoleId | null;
  company: string | null;
  uses: UseId[];
  source: SourceId | null;
  sourceOther: string | null;
  /** The company question is asked only of a personal-email sign-up. */
  companyAsked: boolean;
  /** Finished or skipped through to the end once; they are not asked again. */
  done: boolean;
}
