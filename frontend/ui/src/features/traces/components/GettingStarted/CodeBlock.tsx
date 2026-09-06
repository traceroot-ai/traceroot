"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";

interface CodeBlockProps {
  /** Sub-heading shown on the left of the header row (e.g. "bash", "python"). */
  label: string;
  /** The text shown in the body and copied by the header copy button. */
  value: string;
  /** Render the body in a monospace font. Defaults to true. */
  mono?: boolean;
  /** When set, apply lightweight syntax highlighting for that language. */
  language?: "python" | "typescript";
}

const KEYWORDS: Record<NonNullable<CodeBlockProps["language"]>, string[]> = {
  python: [
    "import",
    "from",
    "as",
    "def",
    "class",
    "return",
    "if",
    "elif",
    "else",
    "for",
    "while",
    "in",
    "not",
    "and",
    "or",
    "is",
    "None",
    "True",
    "False",
    "with",
    "try",
    "except",
    "finally",
    "raise",
    "yield",
    "lambda",
    "async",
    "await",
    "pass",
    "break",
    "continue",
    "global",
    "nonlocal",
  ],
  typescript: [
    "import",
    "from",
    "export",
    "const",
    "let",
    "var",
    "function",
    "return",
    "if",
    "else",
    "for",
    "while",
    "class",
    "extends",
    "implements",
    "new",
    "async",
    "await",
    "type",
    "interface",
    "enum",
    "public",
    "private",
    "protected",
    "readonly",
    "of",
    "in",
    "typeof",
    "instanceof",
    "as",
    "default",
    "try",
    "catch",
    "finally",
    "throw",
    "void",
    "null",
    "undefined",
    "true",
    "false",
    "this",
  ],
};

/**
 * Lightweight regex tokenizer — comments, strings, numbers, decorators, and
 * keywords. Not a full parser; enough to preview what highlighted snippets look
 * like without pulling in a syntax-highlighting dependency.
 */
function highlightCode(value: string, language: NonNullable<CodeBlockProps["language"]>) {
  const comment = language === "python" ? "#[^\\n]*" : "\\/\\/[^\\n]*";
  const string = "\"[^\"]*\"|'[^']*'|`[^`]*`";
  const number = "\\b\\d+(?:\\.\\d+)?\\b";
  const keyword = `\\b(?:${KEYWORDS[language].join("|")})\\b`;
  const decorator = "@[\\w.]+";
  const re = new RegExp(`(${comment})|(${string})|(${number})|(${keyword})|(${decorator})`, "g");

  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    if (m.index > last) out.push(<span key={key++}>{value.slice(last, m.index)}</span>);
    const cls = m[1]
      ? "italic text-muted-foreground/60"
      : m[2]
        ? "text-emerald-600 dark:text-emerald-400"
        : m[3]
          ? "text-amber-600 dark:text-amber-400"
          : m[4]
            ? "text-violet-600 dark:text-violet-400"
            : "text-sky-600 dark:text-sky-400";
    out.push(
      <span key={key++} className={cls}>
        {m[0]}
      </span>,
    );
    last = re.lastIndex;
  }
  if (last < value.length) out.push(<span key={key++}>{value.slice(last)}</span>);
  return out;
}

/**
 * Tint the leading package-manager token of each line (npm/npx/pip/…), mirroring
 * the marketing-site hero. Restrained on purpose — only that keyword.
 */
function highlightCommands(value: string) {
  const lines = value.split("\n");
  return lines.map((line, i) => {
    const match = /^(npm|npx|pnpm|yarn|pip|pip3|uv|poetry)(?=\s|$)/.exec(line);
    const newline = i < lines.length - 1 ? "\n" : "";
    if (!match) return <span key={i}>{line + newline}</span>;
    return (
      <span key={i}>
        <span className="text-violet-600 dark:text-violet-400">{match[0]}</span>
        {line.slice(match[0].length) + newline}
      </span>
    );
  });
}

/**
 * The onboarding code-snippet box: a bordered card with a header row carrying a
 * sub-heading label and the copy button, and the content in a <pre> below. This
 * mirrors the Manual tab's "Initialize TraceRoot" block so every snippet across
 * onboarding shares one style and copy-button placement.
 */
export function CodeBlock({ label, value, mono = true, language }: CodeBlockProps) {
  const body = language ? highlightCode(value, language) : mono ? highlightCommands(value) : value;
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        <CopyButton value={value} className="h-6 w-6" />
      </div>
      <pre
        className={cn(
          "overflow-x-auto whitespace-pre-wrap bg-muted px-3 py-2.5 text-xs leading-relaxed text-foreground",
          mono && "font-mono",
        )}
      >
        {body}
      </pre>
    </div>
  );
}
