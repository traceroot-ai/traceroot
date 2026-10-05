/**
 * What to tell a reader about tool output the capture policy did not keep.
 *
 * Every surface that shows a step after the run — the persisted chat step,
 * the tool span's output and the tool message inside an LLM span's input —
 * gets its wording here, so the same fact reads the same everywhere and never
 * as a bare policy verdict ("[withheld: not-allowlisted; 2175 bytes]" read as
 * an error to a reviewer who had not written the policy, 2026-09-14).
 *
 * The policy itself is unchanged (design B7): shell, file and git output is
 * shown while the run streams but not stored; trace and session downloads
 * are kept. This module is dependency-free on purpose — it is imported by the
 * Next.js client as well as the agent, unlike `capture-policy` (Buffer).
 */
export type CaptureVerdict = {
  withheld?: "not-allowlisted" | "budget" | null;
  /** Whether what was kept (args or result) was cut at the per-step limit. */
  truncated?: boolean;
  /** What the tool actually returned, in bytes, before any capture. */
  outputBytes?: number | null;
};

export type CaptureNote = {
  /** The one-line statement of what is missing, with the size returned. */
  text: string;
  /** The reason, in the reader's terms — a tooltip in the UI, a second sentence in a span. */
  why: string;
};

const WHY_NOT_ALLOWLISTED =
  "Shell, file and git output can include your source code and secrets, so it is shown " +
  "while the run streams but not kept afterwards. Trace and session downloads are kept.";
const WHY_BUDGET =
  "Each run keeps a bounded amount of tool output; once that is used up, later steps " +
  "record only how much they returned.";
const WHY_TRUNCATED =
  "Long results are kept only up to a fixed size per step. The full result was shown " +
  "while the run streamed.";

function returned(c: CaptureVerdict): string {
  return c.outputBytes != null ? ` (${c.outputBytes.toLocaleString("en-US")} bytes returned)` : "";
}

/**
 * The note for a step whose output the policy withheld or cut, or null when
 * the whole result was kept and there is nothing to explain.
 */
export function describeCapture(c: CaptureVerdict): CaptureNote | null {
  if (c.withheld === "not-allowlisted") {
    return { text: `Output not stored after the run${returned(c)}`, why: WHY_NOT_ALLOWLISTED };
  }
  if (c.withheld === "budget") {
    return {
      text: `Output not stored: this run reached its limit for stored tool output${returned(c)}`,
      why: WHY_BUDGET,
    };
  }
  if (c.truncated) {
    return { text: `Output stored up to the per-step limit${returned(c)}`, why: WHY_TRUNCATED };
  }
  return null;
}

/**
 * The text that stands in for a withheld result where only a string fits — a
 * tool span's output, a tool message rendered into an LLM span's input. The
 * statement and the reason in one, so the span reads on its own.
 */
export function withheldOutputText(c: CaptureVerdict): string {
  const note = describeCapture(c) ?? {
    text: `Output not stored after the run${returned(c)}`,
    why: WHY_NOT_ALLOWLISTED,
  };
  return `${note.text}. ${note.why}`;
}
