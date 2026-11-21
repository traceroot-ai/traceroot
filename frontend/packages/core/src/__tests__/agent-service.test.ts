import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentRequestHeaders,
  isUsableSecret,
  INTERNAL_SECRET_HEADER,
  SYSTEM_CALL_HEADER,
} from "../lib/agent-service";

afterEach(() => vi.unstubAllEnvs());

describe("isUsableSecret", () => {
  it.each([undefined, "", "   ", "changeme", " Dev-Internal-Secret ", "internal-secret"])(
    "rejects %j",
    (value) => expect(isUsableSecret(value)).toBe(false),
  );
  it("accepts a generated value", () => expect(isUsableSecret("a".repeat(64))).toBe(true));
});

describe("agentRequestHeaders", () => {
  it("carries the secret and the identity it is given", () => {
    vi.stubEnv("INTERNAL_API_SECRET", "s3cret-value");
    expect(agentRequestHeaders({ userId: "u1", workspaceId: "w1" })).toEqual({
      [INTERNAL_SECRET_HEADER]: "s3cret-value",
      "x-user-id": "u1",
      "x-workspace-id": "w1",
    });
  });

  it("marks a platform call explicitly and sends no user", () => {
    vi.stubEnv("INTERNAL_API_SECRET", "s3cret-value");
    const headers = agentRequestHeaders({ workspaceId: "w1", system: true });
    expect(headers[SYSTEM_CALL_HEADER]).toBe("1");
    expect(headers["x-user-id"]).toBeUndefined();
  });

  it("refuses to build headers without a usable secret", () => {
    vi.stubEnv("INTERNAL_API_SECRET", "changeme");
    expect(() => agentRequestHeaders({ userId: "u1" })).toThrow("INTERNAL_API_SECRET");
  });
});
