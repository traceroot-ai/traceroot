"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  RESULT_STATUS_LABEL,
  REVIEW_STATUS_LABEL,
  scopeMeta,
  type ResultStatus,
  type ReviewStatus,
  type Scope,
} from "../types";
import { RESULT_STATUS_VARIANT, REVIEW_STATUS_VARIANT } from "../utils";

/**
 * Only two badges exist in v1: how a result turned out, and how much a case is
 * trusted. Everything else that used to be a chip is now plain text — badges
 * stop meaning anything once every cell has three.
 */

export function StatusBadge({ status }: { status: ResultStatus }) {
  return <Badge variant={RESULT_STATUS_VARIANT[status]}>{RESULT_STATUS_LABEL[status]}</Badge>;
}

export function ReviewBadge({ status }: { status: ReviewStatus }) {
  return <Badge variant={REVIEW_STATUS_VARIANT[status]}>{REVIEW_STATUS_LABEL[status]}</Badge>;
}

/**
 * Scope as quiet text, not a coloured chip. "Whole workflow" is the normal
 * case, so it should not draw the eye — only the narrow scopes are notable.
 */
export function ScopeLabel({ scope, className }: { scope: Scope; className?: string }) {
  const meta = scopeMeta(scope);
  const isDefault = scope === "whole_workflow";
  return (
    <span
      className={cn(
        "text-[12px]",
        isDefault ? "text-muted-foreground" : "text-foreground",
        className,
      )}
    >
      {meta.label}
    </span>
  );
}
