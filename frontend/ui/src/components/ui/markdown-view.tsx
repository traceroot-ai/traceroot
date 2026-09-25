"use client";

import * as React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { remarkUnderline } from "@/lib/remark-underline";
import { highlightCode, normalizeLang } from "@/lib/code-highlight";

/**
 * Rendered markdown for span I/O values — the "Markdown" format in the trace panel's
 * and the editable value block's format switchers. Model output is very often
 * markdown, and reading it raw hides its structure.
 *
 * Supports the full CommonMark + GFM set (bold, italic, strikethrough, inline code,
 * fenced code, lists, headings, links, quotes, tables) plus `<u>` underline via
 * remarkUnderline. Fenced code is syntax-highlighted for Python and JavaScript
 * (TypeScript/JSON alias onto them); other languages render plain.
 *
 * Typography is deliberately compact (11px) to match the surrounding I/O panels.
 */

function CodeBlock({ code, lang }: { code: string; lang: string | null }) {
  const normalized = normalizeLang(lang);
  const tokens = React.useMemo(() => highlightCode(code, normalized), [code, normalized]);
  return (
    <div className="my-1.5 overflow-hidden rounded border border-border">
      {lang && (
        <div className="border-b border-border bg-muted/50 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
          {lang}
        </div>
      )}
      <pre className="whitespace-pre-wrap break-words bg-background px-2 py-1.5 font-mono text-[11px] leading-relaxed">
        {tokens.map((t, i) => (
          <span key={i} className={t.cls}>
            {t.text}
          </span>
        ))}
      </pre>
    </div>
  );
}

const COMPONENTS: Components = {
  p: ({ children }) => <p className="mb-1.5 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="text-muted-foreground line-through">{children}</del>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-sky-600 underline underline-offset-2 dark:text-sky-400"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => (
    <ul className="mb-1.5 list-disc space-y-0.5 pl-4 marker:text-muted-foreground last:mb-0">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-1.5 list-decimal space-y-0.5 pl-4 marker:text-muted-foreground last:mb-0">
      {children}
    </ol>
  ),
  li: ({ children }) => <li>{children}</li>,
  h1: ({ children }) => (
    <h1 className="mb-1.5 mt-2 text-[13px] font-semibold first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-1.5 mt-2 text-[12px] font-semibold first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1 mt-2 text-[11px] font-semibold first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1 mt-2 text-[11px] font-semibold first:mt-0">{children}</h4>
  ),
  h5: ({ children }) => (
    <h5 className="mb-1 mt-2 text-[11px] font-semibold first:mt-0">{children}</h5>
  ),
  h6: ({ children }) => (
    <h6 className="mb-1 mt-2 text-[11px] font-semibold first:mt-0">{children}</h6>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-1.5 border-l-2 border-border pl-2 text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-2 border-border" />,
  table: ({ children }) => (
    <div className="my-1.5 overflow-x-auto">
      <table className="w-full border-collapse text-[11px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border bg-muted/40 px-1.5 py-0.5 text-left font-medium">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-border px-1.5 py-0.5 align-top">{children}</td>
  ),
  // Fenced blocks render through CodeBlock; `pre` just passes them through so the
  // block isn't wrapped in a second <pre>.
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const raw = String(children ?? "");
    const match = /language-([\w+-]+)/.exec(className ?? "");
    // An unlabelled fence has no language-* class, so fall back to a newline check.
    const isBlock = !!match || raw.includes("\n");
    if (isBlock) return <CodeBlock code={raw.replace(/\n$/, "")} lang={match?.[1] ?? null} />;
    return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">{children}</code>;
  },
};

const PLUGINS = [remarkGfm, remarkUnderline];

export function MarkdownView({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn("text-[11px] leading-relaxed [overflow-wrap:anywhere]", className)}>
      <ReactMarkdown remarkPlugins={PLUGINS} components={COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
