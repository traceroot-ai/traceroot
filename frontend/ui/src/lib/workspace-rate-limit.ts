import { isBillingEnabled, prisma } from "@traceroot/core";
import { NextResponse } from "next/server";
import { env } from "@/env";

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
const RATE_LIMIT_HEADERS = [
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "retry-after",
];

/** Run an authorized workspace operation against REST's shared write budget. */
export async function withWorkspaceRateLimit<R extends Response>(
  workspaceId: string,
  operation: () => Promise<R>,
): Promise<R | NextResponse> {
  if (!isBillingEnabled()) return operation();

  const workspace = await prisma.workspace
    .findUnique({
      where: { id: workspaceId },
      select: { billingPlan: true },
    })
    .catch(() => null);
  const unavailable = () =>
    NextResponse.json({ error: "Unable to check request limit" }, { status: 503 });
  if (!workspace) return unavailable();

  const budget = await fetch(`${BACKEND_URL}/api/v1/internal/rate-limit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": env.INTERNAL_API_SECRET,
    },
    body: JSON.stringify({ workspaceId, billingPlan: workspace.billingPlan ?? "free" }),
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
  if (!budget || (budget.status !== 204 && budget.status !== 429)) return unavailable();

  const response =
    budget.status === 429
      ? NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 })
      : await operation();
  for (const name of RATE_LIMIT_HEADERS) {
    const value = budget.headers.get(name);
    if (value !== null) response.headers.set(name, value);
  }
  return response;
}
