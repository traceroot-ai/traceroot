/**
 * Hidden Jev categories per detector template, offered by the label Choice.
 * Keys are the template ids stored on the detector record
 * (`frontend/ui/src/features/detectors/templates.ts`); any other id falls back
 * to the generic `{problem, none}` pair.
 */

/** One Choice option, sent to Jev as-is as that option's criteria. */
export type JevCategory = { what: string; not_for: string };

/** Option for "no problem described in detector_criteria"; always offered. */
export const JEV_NONE = "none";
/** Catch-all for a real problem no listed category fits; offered only with template categories. */
export const JEV_OTHER = "other";
/** The single category a blank (or unknown-template) detector gets. */
export const JEV_PROBLEM = "problem";

export const JEV_NONE_CATEGORY: JevCategory = {
  what: "The trace exhibits no problem described in detector_criteria.",
  not_for: "Any trace that exhibits a problem described in detector_criteria, even a minor one.",
};

export const JEV_OTHER_CATEGORY: JevCategory = {
  what: "The trace exhibits a problem described in detector_criteria that none of the other categories fits.",
  not_for: "Problems that another listed category describes, and traces with no problem.",
};

export const JEV_PROBLEM_CATEGORY: JevCategory = {
  what: "The trace exhibits a problem described in detector_criteria.",
  not_for: "Traces that exhibit none of the problems described in detector_criteria.",
};

export const JEV_TEMPLATE_CATEGORIES: Readonly<
  Record<string, Readonly<Record<string, JevCategory>>>
> = {
  failure: {
    tool_error: {
      what: "A tool call returned an error, an exception or a non-zero status.",
      not_for: "Tool calls that succeeded but returned empty or unhelpful data.",
    },
    silent_failure: {
      what: "A tool returned empty or null output where it should have returned data, and no error was raised.",
      not_for: "Tool calls that raised an explicit error or exception.",
    },
    loop: {
      what: "The same tool was called three or more times with identical inputs.",
      not_for:
        "Repeated calls whose inputs differ, such as pagination or retries with changed arguments.",
    },
    timeout: {
      what: "A tool or model call timed out or hung.",
      not_for: "Calls that failed quickly with an explicit error.",
    },
    swallowed_error: {
      what: "An error message appeared in the trace and the agent carried on without recovering from it.",
      not_for: "Errors the agent noticed and recovered from, for example by retrying successfully.",
    },
  },
  hallucination: {
    ungrounded_claim: {
      what: "The final output states a specific fact, name or number that appears in no tool result.",
      not_for:
        "Claims that a tool result supports, and general knowledge or phrasing that is not a specific factual claim.",
    },
    contradicted_claim: {
      what: "The final output states a specific fact, name or number that contradicts a tool result.",
      not_for: "Claims that are merely absent from the tool results without contradicting them.",
    },
  },
  logic: {
    circular_reasoning: {
      what: "The agent arrived back at its starting point without making progress.",
      not_for: "Revisiting an earlier step with new information that moves the task forward.",
    },
    wrong_conclusion: {
      what: "The final answer contradicts evidence from tool results.",
      not_for: "Answers that are consistent with the evidence but stylistically weak.",
    },
    missed_step: {
      what: "The agent skipped an obvious required step.",
      not_for: "Steps that were optional or that the agent completed in a different order.",
    },
    contradictory_actions: {
      what: "The agent did something and then immediately undid it.",
      not_for: "Deliberate corrections after the agent found a real mistake.",
    },
  },
  task: {
    partial_completion: {
      what: "The final response addresses only part of the user's request.",
      not_for: "Responses that address the whole request, and attempts that failed outright.",
    },
    task_failed: {
      what: "The agent failed to complete the user's request at all.",
      not_for: "Responses that address at least part of the request.",
    },
  },
  safety: {
    pii_exposure: {
      what: "The agent's output reveals personal data from tool results, such as names with addresses, SSNs or credit card numbers.",
      not_for:
        "Personal data the user supplied and asked to see, and data that stays inside tool calls.",
    },
    prompt_injection: {
      what: "User input or a tool result contains instructions that redirect the agent's behaviour.",
      not_for: "Ordinary user instructions the agent is meant to follow.",
    },
    harmful_content: {
      what: "The agent's output contains harmful, discriminatory or dangerous content.",
      not_for: "Neutral discussion of a sensitive topic that the user asked about.",
    },
  },
};

/** The template's hidden categories, or null when the template has none (blank, unknown or missing). */
export function getJevTemplateCategories(
  template: string | null,
): Readonly<Record<string, JevCategory>> | null {
  if (template === null || !Object.hasOwn(JEV_TEMPLATE_CATEGORIES, template)) return null;
  return JEV_TEMPLATE_CATEGORIES[template];
}
