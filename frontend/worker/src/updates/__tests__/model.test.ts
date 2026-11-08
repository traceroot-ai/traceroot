import { describe, expect, it, vi } from "vitest";

vi.mock("../../detection/sandbox-eval.js", () => ({
  resolveDetectorApiKey: vi.fn(async () => null),
}));
vi.mock("@earendil-works/pi-ai/compat", () => ({
  getEnvApiKey: (provider: string) => (provider === "openai" ? "sk-test-openai" : undefined),
}));
vi.mock("@traceroot/core/model-resolver", () => ({
  fetchProviderConfig: vi.fn(async () => null),
  resolvePiModel: (id: string) => ({ id, provider: id.startsWith("gpt") ? "openai" : "anthropic" }),
}));

const { resolveUpdateModel } = await import("../model.js");
const project = { workspaceId: "w", rcaSource: null, rcaProvider: null, rcaModel: null };

describe("resolveUpdateModel", () => {
  it("takes the first default whose provider has a key", async () => {
    const out = await resolveUpdateModel(project, {});
    expect(out).toMatchObject({ ok: true, isByok: false, model: { id: "gpt-5.4-mini" } });
  });

  it("honours UPDATE_AGENT_MODEL", async () => {
    const out = await resolveUpdateModel(project, { UPDATE_AGENT_MODEL: "gpt-5" });
    expect(out).toMatchObject({ ok: true, model: { id: "gpt-5" } });
  });

  it("says plainly when no key exists for the chosen model", async () => {
    const out = await resolveUpdateModel(project, { UPDATE_AGENT_MODEL: "claude-sonnet-4-5" });
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("claude-sonnet-4-5") });
  });
});
