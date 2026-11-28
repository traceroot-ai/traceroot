"use client";

import * as React from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { casesText } from "./coverage";
import { buildComparisonExport, exportFileName, toCsv, toJson } from "./export";
import type { CaseAnalysis } from "./filters";
import type { CaseRow, CompareModel } from "./model";

const FORMATS = {
  csv: { label: "CSV", hint: "For spreadsheets", type: "text/csv;charset=utf-8", write: toCsv },
  json: {
    label: "JSON",
    hint: "With the runs, filters and paired numbers",
    type: "application/json",
    write: toJson,
  },
} as const;

// How long the file's address outlives its link: some browsers cancel a download whose
// address is let go too soon after the click.
const REVOKE_AFTER_MS = 60_000;

/** Hand the browser a file to save, through a link that is gone as soon as it's used. */
function saveFile(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}

/**
 * The toolbar's Export menu: the cases the table shows, in its order, as CSV or JSON. The
 * file is built when a format is picked, from the comparison as it stands then.
 */
export function ExportMenu({
  projectId,
  model,
  cases,
  analysis,
  off,
}: {
  projectId: string;
  model: CompareModel;
  /** The table's cases, in its order. */
  cases: readonly CaseRow[];
  analysis: CaseAnalysis;
  /** Why there is no comparison to export (the runs are loading, say); null when there is. */
  off: string | null;
}) {
  const why = off ?? (cases.length ? null : "No cases match the search or filters");
  const save = (format: keyof typeof FORMATS) => {
    const { type, write } = FORMATS[format];
    const exp = buildComparisonExport(model, {
      projectId,
      rows: cases,
      analysis,
      generatedAt: new Date(),
    });
    saveFile(exportFileName(exp, format), write(exp), type);
  };

  const button = (
    <Button variant="outline" size="sm" className="h-8 gap-1 text-[12px]" disabled={why !== null}>
      <Download className="h-3.5 w-3.5" aria-hidden />
      Export
    </Button>
  );

  if (why !== null) {
    // A disabled button takes no pointer or focus, so the reason hangs off a wrapper.
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="inline-flex">
            {button}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{why}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{button}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>{`${casesText(cases.length)}, in table order`}</DropdownMenuLabel>
        {(Object.keys(FORMATS) as (keyof typeof FORMATS)[]).map((format) => (
          <DropdownMenuItem
            key={format}
            className="h-auto flex-col items-start gap-0 py-1.5"
            onSelect={() => save(format)}
          >
            <span className="text-[12px] font-medium">{FORMATS[format].label}</span>
            <span className="text-[12px] text-muted-foreground">{FORMATS[format].hint}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
