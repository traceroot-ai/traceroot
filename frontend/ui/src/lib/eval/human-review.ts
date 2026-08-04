/**
 * Derived human-review summaries for a run.
 *
 * Human review is a separate, co-equal signal — this module only *reads* review
 * rows and the automated pass/fail judgment; it never mutates either. The summary
 * is intentionally conservative:
 *
 *  - "Configured/active dimensions" are the dimensions that actually have a review
 *    in the run. A dimension with no reviews contributes nothing (so a run nobody
 *    has reviewed reports no pending work — only explicitly-reviewed dimensions do).
 *  - `pending` counts (result × active-dimension) pairs with no canonical review.
 *  - `disagreement` is defined ONLY when a human pass/fail verdict AND a comparable
 *    automated pass/fail both exist and differ. A quality score (1–5) or an "unsure"
 *    verdict is never coerced into a boolean, so it never produces a disagreement.
 */
export type HumanVerdict = "pass" | "fail" | "unsure";

export interface ResultReviewInput {
  /**
   * The automated pass/fail judgment for the result: `true` when the automated
   * status is "passed", `false` when "failed", and `null` when there is no
   * comparable boolean (errored / not-scored). Only a non-null value can disagree.
   */
  automatedPass: boolean | null;
  /** The result's canonical reviews (at most one per dimension). */
  reviews: Array<{ dimension: string; verdict: HumanVerdict }>;
}

export interface HumanReviewSummary {
  /** Dimensions with at least one review in the run — the active/configured set. */
  dimensions: string[];
  /** Results carrying a canonical review in at least one active dimension. */
  reviewedCount: number;
  /**
   * (result × active-dimension) pairs still lacking a review. Zero when no
   * dimension is active — an unreviewed run has nothing "pending".
   */
  pendingCount: number;
  /** Canonical reviews with a pass verdict. */
  passCount: number;
  /** Canonical reviews with a fail verdict. */
  failCount: number;
  /**
   * Reviews whose human pass/fail verdict disagrees with the result's automated
   * pass/fail. "unsure" and quality-only reviews never count.
   */
  disagreementCount: number;
}

export function deriveHumanReviewSummary(results: ResultReviewInput[]): HumanReviewSummary {
  const activeDimensions = new Set<string>();
  const reviewedByDimension = new Map<string, number>();
  let reviewedCount = 0;
  let passCount = 0;
  let failCount = 0;
  let disagreementCount = 0;

  for (const result of results) {
    const dimsOnThisResult = new Set<string>();
    for (const review of result.reviews) {
      activeDimensions.add(review.dimension);
      dimsOnThisResult.add(review.dimension);
      if (review.verdict === "pass") passCount++;
      else if (review.verdict === "fail") failCount++;
      // Disagreement needs BOTH a boolean human verdict and a boolean automated one.
      if (
        result.automatedPass !== null &&
        (review.verdict === "pass" || review.verdict === "fail")
      ) {
        const humanPass = review.verdict === "pass";
        if (humanPass !== result.automatedPass) disagreementCount++;
      }
    }
    if (dimsOnThisResult.size > 0) reviewedCount++;
    for (const dim of dimsOnThisResult) {
      reviewedByDimension.set(dim, (reviewedByDimension.get(dim) ?? 0) + 1);
    }
  }

  const total = results.length;
  const dimensions = [...activeDimensions].sort();
  const pendingCount = dimensions.reduce(
    (sum, dim) => sum + (total - (reviewedByDimension.get(dim) ?? 0)),
    0,
  );

  return { dimensions, reviewedCount, pendingCount, passCount, failCount, disagreementCount };
}
