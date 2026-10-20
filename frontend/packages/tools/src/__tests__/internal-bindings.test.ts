import { describe, expect, it } from "vitest";
import { INTERNAL_BINDINGS, INTERNAL_WRITE_BINDINGS } from "../internal.js";
import { REGISTRY } from "../registry.generated.js";

describe("agent bindings for signals", () => {
  it("exposes the signal tools to the CLI through the registry", () => {
    const names = REGISTRY.map((entry) => entry.name);
    expect(names).toEqual(
      expect.arrayContaining(["list_signals", "get_signal", "set_signal_status"]),
    );
  });

  it("keeps set_signal_status away from the in-product agent", () => {
    // Resolving or reopening a signal is a person's or a script's decision;
    // binding it for the agent needs its own decision. See internal.ts.
    expect(INTERNAL_WRITE_BINDINGS).not.toHaveProperty("set_signal_status");
    expect(INTERNAL_BINDINGS).not.toHaveProperty("set_signal_status");
  });
});
