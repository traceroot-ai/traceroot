"use client";

import { Badge } from "@/components/ui/badge";
import {
  RESULT_STATUS_LABEL,
  REVIEW_STATUS_LABEL,
  type ResultStatus,
  type ReviewStatus,
} from "../types";
import { RESULT_STATUS_VARIANT, REVIEW_STATUS_VARIANT } from "../utils";

/**
 * Two badges: how a result turned out, and whether a case has been reviewed.
 * Span kind uses the real `SpanKindBadge` from @/features/traces, so a span
 * reads the same here as in the trace viewer.
 */

export function StatusBadge({ status }: { status: ResultStatus }) {
  return <Badge variant={RESULT_STATUS_VARIANT[status]}>{RESULT_STATUS_LABEL[status]}</Badge>;
}

export function ReviewBadge({ status }: { status: ReviewStatus }) {
  return <Badge variant={REVIEW_STATUS_VARIANT[status]}>{REVIEW_STATUS_LABEL[status]}</Badge>;
}
