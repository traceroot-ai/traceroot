"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { FormCard } from "@/features/offline-eval/components";
import { HighlightedCode } from "@/features/offline-eval/components/syntax";
import { useDatasets } from "../hooks";
import type { DatasetRow } from "../types";

/**
 * "Run evaluation" — a copyable SDK starter snippet (not a form), wired to real
 * datasets: the snippet references the
 * selected dataset's real id and current version id. Evaluations run in the
 * customer's app/CI and report back; this panel configures nothing.
 */

type Lang = "python" | "typescript";

/** Strip control characters (including newlines) before embedding free-form
 * text in a source snippet — they have no legitimate reason to appear in a
 * one-line string literal and would otherwise break the snippet across lines. */
function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, "");
}

/** Render as a double-quoted Python string literal. Dataset names are
 * free-form (`z.string().min(1).max(200)`, no character restrictions), so a
 * name containing `"` or `\` must be escaped or the generated snippet is
 * either invalid Python or — worse — breaks out of the string literal. */
function pyStringLiteral(value: string): string {
  const escaped = stripControlChars(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** Render as a double-quoted TS/JS string literal. `JSON.stringify` already
 * produces a valid, fully-escaped double-quoted JS string literal. */
function tsStringLiteral(value: string): string {
  return JSON.stringify(stripControlChars(value));
}

function snippet(lang: Lang, dataset: DatasetRow | undefined): string {
  const name = dataset?.name ?? "My dataset";
  const datasetId = dataset?.id ?? "ds_...";
  const versionId = dataset?.currentVersionId ?? "dsv_...";
  // Plain (comment-safe) values: control characters/newlines stripped so a
  // free-form name can't break out of a `#`/`//` comment onto a new line.
  const commentDatasetId = stripControlChars(datasetId);
  const commentVersionId = stripControlChars(versionId);

  if (lang === "python") {
    const pyName = pyStringLiteral(name);
    const pyDatasetId = pyStringLiteral(datasetId);
    return `import traceroot
from traceroot import evaluate, pull_dataset

# 1. Your application. Point this at your own entry point.
from my_app.support import handle_ticket

# 2. Your scorers. A scorer takes a ScorerContext and returns a Score.
from evals.scorers import routing_accuracy

# Initialize with your TraceRoot API key so the run is reported and traced.
traceroot.initialize()

# 3. Pull the dataset this run measures (its current published version).
#    dataset_id:         ${commentDatasetId}
#    dataset_version_id: ${commentVersionId}
dataset = pull_dataset(${pyDatasetId})

# 4. The task receives EvalCase.input and returns your application's output.
def run_candidate(ticket):
    return handle_ticket(ticket)

result = evaluate(
    name=${pyName},
    data=dataset,
    task=run_candidate,
    scorers=[routing_accuracy],
    candidate_version="git:REPLACE_ME",  # what changed in this run (e.g. a git sha)
)

print(result.to_dict())`;
  }

  const tsName = tsStringLiteral(name);
  return `import * as traceroot from "traceroot";
import { Dataset, evaluate } from "traceroot";

// 1. Your application. Point this at your own entry point.
import { handleTicket } from "./src/support";

// 2. Your scorers. A scorer takes a ScorerContext and returns a Score.
import { routingAccuracy } from "./evals/scorers";

traceroot.initialize();

// 3. The dataset this run measures.
//    datasetId:        ${commentDatasetId}
//    datasetVersionId: ${commentVersionId}
const dataset = new Dataset(${tsName});

// 4. The task receives EvalCase.input and returns your application's output.
async function runCandidate(ticket) {
  return handleTicket(ticket);
}

const result = await evaluate({
  name: ${tsName},
  data: dataset,
  task: runCandidate,
  scorers: [routingAccuracy],
});

console.log(result.toJSON());`;
}

export function RunEvaluationDrawer({
  projectId,
  open,
  onOpenChange,
  datasetId,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prefills and hides the picker when opened from a dataset. */
  datasetId?: string;
}) {
  const { data } = useDatasets(projectId, { limit: 200 });
  const datasets = data?.data ?? [];
  const [lang, setLang] = React.useState<Lang>("python");
  const [chosen, setChosen] = React.useState(datasetId ?? "");

  React.useEffect(() => {
    if (open) setChosen(datasetId ?? datasets[0]?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, datasetId]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onOpenChange]);

  if (!open) return null;

  const dataset = datasets.find((d) => d.id === chosen);
  const code = snippet(lang, dataset);

  return (
    <div className="animate-slide-in-right fixed inset-y-0 right-0 z-50 flex w-[560px] max-w-[96vw] flex-col border-l border-border bg-background shadow-xl">
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-[13px] font-semibold">Copy starter code</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            The evaluation runs in your application or CI environment. Its results are reported back
            to TraceRoot and appear on this page.
          </p>
        </div>
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          aria-label="Close"
          className="mt-0.5 rounded-sm text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 pb-6 pt-3 text-[12px]">
        <FormCard label="Dataset">
          {datasetId ? (
            <p className="text-[13px] font-medium">{dataset?.name ?? chosen}</p>
          ) : (
            <Select value={chosen} onValueChange={setChosen}>
              <SelectTrigger className="h-7 text-[13px]">
                <SelectValue placeholder={datasets.length ? "Select dataset" : "No datasets yet"} />
              </SelectTrigger>
              <SelectContent>
                {datasets.map((item) => (
                  <SelectItem key={item.id} value={item.id} className="text-[12px]">
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormCard>

        <div className="overflow-hidden rounded border border-border">
          <div className="flex items-center justify-between border-b border-border bg-muted/50 px-1.5 py-1">
            <div className="flex items-center gap-0.5">
              {(["python", "typescript"] as Lang[]).map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => setLang(l)}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-xs font-medium transition-colors",
                    lang === l
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {l === "python" ? "Python" : "TypeScript"}
                </button>
              ))}
            </div>
            <CopyButton
              value={code}
              className="h-6 w-6 text-muted-foreground hover:text-foreground"
              title="Copy"
            />
          </div>
          {/* Self-contained scroll box: the code scrolls WITHIN a bounded height
              (independent of the drawer body's scroll), and pb-6 keeps the last line
              clear of the horizontal scrollbar at the pre's bottom edge. */}
          <HighlightedCode
            code={code}
            className="max-h-[55vh] overflow-auto whitespace-pre px-3 pb-6 pt-2.5 font-mono text-[11px] leading-relaxed"
          />
        </div>

        <div className="border border-border">
          <div className="border-b border-border bg-muted/50 px-3 py-1.5">
            <span className="text-[12px] font-medium text-muted-foreground">
              Change these for your application
            </span>
          </div>
          <ul className="flex list-disc flex-col gap-1 py-2 pl-7 pr-3 text-[11px] leading-relaxed text-muted-foreground">
            <li>Import the function that runs your application.</li>
            <li>Map the test-case input into that function.</li>
            <li>Import or define the scorers you want to use.</li>
          </ul>
          <p className="border-t border-border px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
            The dataset id and snapshot id are already filled in.
          </p>
        </div>

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          The task function and the scorers stay in your code. TraceRoot records the run, its
          results, and the traces they produced.
        </p>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-4 py-3">
        <span className="text-[11px] text-muted-foreground">Nothing runs from this panel.</span>
        <Button size="sm" className="h-7 text-[12px]" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      </div>
    </div>
  );
}
