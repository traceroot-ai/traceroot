"use client";

import { useState } from "react";
import { Link } from "lucide-react";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";
import { ApiKeyBlock } from "./ApiKeyBlock";

type Lang = "python" | "typescript";

function LangTabs({ lang, onChange }: { lang: Lang; onChange: (l: Lang) => void }) {
  return (
    <div className="flex border-b border-border">
      {(["python", "typescript"] as Lang[]).map((l) => {
        const isTs = l === "typescript";
        return (
          <button
            key={l}
            type="button"
            onClick={() => !isTs && onChange(l)}
            disabled={isTs}
            className={cn(
              "-mb-px border-b-2 px-3 py-1.5 text-xs font-medium transition-colors",
              lang === l
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground",
              isTs && "cursor-not-allowed opacity-40",
            )}
          >
            {l === "python" ? "Python" : "TypeScript"}
          </button>
        );
      })}
    </div>
  );
}

function ComingSoonOverlay() {
  return (
    <div className="absolute inset-0 flex items-center justify-center rounded-md border border-dashed border-border bg-background/80">
      <span className="rounded-full border border-border bg-muted px-3 py-1 text-[11px] text-muted-foreground">
        coming soon
      </span>
    </div>
  );
}

interface ManualTabProps {
  projectId: string;
}

export function ManualTab({ projectId }: ManualTabProps) {
  const [installLang, setInstallLang] = useState<Lang>("python");
  const [initLang, setInitLang] = useState<Lang>("python");

  return (
    <div className="space-y-6">
      {/* Step 1 */}
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">1. Create an API key</p>
        <ApiKeyBlock projectId={projectId} />
      </div>

      {/* Step 2 */}
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">2. Install SDK</p>
        <LangTabs lang={installLang} onChange={setInstallLang} />
        <div className="relative">
          <div className="border border-border">
            <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
              <span className="text-xs text-muted-foreground">bash</span>
              <CopyButton value="pip install traceroot" className="h-6 w-6" />
            </div>
            <div className="bg-muted px-3 py-2.5 font-mono text-xs">
              <span className="text-blue-600 dark:text-blue-400">pip</span> install traceroot
            </div>
          </div>
          {installLang === "typescript" && <ComingSoonOverlay />}
        </div>
      </div>

      {/* Step 3 */}
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">3. Select your integration</p>
        <div className="flex gap-2">
          <div className="flex w-24 flex-col items-center gap-1.5 border border-border bg-muted/30 py-3">
            <svg
              aria-hidden="true"
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="text-foreground"
            >
              <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.843-3.372 2.02-1.168a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.402-.678zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
            </svg>
            <span className="text-xs font-medium text-foreground">OpenAI</span>
          </div>
          <div className="flex w-24 flex-col items-center gap-1.5 border border-border bg-muted/30 py-3">
            <Link className="h-6 w-6 text-foreground" />
            <span className="text-xs font-medium text-foreground">LangChain</span>
          </div>
        </div>
      </div>

      {/* Step 4 */}
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">4. Initialize TraceRoot</p>
        <LangTabs lang={initLang} onChange={setInitLang} />
        <div className="relative">
          <div className="border border-border">
            <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
              <span className="text-xs text-muted-foreground">python</span>
              <CopyButton value={"import traceroot\ntraceroot.init()"} className="h-6 w-6" />
            </div>
            <div className="bg-muted px-3 py-2.5 font-mono text-xs leading-relaxed">
              <div>
                <span className="text-blue-600 dark:text-blue-400">import</span> traceroot
              </div>
              <div>
                traceroot.<span className="text-purple-600 dark:text-purple-400">init</span>()
              </div>
            </div>
          </div>
          {initLang === "typescript" && <ComingSoonOverlay />}
        </div>
      </div>
    </div>
  );
}
