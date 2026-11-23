import { describe, it, expect } from "vitest";
import { exportAgentSpan, isSandboxClientSpan } from "../sandbox-spans.js";

const daytona = (component: string, method: string) => ({
  name: `${component}.${method}`,
  attributes: { component, method, "http.response.status_code": 200 },
});

describe("isSandboxClientSpan", () => {
  it("recognises the sandbox client's decorator signature across its classes", () => {
    for (const [c, m] of [
      ["Daytona", "create"],
      ["Sandbox", "refreshData"],
      ["Sandbox", "waitUntilStarted"],
      ["Process", "executeCommand"],
      ["FileSystem", "uploadFile"],
      ["Git", "clone"],
    ]) {
      expect(isSandboxClientSpan(daytona(c as string, m as string))).toBe(true);
    }
  });

  it("keeps the agent's own spans, whatever their attributes", () => {
    expect(isSandboxClientSpan({ name: "bash", attributes: { "tool.name": "bash" } })).toBe(false);
    expect(isSandboxClientSpan({ name: "pi-mono", attributes: {} })).toBe(false);
    expect(isSandboxClientSpan({ name: "gpt-5.6-terra", attributes: {} })).toBe(false);
  });

  it("does not match on the attributes alone: the name must be the decorator's", () => {
    expect(
      isSandboxClientSpan({ name: "bash", attributes: { component: "Process", method: "exec" } }),
    ).toBe(false);
    expect(
      isSandboxClientSpan({
        name: "Process.executeCommand",
        attributes: { component: 7, method: "executeCommand" },
      }),
    ).toBe(false);
  });
});

describe("exportAgentSpan", () => {
  it("is the complement", () => {
    expect(exportAgentSpan(daytona("Process", "executeCommand"))).toBe(false);
    expect(exportAgentSpan({ name: "bash", attributes: {} })).toBe(true);
  });
});
