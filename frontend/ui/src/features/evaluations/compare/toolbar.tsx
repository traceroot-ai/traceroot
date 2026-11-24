"use client";

import * as React from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";

/**
 * Above the comparison table, one row under one rule: the search, then `runs` (the Runs
 * menu), left-aligned.
 */
export function CaseToolbar({
  keyword,
  onChangeKeyword,
  runs,
}: {
  keyword: string;
  onChangeKeyword: (keyword: string) => void;
  /** The Runs menu, after the search. */
  runs: React.ReactNode;
}) {
  return (
    <div className="border-b border-border">
      <div data-toolbar="cases" className="flex min-h-11 flex-wrap items-center gap-3 px-4 py-1">
        <div className="relative min-w-[12rem] max-w-md flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keyword}
            onChange={(e) => onChangeKeyword(e.target.value)}
            placeholder="Search..."
            aria-label="Search cases"
            className="h-8 pl-8 text-[13px]"
          />
        </div>
        {runs}
      </div>
    </div>
  );
}
