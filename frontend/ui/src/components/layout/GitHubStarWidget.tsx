"use client";

import { useState, useEffect } from "react";
import { ArrowUpRight, Github, Star, X } from "lucide-react";
import { clientEnv } from "@/env.client";
import { PixelStrip } from "@/components/layout/PixelStrip";

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
    // Sits over the section's top rule: the pixel band is the card's upper edge,
    // so no line is drawn above it.
    <div className="relative -mt-px border-b bg-background p-3">
      <PixelStrip className="rounded-t-[2px]" />
      <div className="rounded-b-[2px] border border-t-0">
        <div className="px-3 pb-3 pt-2.5">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-[13px] font-semibold">
              <Github aria-hidden className="h-4 w-4 shrink-0" />
              traceroot
            </span>
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
          <div className="mt-2 flex items-center justify-between text-[13px]">
            <a
              href={clientEnv.NEXT_PUBLIC_GITHUB_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 font-medium text-brand underline-offset-4 hover:underline"
            >
              Star on GitHub
              <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />
            </a>
            <span className="flex items-center gap-1 text-muted-foreground">
              <Star aria-hidden className="h-3.5 w-3.5 shrink-0" />
              {starCount !== null ? formatStarCount(starCount) : "—"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
