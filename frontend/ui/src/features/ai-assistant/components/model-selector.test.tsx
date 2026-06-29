// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { ModelSelector } from "./model-selector";
import { SYSTEM_MODELS } from "@traceroot/core";

const mocks = vi.hoisted(() => ({
  data: undefined as unknown,
  onChange: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: mocks.data }),
}));

describe("ModelSelector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default to undefined so it uses FALLBACK_MODELS
    mocks.data = undefined;
  });

  afterEach(() => {
    cleanup();
  });

  it("does NOT trigger onChange when saved selection has no match (preserves BYOK on refresh)", () => {
    // The core bug #1218
    render(
      <ModelSelector
        workspaceId="ws1"
        value={{
          model: "my-custom-model",
          provider: "my-openai",
          source: "byok",
          adapter: "openai",
        }}
        onChange={mocks.onChange}
      />,
    );
    // Since my-custom-model isn't in FALLBACK_MODELS, match is null.
    // value.model is truthy, so it should NOT call onChange with a default.
    expect(mocks.onChange).not.toHaveBeenCalled();
  });

  it("triggers onChange with default pick when value.model is empty", () => {
    render(
      <ModelSelector
        workspaceId="ws1"
        value={{
          model: "",
          provider: "",
          source: "system",
          adapter: "",
        }}
        onChange={mocks.onChange}
      />,
    );
    // Should auto-pick the default model since value.model is empty
    expect(mocks.onChange).toHaveBeenCalledOnce();
    const callArgs = mocks.onChange.mock.calls[0][0];
    expect(callArgs.model).toBeTruthy();
    expect(callArgs.source).toBe("system");
  });

  it("backfills adapter on exact match if missing/stale", () => {
    // e.g. system model exact match
    const sysModelId = SYSTEM_MODELS[0].models[0].id;
    const sysProvider = SYSTEM_MODELS[0].provider;
    const sysAdapter = SYSTEM_MODELS[0].piAIProvider;

    render(
      <ModelSelector
        workspaceId="ws1"
        value={{
          model: sysModelId,
          provider: sysProvider,
          source: "system",
          adapter: "wrong-adapter", // stale/wrong
        }}
        onChange={mocks.onChange}
      />,
    );

    expect(mocks.onChange).toHaveBeenCalledOnce();
    expect(mocks.onChange).toHaveBeenCalledWith({
      model: sysModelId,
      provider: sysProvider,
      source: "system",
      adapter: sysAdapter, // Corrected adapter
    });
  });

  it("backfills fully on model-id-only match", () => {
    const sysModelId = SYSTEM_MODELS[0].models[0].id;
    const sysProvider = SYSTEM_MODELS[0].provider;
    const sysAdapter = SYSTEM_MODELS[0].piAIProvider;

    render(
      <ModelSelector
        workspaceId="ws1"
        value={{
          model: sysModelId,
          provider: "",
          source: "system",
          adapter: "",
        }}
        onChange={mocks.onChange}
      />,
    );

    expect(mocks.onChange).toHaveBeenCalledOnce();
    expect(mocks.onChange).toHaveBeenCalledWith({
      model: sysModelId,
      provider: sysProvider,
      source: "system",
      adapter: sysAdapter,
    });
  });
});
