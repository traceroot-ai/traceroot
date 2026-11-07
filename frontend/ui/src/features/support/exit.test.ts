import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { exitImpersonation, SUPPORT_ACTIVE_KEY, SUPPORT_RETURN_KEY } from "./exit";

const assign = vi.fn();
const values = new Map<string, string>();

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  values.clear();
  assign.mockReset();
  vi.stubGlobal("window", { location: { assign } });
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

it("restores the employee and returns to the saved console state", async () => {
  values.set(SUPPORT_ACTIVE_KEY, "true");
  values.set(SUPPORT_RETURN_KEY, "/admin?q=customer&page=2");
  const fetch = vi.fn(async () => Response.json({ restored: true }));
  vi.stubGlobal("fetch", fetch);

  await exitImpersonation();

  expect(fetch).toHaveBeenCalledWith("/api/auth/support/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  expect(values.size).toBe(0);
  expect(assign).toHaveBeenCalledWith("/admin?q=customer&page=2");
});

it("prefers an explicit destination over the saved console state", async () => {
  values.set(SUPPORT_RETURN_KEY, "/admin?q=ignored");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ restored: true })),
  );

  await exitImpersonation("/admin?q=preferred");

  expect(assign).toHaveBeenCalledWith("/admin?q=preferred");
});

it("sends an unrestored session to sign-in", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ restored: false })),
  );

  await exitImpersonation();

  expect(assign).toHaveBeenCalledWith("/auth/sign-in");
  expect(values.size).toBe(0);
});

it("preserves markers when the stop request fails", async () => {
  values.set(SUPPORT_ACTIVE_KEY, "true");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 503 })),
  );

  await expect(exitImpersonation()).rejects.toThrow("Could not exit. Please try again.");

  expect(values.get(SUPPORT_ACTIVE_KEY)).toBe("true");
  expect(assign).not.toHaveBeenCalled();
});
