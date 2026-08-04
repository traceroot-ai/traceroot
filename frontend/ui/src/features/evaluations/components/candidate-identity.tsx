"use client";

import * as React from "react";
import { GitBranch, Cpu, FileText, Server, Boxes } from "lucide-react";
import type { RunProvenance } from "../types";

/**
 * A run's CANDIDATE identity — the model/prompt/code version this run exercised,
 * read straight from the run's declared provenance. This describes the CANDIDATE
 * (the thing under test), never the test cases: a test case is a stable input and
 * is never "using" a model, so nothing here is ever attached to a case.
 *
 * `declared_model` is what the SDK SAID the candidate is; it is distinct from the
 * models actually OBSERVED in a result's trace (shown per-result, where they're
 * measured). When the two could differ we say "declared" explicitly rather than
 * implying the run definitely ran that model.
 *
 * Renders nothing when the SDK reported no provenance — an honest absence beats a
 * row of empty fields.
 */
export function CandidateIdentity({ provenance }: { provenance: RunProvenance | null }) {
  if (!provenance) return null;
  const items = identityItems(provenance);
  if (items.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border bg-muted/20 px-3 py-2 text-[11px]">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Candidate
      </span>
      {items.map((it) => (
        <span key={it.key} className="flex items-center gap-1.5" title={it.title}>
          <it.Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="text-muted-foreground">{it.label}</span>
          <span className="font-medium">{it.value}</span>
        </span>
      ))}
    </div>
  );
}

interface IdentityItem {
  key: string;
  Icon: typeof Cpu;
  label: string;
  value: React.ReactNode;
  title?: string;
}

function shortCommit(commit: string): string {
  return /^[0-9a-f]{7,40}$/i.test(commit) ? commit.slice(0, 7) : commit;
}

function identityItems(p: RunProvenance): IdentityItem[] {
  const items: IdentityItem[] = [];

  if (p.declared_model) {
    items.push({
      key: "model",
      Icon: Cpu,
      // "Declared" is load-bearing: this is what the run SAID it ran, not what the
      // trace observed. Never rendered as a plain "Model" to avoid over-claiming.
      label: "Declared model",
      value: p.declared_model,
      title: "The candidate model the SDK declared for this run (not the observed model)",
    });
  }

  if (p.declared_prompt_version) {
    items.push({
      key: "prompt",
      Icon: FileText,
      label: "Prompt",
      value: p.declared_prompt_version,
    });
  }

  if (p.git_commit || p.git_repository) {
    const commit = p.git_commit ? shortCommit(p.git_commit) : null;
    const repo = p.git_repository ? p.git_repository.replace(/^https?:\/\//, "") : null;
    items.push({
      key: "git",
      Icon: GitBranch,
      label: "Source",
      value: (
        <span className="font-mono">
          {repo ? `${repo}${commit ? "@" : ""}` : ""}
          {commit ?? ""}
          {p.git_ref ? (repo || commit ? ` (${p.git_ref})` : p.git_ref) : ""}
          {p.git_dirty ? (
            <span className="ml-1 font-sans font-normal text-amber-600 dark:text-amber-400">
              · uncommitted changes
            </span>
          ) : null}
        </span>
      ),
      title: "The code version this run exercised",
    });
  }

  if (p.ci_provider) {
    items.push({
      key: "ci",
      Icon: Server,
      label: "CI",
      value: p.ci_build_id ? `${p.ci_provider} #${p.ci_build_id}` : p.ci_provider,
    });
  }

  if (p.sdk_language || p.sdk_version) {
    items.push({
      key: "sdk",
      Icon: Boxes,
      label: "SDK",
      value: [p.sdk_language, p.sdk_version].filter(Boolean).join(" "),
    });
  }

  return items;
}
