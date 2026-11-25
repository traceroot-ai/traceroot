"use client";

import { FieldLabel, SectionBox } from "@/features/dashboards/components/SectionBox";
import type { AlertFilter } from "../rule-model";
import { AlertFilters } from "./alert-filters";
import { useT } from "@/lib/i18n/provider";

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
  const t = useT();
  return (
    <SectionBox label={t("alertsForm.scope")}>
      <div className="p-4">
        <FieldLabel>{t("alertsForm.filter")}</FieldLabel>
        <AlertFilters projectId={projectId} filters={filters} onFiltersChange={onFiltersChange} />
      </div>
    </SectionBox>
  );
}
