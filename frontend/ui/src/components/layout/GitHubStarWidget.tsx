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
    <div className="border-b px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium">Star traceroot</span>
        <button
          className="-mr-1 flex h-5 w-5 items-center justify-center rounded-[2px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={() => {
            localStorage.setItem(DISMISSED_KEY, "true");
            setDismissed(true);
          }}
          aria-label="Dismiss"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <p className="mt-0.5 text-[12px] leading-[18px] text-muted-foreground">
        Open source and shipping fast.
        <br />
        Made with ❤️ by contributors.
      </p>
      <a
        href={clientEnv.NEXT_PUBLIC_GITHUB_REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="btn-group mt-2.5 flex w-full text-[12px] font-medium"
      >
        <span className="flex h-7 flex-1 items-center justify-center gap-1.5 bg-background px-2 transition-colors hover:bg-muted">
          <Github className="h-3.5 w-3.5 shrink-0" />
          traceroot
        </span>
        <span className="flex h-7 shrink-0 items-center gap-1 bg-background px-3 text-muted-foreground">
          ★ {starCount !== null ? formatStarCount(starCount) : "—"}
        </span>
      </a>
    </div>
  );
}
