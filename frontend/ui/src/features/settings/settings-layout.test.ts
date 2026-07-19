import { describe, it, expect } from "vitest";
import { WORKSPACE_SETTINGS_TABS, PROJECT_SETTINGS_TABS } from "./settings-layout";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";

describe("WORKSPACE_SETTINGS_TABS", () => {
  it("gates Model Providers on the model icon, not Bot (#1517 canonical fix)", () => {
    const tab = WORKSPACE_SETTINGS_TABS.find((t) => t.id === "model-providers");
    expect(tab?.icon).toBe(DOMAIN_ICONS.model);
  });

  it("uses the shared user icon for Members", () => {
    const tab = WORKSPACE_SETTINGS_TABS.find((t) => t.id === "members");
    expect(tab?.icon).toBe(DOMAIN_ICONS.user);
  });
});

describe("PROJECT_SETTINGS_TABS", () => {
  it("uses the shared detector icon for Detectors", () => {
    const tab = PROJECT_SETTINGS_TABS.find((t) => t.id === "detectors");
    expect(tab?.icon).toBe(DOMAIN_ICONS.detector);
  });
});
