"use client";

import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/i18n/provider";
import {
  EVAL_RESULT_STATUS_LABEL_KEY,
  RESULT_STATUS_LABEL_KEY,
  REVIEW_STATUS_LABEL_KEY,
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
  const t = useT();
  return (
    <Badge variant={EVAL_RESULT_VARIANT[status]}>{t(EVAL_RESULT_STATUS_LABEL_KEY[status])}</Badge>
  );
}

/**
 * Two badges: how a result turned out, and whether a case has been reviewed.
 * Span kind uses the real `SpanKindBadge` from @/features/traces, so a span
 * reads the same here as in the trace viewer.
 */

export function StatusBadge({ status }: { status: ResultStatus }) {
  const t = useT();
  return (
    <Badge variant={RESULT_STATUS_VARIANT[status]}>{t(RESULT_STATUS_LABEL_KEY[status])}</Badge>
  );
}

export function ReviewBadge({ status }: { status: ReviewStatus }) {
  const t = useT();
  return (
    <Badge variant={REVIEW_STATUS_VARIANT[status]}>{t(REVIEW_STATUS_LABEL_KEY[status])}</Badge>
  );
}
