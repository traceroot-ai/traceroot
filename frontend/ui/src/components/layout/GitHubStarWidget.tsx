"use client";

import { useState, useEffect } from "react";
import { X, Github } from "lucide-react";
import { clientEnv } from "@/env.client";

const DISMISSED_KEY = "github-star-widget-dismissed";
const STAR_CACHE_KEY = "github-star-count-cache";
const STAR_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const REPO = "traceroot-ai/traceroot";

function formatStarCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function GitHubStarWidget() {
  const [dismissed, setDismissed] = useState(true); // true initially to avoid flash
  const [starCount, setStarCount] = useState<number | null>(null);

  useEffect(() => {
    setDismissed(localStorage.getItem(DISMISSED_KEY) === "true");
  }, []);

  useEffect(() => {
    const cached = localStorage.getItem(STAR_CACHE_KEY);
    if (cached) {
      try {
        const { count, timestamp } = JSON.parse(cached) as { count: number; timestamp: number };
        if (Date.now() - timestamp < STAR_CACHE_TTL) {
          setStarCount(count);
          return;
        }
      } catch {
        // malformed cache entry — fall through to fetch
      }
    }
    fetch(`https://api.github.com/repos/${REPO}`)
      .then((r) => r.json())
      .then((data: { stargazers_count?: number }) => {
        if (typeof data.stargazers_count === "number") {
          setStarCount(data.stargazers_count);
          localStorage.setItem(
            STAR_CACHE_KEY,
            JSON.stringify({ count: data.stargazers_count, timestamp: Date.now() }),
          );
        }
      })
      .catch(() => {});
  }, []);

  if (dismissed) return null;

  return (
    <div className="mx-1.5 mb-1 rounded-md border p-1.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-semibold">Star TraceRoot</span>
        <button
          className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => {
            localStorage.setItem(DISMISSED_KEY, "true");
            setDismissed(true);
          }}
          aria-label="Dismiss"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <p className="mb-2 text-[11px] leading-snug text-muted-foreground">
        Open source and shipping fast.
        <br />
        Made with ❤️ by contributors.
      </p>
      <a
        href={clientEnv.NEXT_PUBLIC_GITHUB_REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="flex w-full overflow-hidden rounded border border-border text-[11px] font-medium transition-colors hover:bg-muted/50"
      >
        <span className="flex items-center gap-1 px-1.5 py-1">
          <Github className="h-3 w-3 shrink-0" />
          traceroot
        </span>
        <span className="flex flex-1 items-center justify-center gap-1 border-l border-border py-1 text-muted-foreground">
          ★ {starCount !== null ? formatStarCount(starCount) : "—"}
        </span>
      </a>
    </div>
  );
}
