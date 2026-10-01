"use client";

import { FieldLabel, SectionBox } from "@/features/dashboards/components/SectionBox";
import type { AlertFilter } from "../rule-model";
import { AlertFilters } from "./alert-filters";

interface ScopeSectionProps {
  projectId: string;
  filters: readonly AlertFilter[];
  onFiltersChange: (filters: AlertFilter[]) => void;
}

/**
 * Which spans the alert looks at. First in the form because the condition
 * below is computed over whatever this leaves in. The view is part of the rule
 * but not part of the form — only SPANS exists, and a one-option dropdown
 * would be noise.
 */
export function ScopeSection({ projectId, filters, onFiltersChange }: ScopeSectionProps) {
  return (
    <SectionBox label="Scope">
      <div className="p-3">
        <FieldLabel>Filter</FieldLabel>
        <AlertFilters projectId={projectId} filters={filters} onFiltersChange={onFiltersChange} />
      </div>
    </SectionBox>
  );
}
