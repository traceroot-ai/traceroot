import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/auth-helpers", () => ({
  errorResponse: (message: string, status: number) => ({
    status,
    json: async () => ({ error: message }),
  }),
  requireAuth: vi.fn(),
  requireProjectAccess: vi.fn(),
}));

import type { NextRequest } from "next/server";
import { MAX_PAGE, UI_DELETE_REASON, readDeleteReason, readPaging } from "./route-helpers";

const request = (body: unknown) => ({ json: async () => body }) as unknown as Request;

describe("readDeleteReason", () => {
  it("honors a reason the web app sends", async () => {
    expect(await readDeleteReason(request({ reason: "no longer needed" }))).toBe(
      "no longer needed",
    );
  });

  it("falls back to the fixed note when there is no body, no object, or no string reason", async () => {
    const failing = {
      json: async () => {
        throw new SyntaxError("no body");
      },
    } as unknown as Request;
    expect(await readDeleteReason(failing)).toBe(UI_DELETE_REASON);
    expect(await readDeleteReason(request(undefined))).toBe(UI_DELETE_REASON);
    expect(await readDeleteReason(request(["reason"]))).toBe(UI_DELETE_REASON);
    expect(await readDeleteReason(request({ reason: 5 }))).toBe(UI_DELETE_REASON);
  });
});

describe("readPaging", () => {
  const paging = (query: string) =>
    readPaging({
      nextUrl: new URL(`http://localhost/api?${query}`),
    } as unknown as NextRequest);

  it("defaults, and bounds limit and page", () => {
    expect(paging("")).toEqual({ page: 0, limit: 50 });
    expect(paging("page=x&limit=y")).toEqual({ page: 0, limit: 50 });
    expect(paging("page=-3&limit=0")).toEqual({ page: 0, limit: 1 });
    expect(paging("page=4&limit=500")).toEqual({ page: 4, limit: 200 });
  });

  it("caps a huge page so the offset stays a safe integer", () => {
    expect(paging("page=99999999999999999999&limit=200")).toEqual({ page: MAX_PAGE, limit: 200 });
    expect(Number.isSafeInteger(MAX_PAGE * 200)).toBe(true);
  });
});
