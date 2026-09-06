// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { TraceIOSection } from "./TraceIOValue";

afterEach(() => cleanup());

describe("TraceIOSection", () => {
  it("shows a dash when there is no content", () => {
    render(<TraceIOSection title="Input" content={null} />);
    expect(screen.getByText("-")).toBeDefined();
  });

  it("renders the title header", () => {
    render(<TraceIOSection title="Input" content={'{"a":1}'} />);
    expect(screen.getByText("Input")).toBeDefined();
  });

  it("has no format switcher (matches the production trace-detail chrome)", () => {
    render(<TraceIOSection title="Input" content={'{"a":1}'} />);
    expect(screen.queryByTitle("Change format")).toBeNull();
  });

  it("shows a loading state while I/O is in flight", () => {
    render(<TraceIOSection title="Output" content={"x"} loading />);
    expect(screen.getByText("Loading…")).toBeDefined();
  });

  it("renders a genuine string as-is", () => {
    render(<TraceIOSection title="Output" content={"hello world"} />);
    // ContentRenderer shows a non-JSON string through the JSON tree (quoted).
    expect(screen.getByText("hello world", { exact: false })).toBeDefined();
  });
});
