"use client";

import * as React from "react";

/**
 * Minimal syntax colouring for the SDK snippets shown in the UI (the dataset
 * hover card and the Run evaluation panel).
 *
 * Deliberately not a real parser: it colours strings, keyword tokens, call
 * names, and object/keyword-argument keys, which is everything these short
 * snippets contain. Same palette as the trace panel's JSON highlighting.
 */

export const CODE_COLORS = {
  fn: "text-purple-600 dark:text-purple-400",
  key: "text-blue-600 dark:text-blue-400",
  string: "text-green-700 dark:text-green-400",
  keyword: "text-sky-700 dark:text-sky-300",
  comment: "text-muted-foreground",
};

/** Keywords worth colouring across both languages the snippets use. */
const KEYWORDS = new Set([
  "import",
  "from",
  "const",
  "let",
  "await",
  "async",
  "return",
  "def",
  "class",
  "new",
  "export",
  "default",
]);

export interface CodeToken {
  text: string;
  cls: string;
}

export function tokenizeCode(code: string): CodeToken[] {
  const out: CodeToken[] = [];
  const push = (text: string, cls: string) => out.push({ text, cls });
  const n = code.length;
  let i = 0;
  const nextNonSpace = (from: number) => {
    let k = from;
    while (k < n && /[^\S\n]/.test(code[k])) k++;
    return code[k];
  };

  while (i < n) {
    const ch = code[i];

    // Comments run to the end of the line (# for Python, // for TypeScript).
    if (ch === "#" || (ch === "/" && code[i + 1] === "/")) {
      let j = i;
      while (j < n && code[j] !== "\n") j++;
      push(code.slice(i, j), CODE_COLORS.comment);
      i = j;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < n) {
        if (code[j] === "\\") {
          j += 2;
          continue;
        }
        if (code[j] === ch) {
          j++;
          break;
        }
        j++;
      }
      // A quoted token followed by ":" is a key, not a value.
      push(code.slice(i, j), nextNonSpace(j) === ":" ? CODE_COLORS.key : CODE_COLORS.string);
      i = j;
      continue;
    }

    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(code[j])) j++;
      const word = code.slice(i, j);
      const nx = nextNonSpace(j);
      push(
        word,
        KEYWORDS.has(word)
          ? CODE_COLORS.keyword
          : nx === "("
            ? CODE_COLORS.fn
            : nx === ":" || nx === "="
              ? CODE_COLORS.key
              : "",
      );
      i = j;
      continue;
    }

    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < n && /\s/.test(code[j])) j++;
      push(code.slice(i, j), "");
      i = j;
      continue;
    }

    push(ch, "");
    i++;
  }
  return out;
}

/** A syntax-coloured code block. The caller supplies the surrounding chrome. */
export function HighlightedCode({ code, className }: { code: string; className?: string }) {
  return (
    <pre className={className}>
      {tokenizeCode(code).map((token, i) => (
        <span key={i} className={token.cls || undefined}>
          {token.text}
        </span>
      ))}
    </pre>
  );
}
