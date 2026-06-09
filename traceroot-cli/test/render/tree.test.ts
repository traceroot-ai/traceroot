import { describe, it, expect } from "vitest";
import { renderTree, type SpanNode } from "../../src/render/tree.js";

const leaf = (name: string, extra?: Partial<SpanNode>): SpanNode => ({
  spanId: name,
  name,
  children: [],
  ...extra,
});

describe("renderTree", () => {
  it("renders a single root node", () => {
    const result = renderTree(leaf("root"));
    expect(result).toContain("root");
    expect(result.endsWith("\n")).toBe(true);
  });

  it("renders child nodes with tree connector characters", () => {
    const root: SpanNode = {
      spanId: "root",
      name: "root",
      children: [leaf("child-a"), leaf("child-b")],
    };
    const result = renderTree(root);
    expect(result).toContain("child-a");
    expect(result).toContain("child-b");
    // Last child gets └──, non-last gets ├──
    expect(result).toContain("└──");
    expect(result).toContain("├──");
  });

  it("renders deeply nested spans", () => {
    const root: SpanNode = {
      spanId: "root",
      name: "root",
      children: [
        {
          spanId: "child",
          name: "child",
          children: [leaf("grandchild")],
        },
      ],
    };
    const result = renderTree(root);
    expect(result).toContain("grandchild");
  });

  it("appends service name in brackets when provided", () => {
    const result = renderTree(leaf("http.request", { service: "api-gateway" }));
    expect(result).toContain("[api-gateway]");
  });

  it("appends duration when provided", () => {
    const result = renderTree(leaf("db.query", { durationMs: 42 }));
    expect(result).toContain("42ms");
  });

  it("appends ERROR marker for error-status spans", () => {
    const result = renderTree(leaf("broken", { status: "error" }));
    expect(result).toContain("ERROR");
  });

  it("does not append ERROR for ok or unset spans", () => {
    expect(renderTree(leaf("ok-span", { status: "ok" }))).not.toContain("ERROR");
    expect(renderTree(leaf("unset-span", { status: "unset" }))).not.toContain("ERROR");
  });
});
