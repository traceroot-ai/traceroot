import { describe, expect, it } from "vitest";
import { deriveStatus } from "../ee/task-groups/status.ts";
import { SUMMARY_COST_ESTIMATE_USD } from "../ee/task-groups/constants.ts";

const base = {
  enabled: true,
  keyConfigured: true,
  spentTodayUsd: 0,
  dailyCostCapUsd: 1,
  groupsExist: false,
};

describe("deriveStatus", () => {
  it("is off until a project turns it on, whatever else is true", () => {
    expect(deriveStatus({ ...base, enabled: false, keyConfigured: false })).toBe("off");
  });
  it("says there is no key when the deployment has none", () => {
    expect(deriveStatus({ ...base, keyConfigured: false })).toBe("no_key");
  });
  it("is capped once the day's remaining budget cannot pay for one summary", () => {
    expect(deriveStatus({ ...base, spentTodayUsd: 1 })).toBe("capped");
    expect(deriveStatus({ ...base, spentTodayUsd: 1 - SUMMARY_COST_ESTIMATE_USD / 2 })).toBe(
      "capped",
    );
    expect(deriveStatus({ ...base, spentTodayUsd: 1 - 2 * SUMMARY_COST_ESTIMATE_USD })).toBe(
      "collecting",
    );
  });
  it("collects until groups exist, then is active", () => {
    expect(deriveStatus(base)).toBe("collecting");
    expect(deriveStatus({ ...base, groupsExist: true })).toBe("active");
  });
});
