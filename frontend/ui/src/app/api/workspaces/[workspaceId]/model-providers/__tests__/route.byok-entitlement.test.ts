import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import { pathToFileURL } from "url";

const mockRequireAuth = vi.fn();
const mockRequireWorkspaceMembership = vi.fn();
const mockWorkspaceFindUnique = vi.fn();
const mockProviderFindMany = vi.fn();
const mockProviderUpsert = vi.fn();

vi.mock("@/lib/auth-helpers", () => ({
  requireAuth: (...a: unknown[]) => mockRequireAuth(...a),
  requireWorkspaceMembership: (...a: unknown[]) => mockRequireWorkspaceMembership(...a),
  errorResponse: (msg: string, s: number) =>
    new Response(JSON.stringify({ error: msg }), { status: s }),
  successResponse: (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s }),
}));

vi.mock("@traceroot/core", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    prisma: {
      workspace: { findUnique: (...a: unknown[]) => mockWorkspaceFindUnique(...a) },
      modelProvider: {
        findMany: (...a: unknown[]) => mockProviderFindMany(...a),
        upsert: (...a: unknown[]) => mockProviderUpsert(...a),
      },
    },
    Role: { ADMIN: "ADMIN" },
    encryptKey: (v: string) => `cipher:${v}`,
    maskKey: (v: string) => `sk-...${v.slice(-4)}`,
  };
});

const routePath = path.join(__dirname, "..", "route.ts");
const params = { params: Promise.resolve({ workspaceId: "ws-1" }) };

const validBody = {
  adapter: "openai",
  provider: "my-openai",
  apiKey: "sk-test-abcd",
};

async function getByokEnabled(billingPlan: string): Promise<boolean> {
  mockWorkspaceFindUnique.mockResolvedValue({ billingPlan });
  mockProviderFindMany.mockResolvedValue([]);
  const mod = await import(pathToFileURL(routePath).href);
  const res = await mod.GET(new Request("http://localhost/"), params);
  return (await res.json()).byokEnabled;
}

async function postStatus(billingPlan: string): Promise<number> {
  mockWorkspaceFindUnique.mockResolvedValue({ billingPlan });
  mockProviderUpsert.mockResolvedValue({ id: "mp-1", provider: "my-openai" });
  const mod = await import(pathToFileURL(routePath).href);
  const res = await mod.POST(
    new Request("http://localhost/", { method: "POST", body: JSON.stringify(validBody) }),
    params,
  );
  return res.status;
}

// `workspace.billingPlan` is free-form TEXT, so a legacy, rolled-back or
// mistyped plan name reaches hasEntitlement. Casting it to PlanType asserts at
// compile time and validates nothing, and an unrecognized plan is absent from
// the entitlement table — so BYOK, which every plan including Free grants, was
// refused outright. Narrowing fails closed to FREE, making the worst case a
// known plan rather than no plan at all.
describe("model-providers BYOK entitlement", () => {
  beforeEach(() => {
    vi.stubEnv("ENABLE_BILLING", "true");
    mockRequireAuth.mockResolvedValue({ user: { id: "u-1" }, error: null });
    mockRequireWorkspaceMembership.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("GET: an unrecognized plan resolves BYOK exactly like an explicit free", async () => {
    const free = await getByokEnabled("free");
    expect(free).toBe(true);

    for (const plan of ["legacy-team", "Pro", "pro ", ""]) {
      expect(await getByokEnabled(plan)).toBe(free);
    }
  });

  it("GET: recognized plans are unaffected", async () => {
    for (const plan of ["free", "starter", "pro", "enterprise"]) {
      expect(await getByokEnabled(plan)).toBe(true);
    }
  });

  it("POST: an unrecognized plan is not refused, and matches explicit free", async () => {
    const free = await postStatus("free");
    expect(free).toBe(201);

    for (const plan of ["legacy-team", "Pro"]) {
      const status = await postStatus(plan);
      expect(status).not.toBe(403);
      expect(status).toBe(free);
    }
  });

  it("POST: a recognized paid plan still creates the provider", async () => {
    expect(await postStatus("pro")).toBe(201);
    expect(mockProviderUpsert).toHaveBeenCalled();
  });
});
