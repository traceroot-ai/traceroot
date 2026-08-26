"use client";

import { Badge } from "@/components/ui/badge";
import {
  EVAL_RESULT_STATUS_LABEL,
  RESULT_STATUS_LABEL,
  REVIEW_STATUS_LABEL,
  type EvalResultStatus,
  type ResultStatus,
  type ReviewStatus,
} from "../types";
import { RESULT_STATUS_VARIANT, REVIEW_STATUS_VARIANT } from "../utils";

/**
 * Evaluation-result variants. "Errored" is amber rather than red so a broken
 * run reads differently from a judged-and-failed one, and "Not scored" is a
 * plain outline so it can never be mistaken for a score of zero.
 */
const EVAL_RESULT_VARIANT: Record<EvalResultStatus, "success" | "danger" | "warning" | "outline"> =
  {
    passed: "success",
    failed: "danger",
    errored: "warning",
    not_scored: "outline",
  };

export function EvalResultBadge({ status }: { status: EvalResultStatus }) {
  return <Badge variant={EVAL_RESULT_VARIANT[status]}>{EVAL_RESULT_STATUS_LABEL[status]}</Badge>;
}

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
