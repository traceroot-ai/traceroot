import { describe, expect, it } from "vitest";
import { agentCaptureInput } from "../capture-input.js";

describe("agentCaptureInput", () => {
  it("vouches for the registry's gated write tools only", () => {
    expect(agentCaptureInput("create_alert", {}, {}).keepOutput).toBe(true);
    expect(agentCaptureInput("create_dashboard", {}, {}).keepOutput).toBe(true);
    // A POST that only reads is not a write: its output stays under the policy's own allow-list.
    expect(agentCaptureInput("run_widget_query", {}, {}).keepOutput).toBeUndefined();
    expect(agentCaptureInput("get_alert", {}, {}).keepOutput).toBeUndefined();
    expect(agentCaptureInput("bash", {}, {}).keepOutput).toBeUndefined();
  });
});
