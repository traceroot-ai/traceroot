import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/support/route-guard", () => ({
  withImpersonationPolicy: (handler: unknown) => handler,
}));

const requireAuth = vi.fn();
const requireWorkspaceMembership = vi.fn();
const findMany = vi.fn();
const findUnique = vi.fn();
const findFirst = vi.fn();
const create = vi.fn();
const update = vi.fn();
const deleteFn = vi.fn();

vi.mock("@/lib/auth-helpers", () => ({
  requireAuth,
  requireWorkspaceMembership,
  errorResponse: (msg: string, status = 400) =>
    new Response(JSON.stringify({ error: msg }), {
      status,
      headers: { "content-type": "application/json" },
    }),
  successResponse: (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    }),
}));

vi.mock("@traceroot/core", () => ({
  Role: { ADMIN: "ADMIN", MEMBER: "MEMBER", VIEWER: "VIEWER" },
  prisma: {
    workspaceModelPrice: {
      findMany,
      findUnique,
      findFirst,
      create,
      update,
      delete: deleteFn,
    },
  },
}));

describe("Custom Model Prices API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/workspaces/[workspaceId]/custom-model-prices", () => {
    it("returns empty list when workspace has no custom model prices", async () => {
      requireAuth.mockResolvedValue({ user: { id: "u_1" } });
      requireWorkspaceMembership.mockResolvedValue({ membership: { role: "MEMBER" } });
      findMany.mockResolvedValue([]);

      const { GET } = await import("./route");
      const res = await GET(
        new NextRequest("http://localhost/api/workspaces/ws_1/custom-model-prices"),
        {
          params: Promise.resolve({ workspaceId: "ws_1" }),
        },
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ prices: [] });
    });

    it("returns formatted list of custom model prices", async () => {
      requireAuth.mockResolvedValue({ user: { id: "u_1" } });
      requireWorkspaceMembership.mockResolvedValue({ membership: { role: "MEMBER" } });
      findMany.mockResolvedValue([
        {
          id: "cmp_1",
          workspaceId: "ws_1",
          modelName: "custom-llama-3",
          matchPattern: "(?i)^custom-llama-3.*$",
          inputPrice: "0.000002",
          outputPrice: "0.000005",
          cacheReadPrice: "0.0000005",
          cacheWritePrice: "0.000002",
          createdBy: "u_1",
          createTime: new Date("2026-10-22T00:00:00Z"),
          updateTime: new Date("2026-10-22T00:00:00Z"),
        },
      ]);

      const { GET } = await import("./route");
      const res = await GET(
        new NextRequest("http://localhost/api/workspaces/ws_1/custom-model-prices"),
        {
          params: Promise.resolve({ workspaceId: "ws_1" }),
        },
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.prices).toHaveLength(1);
      expect(data.prices[0].modelName).toBe("custom-llama-3");
      expect(data.prices[0].inputPrice).toBe(0.000002);
      expect(data.prices[0].outputPrice).toBe(0.000005);
      expect(data.prices[0].cacheReadPrice).toBe(0.0000005);
      expect(data.prices[0].cacheWritePrice).toBe(0.000002);
    });
  });

  describe("POST /api/workspaces/[workspaceId]/custom-model-prices", () => {
    it("rejects non-admin users with 403", async () => {
      requireAuth.mockResolvedValue({ user: { id: "u_1" } });
      requireWorkspaceMembership.mockResolvedValue({
        error: new Response(JSON.stringify({ error: "Requires ADMIN role" }), { status: 403 }),
      });

      const { POST } = await import("./route");
      const req = new NextRequest("http://localhost/api/workspaces/ws_1/custom-model-prices", {
        method: "POST",
        body: JSON.stringify({
          modelName: "test-model",
          inputPrice: 0.001,
          outputPrice: 0.002,
        }),
      });
      const res = await POST(req, {
        params: Promise.resolve({ workspaceId: "ws_1" }),
      });

      expect(res.status).toBe(403);
    });

    it("rejects invalid input with 400", async () => {
      requireAuth.mockResolvedValue({ user: { id: "u_1" } });
      requireWorkspaceMembership.mockResolvedValue({ membership: { role: "ADMIN" } });

      const { POST } = await import("./route");
      const req = new NextRequest("http://localhost/api/workspaces/ws_1/custom-model-prices", {
        method: "POST",
        body: JSON.stringify({
          modelName: "",
          inputPrice: -5,
          outputPrice: 0.002,
        }),
      });
      const res = await POST(req, {
        params: Promise.resolve({ workspaceId: "ws_1" }),
      });

      expect(res.status).toBe(400);
    });

    it("rejects invalid regex pattern with 400", async () => {
      requireAuth.mockResolvedValue({ user: { id: "u_1" } });
      requireWorkspaceMembership.mockResolvedValue({ membership: { role: "ADMIN" } });

      const { POST } = await import("./route");
      const req = new NextRequest("http://localhost/api/workspaces/ws_1/custom-model-prices", {
        method: "POST",
        body: JSON.stringify({
          modelName: "regex-test",
          matchPattern: "[a-z", // unclosed bracket
          inputPrice: 0.001,
          outputPrice: 0.002,
        }),
      });
      const res = await POST(req, {
        params: Promise.resolve({ workspaceId: "ws_1" }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Invalid regular expression");
    });

    it("rejects duplicate modelName with 409", async () => {
      requireAuth.mockResolvedValue({ user: { id: "u_1" } });
      requireWorkspaceMembership.mockResolvedValue({ membership: { role: "ADMIN" } });
      findUnique.mockResolvedValue({ id: "existing_1" });

      const { POST } = await import("./route");
      const req = new NextRequest("http://localhost/api/workspaces/ws_1/custom-model-prices", {
        method: "POST",
        body: JSON.stringify({
          modelName: "duplicate-model",
          inputPrice: 0.001,
          outputPrice: 0.002,
        }),
      });
      const res = await POST(req, {
        params: Promise.resolve({ workspaceId: "ws_1" }),
      });

      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toContain("already exists");
    });

    it("successfully creates custom model price and returns 201", async () => {
      requireAuth.mockResolvedValue({ user: { id: "u_1" } });
      requireWorkspaceMembership.mockResolvedValue({ membership: { role: "ADMIN" } });
      findUnique.mockResolvedValue(null);
      create.mockResolvedValue({
        id: "cmp_new",
        workspaceId: "ws_1",
        modelName: "my-mistral",
        matchPattern: "^my-mistral.*$",
        inputPrice: "0.000003",
        outputPrice: "0.000009",
        cacheReadPrice: null,
        cacheWritePrice: null,
        createdBy: "u_1",
      });

      const { POST } = await import("./route");
      const req = new NextRequest("http://localhost/api/workspaces/ws_1/custom-model-prices", {
        method: "POST",
        body: JSON.stringify({
          modelName: "my-mistral",
          matchPattern: "^my-mistral.*$",
          inputPrice: 0.000003,
          outputPrice: 0.000009,
        }),
      });
      const res = await POST(req, {
        params: Promise.resolve({ workspaceId: "ws_1" }),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.price.id).toBe("cmp_new");
      expect(data.price.inputPrice).toBe(0.000003);
      expect(data.price.outputPrice).toBe(0.000009);
    });
  });

  describe("Single Item Route: PATCH & DELETE", () => {
    it("DELETE returns 404 when price does not exist", async () => {
      requireAuth.mockResolvedValue({ user: { id: "u_1" } });
      requireWorkspaceMembership.mockResolvedValue({ membership: { role: "ADMIN" } });
      findFirst.mockResolvedValue(null);

      const { DELETE } = await import("./[priceId]/route");
      const req = new NextRequest(
        "http://localhost/api/workspaces/ws_1/custom-model-prices/nonexistent",
        {
          method: "DELETE",
        },
      );
      const res = await DELETE(req, {
        params: Promise.resolve({ workspaceId: "ws_1", priceId: "nonexistent" }),
      });

      expect(res.status).toBe(404);
    });

    it("DELETE successfully deletes existing price", async () => {
      requireAuth.mockResolvedValue({ user: { id: "u_1" } });
      requireWorkspaceMembership.mockResolvedValue({ membership: { role: "ADMIN" } });
      findFirst.mockResolvedValue({ id: "cmp_1", workspaceId: "ws_1" });
      deleteFn.mockResolvedValue({ id: "cmp_1" });

      const { DELETE } = await import("./[priceId]/route");
      const req = new NextRequest(
        "http://localhost/api/workspaces/ws_1/custom-model-prices/cmp_1",
        {
          method: "DELETE",
        },
      );
      const res = await DELETE(req, {
        params: Promise.resolve({ workspaceId: "ws_1", priceId: "cmp_1" }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ deleted: true });
    });

    it("PATCH updates price rates", async () => {
      requireAuth.mockResolvedValue({ user: { id: "u_1" } });
      requireWorkspaceMembership.mockResolvedValue({ membership: { role: "ADMIN" } });
      findFirst.mockResolvedValue({ id: "cmp_1", workspaceId: "ws_1", modelName: "my-mistral" });
      update.mockResolvedValue({
        id: "cmp_1",
        workspaceId: "ws_1",
        modelName: "my-mistral",
        matchPattern: null,
        inputPrice: "0.000004",
        outputPrice: "0.000010",
        cacheReadPrice: null,
        cacheWritePrice: null,
      });

      const { PATCH } = await import("./[priceId]/route");
      const req = new NextRequest(
        "http://localhost/api/workspaces/ws_1/custom-model-prices/cmp_1",
        {
          method: "PATCH",
          body: JSON.stringify({
            inputPrice: 0.000004,
            outputPrice: 0.00001,
          }),
        },
      );
      const res = await PATCH(req, {
        params: Promise.resolve({ workspaceId: "ws_1", priceId: "cmp_1" }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.price.inputPrice).toBe(0.000004);
      expect(data.price.outputPrice).toBe(0.00001);
    });
  });
});
