import { describe, expect, it } from "vitest";
import { agentCaptureInput, persistedCaptureInput } from "../capture-input.js";

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

describe("persistedCaptureInput", () => {
  const details = { kind: "dashboard_read", dashboard: { id: "d1", name: "Overview" } };

  it("keeps a card read's details alone, never the text the model read", () => {
    for (const tool of [
      "get_dashboard",
      "get_dashboard_data",
      "get_widget",
      "get_widget_data",
      "get_alert",
      "list_alerts",
    ]) {
      const input = persistedCaptureInput(
        tool,
        { label: "x" },
        {
          content: [{ type: "text", text: "rows the model read" }],
          details,
        },
      );
      expect(input).toEqual({
        toolName: tool,
        args: { label: "x" },
        result: { details },
        keepOutput: true,
      });
    }
  });

  it("leaves a read without card details, and every other tool, as agentCaptureInput does", () => {
    const text = { content: [{ type: "text", text: "Dashboard not found" }] };
    expect(persistedCaptureInput("get_dashboard", {}, text)).toEqual(
      agentCaptureInput("get_dashboard", {}, text),
    );
    expect(
      persistedCaptureInput("get_dashboard", {}, "Error calling get_dashboard").keepOutput,
    ).toBeUndefined();
    expect(
      persistedCaptureInput("run_widget_query", {}, { content: [], details }).keepOutput,
    ).toBeUndefined();
    expect(persistedCaptureInput("create_alert", {}, { details })).toEqual(
      agentCaptureInput("create_alert", {}, { details }),
    );
  });
});
