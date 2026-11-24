"use client";

import * as React from "react";
import { CopyButton } from "@/components/ui/copy-button";
import {
  diffLinesDetailed,
  markChangedWords,
  sideBySide,
  type DiffLine,
  type SideBySideRow,
} from "@/lib/eval/line-diff";
import { cn } from "@/lib/utils";

/** One side of a comparison: a value (an output, a span's input) as shown, or why there is
 *  none. */
export interface DiffSide {
  /** "Baseline", "Candidate" or "Expected". */
  label: string;
  /** e.g. "#2"; absent for the expected output. */
  tag?: string;
  /** The colour class of the side's run dot, if it has one. */
  dot?: string;
  /** The value as shown (canonical, indented JSON for a structured value); null when
   *  there is none. */
  text: string | null;
  /** Shown in place of a missing value, e.g. "No output"; empty when `error` says it. */
  missing: string;
  /** A task error the run reported, shown above its output. */
  error?: { label: string; message: string } | null;
}

/** Two aligned columns, or one unified diff. */
export type DiffLayout = "columns" | "inline";

const LINE_TINT: Record<DiffLine["type"], string> = {
  add: "bg-success-soft",
  remove: "bg-destructive/10",
  context: "",
};
// A changed word inside a changed line: the line's own colour, stronger.
const WORD_TINT: Record<DiffLine["type"], string> = {
  add: "rounded-[2px] bg-success/25",
  remove: "rounded-[2px] bg-destructive/25",
  context: "",
};
const LINE_SIGN: Record<DiffLine["type"], React.ReactNode> = {
  add: <span className="text-success">+</span>,
  remove: <span className="text-destructive">−</span>,
  context: null,
};

/** One diff line: a sign in the gutter (so a change reads without colour too) and the
 *  text, wrapping under itself rather than under the sign, with the words that changed
 *  marked when the line was compared word by word. */
function Line({ line }: { line: DiffLine }) {
  return (
    <div data-line={line.type} className={cn("flex min-w-0 px-2", LINE_TINT[line.type])}>
      <span aria-hidden className="w-4 shrink-0 select-none">
        {LINE_SIGN[line.type]}
      </span>
      <span data-line-text className="min-w-0 whitespace-pre-wrap break-words">
        {line.segments
          ? line.segments.map((s, i) =>
              s.changed ? (
                <span key={i} data-word={line.type} className={WORD_TINT[line.type]}>
                  {s.text}
                </span>
              ) : (
                s.text
              ),
            )
          : line.text || " "}
      </span>
    </div>
  );
}

/** A side's name and copy button; in an inline diff, also the sign its lines carry. */
function SideHeading({
  side,
  sign,
  valueName,
}: {
  side: DiffSide;
  sign?: "add" | "remove";
  valueName: string;
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2 border-b border-border px-2 py-1">
      <h4 className="flex min-w-0 items-center gap-1.5 text-[12px] font-medium">
        {sign && <span aria-hidden>{LINE_SIGN[sign]}</span>}
        {side.dot && <span className={cn("h-2 w-2 shrink-0 rounded-full", side.dot)} aria-hidden />}
        <span className="truncate">{side.tag ? `${side.label} · ${side.tag}` : side.label}</span>
      </h4>
      {side.text !== null && (
        <CopyButton
          value={side.text}
          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={`Copy ${side.label.toLowerCase()} ${valueName}`}
          title={`Copy ${side.label.toLowerCase()} ${valueName}`}
        />
      )}
    </div>
  );
}

/** A side's task error. Under its own heading it needs no name; above a shared inline diff
 *  it says whose it is (`named`). */
function SideError({ side, named = false }: { side: DiffSide; named?: boolean }) {
  if (!side.error) return null;
  const whose = side.tag ? `${side.label} · ${side.tag}` : side.label;
  return (
    <div className="border-b border-border px-2 py-1.5">
      <p className="text-muted-foreground">
        {named ? `${whose}: ${side.error.label}` : side.error.label}
      </p>
      {side.error.message && (
        <p className="whitespace-pre-wrap break-words text-destructive">{side.error.message}</p>
      )}
    </div>
  );
}

/** What is left to show of one value: its first `max` characters, a line break counted
 *  as one. `take` gives the part of a line that fits, or null once nothing does. */
function room(max: number) {
  let left = max;
  return {
    empty: () => left <= 0,
    take: (line: DiffLine): DiffLine | null => {
      if (left <= 0) return null;
      const shown = line.text.length > left ? cutLine(line, left) : line;
      left -= line.text.length + 1;
      return shown;
    },
  };
}

/** A line's first `max` characters, its changed words cut with it. */
function cutLine(line: DiffLine, max: number): DiffLine {
  let left = max;
  const segments = line.segments?.flatMap((s) => {
    if (left <= 0) return [];
    const text = s.text.slice(0, left);
    left -= s.text.length;
    return [{ ...s, text }];
  });
  return { ...line, text: line.text.slice(0, max), segments };
}

/** Two columns cut to the first `max` characters of each value. */
function previewRows(rows: readonly SideBySideRow[], max: number): SideBySideRow[] {
  const left = room(max);
  const right = room(max);
  const out: SideBySideRow[] = [];
  for (const row of rows) {
    if (left.empty() && right.empty()) break;
    const l = row.left && left.take(row.left);
    const r = row.right && right.take(row.right);
    if (l || r) out.push({ left: l, right: r });
  }
  return out;
}

/** A unified diff cut to the first `max` characters of each value: a shared line counts
 *  against both. */
function previewLines(lines: readonly DiffLine[], max: number): DiffLine[] {
  const before = room(max);
  const after = room(max);
  const out: DiffLine[] = [];
  for (const line of lines) {
    if (before.empty() && after.empty()) break;
    const shown =
      line.type === "remove"
        ? before.take(line)
        : line.type === "add"
          ? after.take(line)
          : [before.take(line), after.take(line)].reduce<DiffLine | null>(
              (a, b) => (a && b ? (a.text.length >= b.text.length ? a : b) : (a ?? b)),
              null,
            );
    if (shown) out.push(shown);
  }
  return out;
}

/** One side's whole value (or its first `max` characters), unmarked, or why it has none. */
function PlainValue({ side, max }: { side: DiffSide; max?: number }) {
  if (side.text === null) {
    return side.missing ? (
      <p className="px-2 py-1.5 font-sans text-muted-foreground">{side.missing}</p>
    ) : null;
  }
  const text = max === undefined ? side.text : side.text.slice(0, max);
  return (
    <div className="py-1">
      {text.split(/\r?\n/).map((line, i) => (
        <Line key={i} line={{ type: "context", text: line }} />
      ))}
    </div>
  );
}

/** "outputs", "inputs"; metadata takes no plural of its own. */
const pluralName = (valueName: string) =>
  valueName === "metadata" ? "metadata values" : `${valueName}s`;

/**
 * Two values compared line by line: as two aligned columns with the changed lines tinted,
 * or as one unified diff, the changed words inside each changed line marked. A side with
 * no value, or a pair too large to align, shows each value whole.
 */
export function ValueDiff({
  before,
  after,
  layout,
  valueName = "output",
  previewChars,
}: {
  before: DiffSide;
  after: DiffSide;
  layout: DiffLayout;
  /** What the two values are, for the copy buttons' names. */
  valueName?: string;
  /** Show only the first this-many characters of each value. They are still compared
   *  (and copied) whole. */
  previewChars?: number;
}) {
  const diff = React.useMemo(() => {
    if (before.text === null || after.text === null) return null;
    const detailed = diffLinesDetailed(before.text, after.text);
    return detailed.truncated ? detailed : { ...detailed, lines: markChangedWords(detailed.lines) };
  }, [before.text, after.text]);
  const unchanged = !!diff && diff.lines.every((l) => l.type === "context");
  const cut =
    previewChars !== undefined &&
    [before.text, after.text].some((t) => t !== null && t.length > previewChars);
  const note = diff?.truncated
    ? `These ${pluralName(valueName)} are too long to compare line by line.`
    : unchanged
      ? "No differences."
      : cut &&
          before.text !== null &&
          after.text !== null &&
          before.text.slice(0, previewChars) === after.text.slice(0, previewChars)
        ? `The first ${previewChars.toLocaleString("en-US")} characters match; the values differ after that.`
        : null;

  if (layout === "inline" && diff && !diff.truncated) {
    return (
      <div className="space-y-1.5">
        {note && <p className="text-muted-foreground">{note}</p>}
        <div className="min-w-0 rounded-md border border-border">
          <div className="grid grid-cols-2">
            <SideHeading side={before} sign="remove" valueName={valueName} />
            <SideHeading side={after} sign="add" valueName={valueName} />
          </div>
          <SideError side={before} named />
          <SideError side={after} named />
          <div className="py-1 font-mono text-[12px] leading-relaxed">
            {(previewChars === undefined ? diff.lines : previewLines(diff.lines, previewChars)).map(
              (line, i) => (
                <Line key={i} line={line} />
              ),
            )}
          </div>
        </div>
      </div>
    );
  }

  const allRows = diff && !diff.truncated ? sideBySide(diff.lines) : null;
  const rows = allRows && previewChars !== undefined ? previewRows(allRows, previewChars) : allRows;
  return (
    <div className="space-y-1.5">
      {note && <p className="text-muted-foreground">{note}</p>}
      <div className="grid min-w-0 grid-cols-2 rounded-md border border-border">
        <div className="min-w-0 border-r border-border">
          <SideHeading side={before} valueName={valueName} />
          <SideError side={before} />
        </div>
        <div className="min-w-0">
          <SideHeading side={after} valueName={valueName} />
          <SideError side={after} />
        </div>
        {rows ? (
          <div className="col-span-2 grid grid-cols-2 py-1 font-mono text-[12px] leading-relaxed">
            {rows.map((row, i) => (
              <React.Fragment key={i}>
                <div className="min-w-0 border-r border-border">
                  {row.left ? <Line line={row.left} /> : <div className="h-full bg-muted/50" />}
                </div>
                <div className="min-w-0">
                  {row.right ? <Line line={row.right} /> : <div className="h-full bg-muted/50" />}
                </div>
              </React.Fragment>
            ))}
          </div>
        ) : (
          <>
            <div className="min-w-0 border-r border-border font-mono text-[12px] leading-relaxed">
              <PlainValue side={before} max={previewChars} />
            </div>
            <div className="min-w-0 font-mono text-[12px] leading-relaxed">
              <PlainValue side={after} max={previewChars} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
