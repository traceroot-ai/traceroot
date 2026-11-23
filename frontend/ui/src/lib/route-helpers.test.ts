import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/auth-helpers", () => ({
  errorResponse: (message: string, status: number) => ({
    status,
    json: async () => ({ error: message }),
  }),
  requireAuth: vi.fn(),
  requireProjectAccess: vi.fn(),
}));

import { UI_DELETE_REASON, readDeleteReason } from "./route-helpers";

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
