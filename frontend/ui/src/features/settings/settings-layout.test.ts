import { describe, it, expect } from "vitest";
// Asserted against the lucide glyphs directly rather than against DOMAIN_ICONS:
// comparing the tabs to the same registry entry they are built from would pass
// even if a registry entry were repointed at the wrong glyph.
import { Box, Eye, Users } from "lucide-react";
import { WORKSPACE_SETTINGS_TABS, PROJECT_SETTINGS_TABS } from "./settings-layout";

describe("WORKSPACE_SETTINGS_TABS", () => {
  it("gates Model Providers on the model glyph, not the agent one", () => {
    const tab = WORKSPACE_SETTINGS_TABS.find((t) => t.id === "model-providers");
    expect(tab?.icon).toBe(Box);
  });

  it("uses the shared user glyph for Members", () => {
    const tab = WORKSPACE_SETTINGS_TABS.find((t) => t.id === "members");
    expect(tab?.icon).toBe(Users);
  });
});

describe("PROJECT_SETTINGS_TABS", () => {
  it("uses the shared detector glyph for Detectors", () => {
    const tab = PROJECT_SETTINGS_TABS.find((t) => t.id === "detectors");
    expect(tab?.icon).toBe(Eye);
  });
});
