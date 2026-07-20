/**
 * Human-scoring one evaluation result. This is a SCORING action, not a dataset edit:
 * it appends a HumanScore row scoped to the project and never touches the case's
 * expected output. The result must belong to the caller's project. Auth + Prisma mocked.
 */
import { it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  evaluationResult: { findFirst: vi.fn() },
  humanScore: { create: vi.fn() },
}));
const auth = vi.hoisted(() => ({ requireAuth: vi.fn(), requireProjectAccess: vi.fn() }));

vi.mock("@traceroot/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@traceroot/core")>();
  return { ...actual, prisma: prismaMock };
});
vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: auth.requireAuth,
  requireProjectAccess: auth.requireProjectAccess,
  errorResponse: (message: string, status: number) => ({
    status,
    json: async () => ({ error: message }),
  }),
  successResponse: (data: unknown, status = 200) => ({ status, json: async () => data }),
}));

import { POST } from "./route";

const params = { params: Promise.resolve({ projectId: "p1", resultId: "res_1" }) };

const req = (body: unknown) =>
  ({ json: async () => body }) as unknown as Parameters<typeof POST>[0];
const badJsonReq = () =>
  ({
    json: async () => {
      throw new Error("bad json");
    },
  }) as unknown as Parameters<typeof POST>[0];

const valid = { verdict: "pass", quality: 4, comment: "reads well", reviewer: "hao" };

async function body(res: { json: () => Promise<unknown> }) {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireAuth.mockResolvedValue({ user: { id: "u1" } });
  auth.requireProjectAccess.mockResolvedValue({ project: { id: "p1" } });
  prismaMock.evaluationResult.findFirst.mockResolvedValue({ id: "res_1" });
  prismaMock.humanScore.create.mockImplementation(async (args: { data: unknown }) => ({
    id: "hs_1",
    ...(args.data as Record<string, unknown>),
  }));
});

it("appends a human score to a result in the caller's project and 201s", async () => {
  const res = await POST(req(valid), params);
  expect(res.status).toBe(201);
  expect((await body(res)).humanScore).toMatchObject({ id: "hs_1", verdict: "pass", quality: 4 });
  expect(prismaMock.humanScore.create).toHaveBeenCalledWith({
    data: {
      resultId: "res_1",
      projectId: "p1",
      verdict: "pass",
      quality: 4,
      comment: "reads well",
      // The session identity is authoritative: a body `reviewer` is ignored, so a
      // member cannot attribute their judgment to someone else.
      reviewer: "u1",
    },
  });
  // Scoped lookup — a result id from another project cannot be scored.
  expect(prismaMock.evaluationResult.findFirst.mock.calls[0][0].where).toEqual({
    id: "res_1",
    projectId: "p1",
  });
});

it("attributes the score to the signed-in reviewer, not a body-supplied one", async () => {
  auth.requireAuth.mockResolvedValue({ user: { id: "u1", email: "hao@example.com" } });
  await POST(req({ ...valid, reviewer: "someone-else" }), params);
  expect(prismaMock.humanScore.create.mock.calls[0][0].data.reviewer).toBe("hao@example.com");
});

it("stores null for an omitted quality and comment", async () => {
  await POST(req({ verdict: "unsure", reviewer: "hao" }), params);
  expect(prismaMock.humanScore.create.mock.calls[0][0].data).toMatchObject({
    quality: null,
    comment: null,
  });
});

it("400s an unparseable body", async () => {
  const res = await POST(badJsonReq(), params);
  expect(res.status).toBe(400);
  expect(await body(res)).toEqual({ error: "Invalid JSON" });
  expect(prismaMock.humanScore.create).not.toHaveBeenCalled();
});

it("400s an unknown verdict", async () => {
  const res = await POST(req({ verdict: "maybe", reviewer: "hao" }), params);
  expect(res.status).toBe(400);
  expect(prismaMock.humanScore.create).not.toHaveBeenCalled();
});

it("400s a missing reviewer", async () => {
  expect((await POST(req({ verdict: "fail" }), params)).status).toBe(400);
});

it("400s an out-of-range quality", async () => {
  expect((await POST(req({ ...valid, quality: 9 }), params)).status).toBe(400);
});

it("404s a result that is not in this project", async () => {
  prismaMock.evaluationResult.findFirst.mockResolvedValue(null);
  const res = await POST(req(valid), params);
  expect(res.status).toBe(404);
  expect(await body(res)).toEqual({ error: "Evaluation result not found" });
  expect(prismaMock.humanScore.create).not.toHaveBeenCalled();
});

it("401s an unauthenticated caller before touching the database", async () => {
  auth.requireAuth.mockResolvedValue({
    error: { status: 401, json: async () => ({ error: "Unauthorized" }) },
  });
  expect((await POST(req(valid), params)).status).toBe(401);
  expect(prismaMock.evaluationResult.findFirst).not.toHaveBeenCalled();
});

it("403s a viewer without write access", async () => {
  auth.requireProjectAccess.mockResolvedValue({
    error: { status: 403, json: async () => ({ error: "Forbidden" }) },
  });
  expect((await POST(req(valid), params)).status).toBe(403);
  expect(prismaMock.humanScore.create).not.toHaveBeenCalled();
});
