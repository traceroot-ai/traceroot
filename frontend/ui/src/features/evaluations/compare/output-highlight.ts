/**
 * The words of a candidate's output that changed against a reference (the baseline's
 * output, or the expected one), for the comparison table to mark. Words are compared as
 * the trace panel compares a changed line (`markChangedWords`), on the text as the table
 * shows it, so the marks land on the words shown.
 */
import { markChangedWords, normalizeForDiff, type DiffSegment } from "@/lib/eval/line-diff";

/** `text`, trimmed as the table shows it, in segments, the changed ones marked; null when
 *  there is nothing to mark: no output, no reference, or the two read the same once
 *  normalized (`normalizeForDiff`, so a reformat or another key order is no change). An
 *  output with no word in common with the reference is marked whole. */
export function changedWords(
  text: string,
  reference: string | null | undefined,
): DiffSegment[] | null {
  const shown = text.trim();
  if (!shown || reference == null) return null;
  const ref = reference.trim();
  if (normalizeForDiff(shown) === normalizeForDiff(ref)) return null;
  const [, after] = markChangedWords([
    { type: "remove", text: ref },
    { type: "add", text: shown },
  ]);
  return after.segments ?? [{ text: shown, changed: true }];
}
