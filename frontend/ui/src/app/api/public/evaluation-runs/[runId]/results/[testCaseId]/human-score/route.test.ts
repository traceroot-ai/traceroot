/**
 * Human review upsert. Bound to (run, test case); one canonical review per
 * (result, dimension). The upsert isn't atomic against a concurrent insert, so a
 * P2002 on the first-review race is retried once rather than surfaced as a 500.
 */
import { it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  evaluationResult: { findFirst: vi.fn() },
  humanScore: { upsert: vi.fn() },
}));
const apiAuth = vi.hoisted(() => ({ requireApiKeyProject: vi.fn() }));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
  NextRequest: class {},
}));
vi.mock("@traceroot/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@traceroot/core")>();
  return { ...actual, prisma: prismaMock };
});
vi.mock("@/lib/eval/auth", () => ({ requireApiKeyProject: apiAuth.requireApiKeyProject }));

import { Prisma } from "@traceroot/core";
import { POST } from "./route";

const params = { params: Promise.resolve({ runId: "run-1", testCaseId: "case-1" }) };
const req = (body: unknown) => ({ json: async () => body }) as unknown as Request;
const validBody = { dimension: "helpfulness", verdict: "pass", reviewer: "u1" };
const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "5" });

async function body(res: { json: () => Promise<unknown> }) {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  apiAuth.requireApiKeyProject.mockResolvedValue({ projectId: "p1" });
  prismaMock.evaluationResult.findFirst.mockResolvedValue({ id: "res-1" });
});

it("records a human score (201)", async () => {
  prismaMock.humanScore.upsert.mockResolvedValue({ id: "hs-1" });
  const res = await POST(req(validBody), params);
  expect(res.status).toBe(201);
  expect(await body(res)).toEqual({ human_score_id: "hs-1" });
});

it("retries once on a P2002 first-review race and succeeds, not a 500", async () => {
  prismaMock.humanScore.upsert.mockRejectedValueOnce(p2002()).mockResolvedValueOnce({ id: "hs-1" });
  const res = await POST(req(validBody), params);
  expect(res.status).toBe(201);
  expect(prismaMock.humanScore.upsert).toHaveBeenCalledTimes(2);
});

it("500s if the retry also fails", async () => {
  prismaMock.humanScore.upsert.mockRejectedValue(p2002());
  const res = await POST(req(validBody), params);
  expect(res.status).toBe(500);
});

it("500s (no retry) on a non-P2002 error", async () => {
  prismaMock.humanScore.upsert.mockRejectedValue(new Error("boom"));
  const res = await POST(req(validBody), params);
  expect(res.status).toBe(500);
  expect(prismaMock.humanScore.upsert).toHaveBeenCalledTimes(1);
});

it("404s when no result backs the (run, test case)", async () => {
  prismaMock.evaluationResult.findFirst.mockResolvedValue(null);
  const res = await POST(req(validBody), params);
  expect(res.status).toBe(404);
  expect(prismaMock.humanScore.upsert).not.toHaveBeenCalled();
});
