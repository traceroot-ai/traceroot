"use client";

import type { ReactNode } from "react";
import { Logo } from "@/components/Logo";
import { cn } from "@/lib/utils";
import type { OAuthClientDisplay } from "@/lib/oauth/client-display";
import { ClientMark } from "./ClientMark";
import { ClientTrustLine } from "./ClientTrustLine";

export const MCP_DOCS_URL = "https://traceroot.ai/docs/mcp/get-started";

// The layout every screen of "connect an assistant" shares (sign-in, project
// picker, consent), so the flow reads as one thing: TraceRoot and the assistant
// joined by a trace line, a title, who vouches for the assistant, one card of the
// same width, and the same footer.
export function ConnectFrame({
  client,
  title,
  children,
  className,
}: {
  client: OAuthClientDisplay | null;
  title: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center overflow-hidden bg-background px-4 pb-8 pt-10 sm:justify-center sm:pt-8">
      <div className={cn("relative w-full max-w-[420px]", className)}>
        <TraceBackdrop />
        <div className="relative">
          <ConnectionHeader client={client} />
        </div>
        <h1 className="relative mt-5 text-center text-[19px] font-semibold leading-snug tracking-tight">
          {title}
        </h1>
        {client && (
          <div className="relative mt-1.5 flex justify-center">
            <ClientTrustLine client={client} />
          </div>
        )}
        <div className="relative mt-6 rounded-lg border bg-card p-5 text-card-foreground shadow-sm sm:p-6">
          {children}
        </div>
        <p className="mt-5 text-center text-[12px] text-muted-foreground">
          Assistants get read-only access to one project.{" "}
          <a
            href={MCP_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            How connecting works
          </a>
        </p>
      </div>
    </div>
  );
}

// TraceRoot's mark and the assistant's, joined like a parent span and its child.
export function ConnectionHeader({ client }: { client: OAuthClientDisplay | null }) {
  return (
    <div
      className="flex items-center justify-center"
      role="img"
      aria-label={client ? `TraceRoot connecting to ${client.name}` : "TraceRoot"}
    >
      <Logo size="md" />
      {client && (
        <>
          <span className="flex w-16 items-center" aria-hidden>
            <span className="h-px flex-1 bg-foreground/25" />
            <span className="h-2 w-2 rounded-full border border-foreground/40 bg-background" />
            <span className="h-px flex-1 border-t border-dashed border-foreground/30" />
          </span>
          <ClientMark client={client} />
        </>
      )}
    </div>
  );
}

// A faint trace waterfall either side of the logo pair: staggered span bars, the
// shape of what TraceRoot shows. Decoration only, kept to the header row so it
// never sits behind text, in the foreground color at low opacity so it follows
// the theme, and faded out at the edges and behind the logos.
function TraceBackdrop() {
  // [row, start, length] on a 52-column grid
  const spans: [number, number, number][] = [
    [0, 2, 48],
    [1, 4, 14],
    [2, 7, 8],
    [3, 10, 6],
    [1, 31, 17],
    [2, 34, 7],
    [3, 42, 6],
  ];
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute -top-2 left-1/2 h-14 w-[520px] -translate-x-1/2 text-foreground opacity-[0.09] [mask-image:linear-gradient(to_right,transparent,black_18%,black_34%,transparent_42%,transparent_58%,black_66%,black_82%,transparent)] dark:opacity-[0.16]"
      viewBox="0 0 260 28"
      fill="currentColor"
    >
      {spans.map(([row, start, length], i) => (
        <rect key={i} x={start * 5} y={2 + row * 7} width={length * 5} height={3} rx={1.5} />
      ))}
    </svg>
  );
}
