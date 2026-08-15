// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { TraceIOSection } from "./TraceIOValue";

afterEach(() => cleanup());

async function pickFormat(label: string) {
  fireEvent.click(screen.getByTitle("Change format"));
  fireEvent.click(await screen.findByRole("button", { name: label }));
}

describe("TraceIOSection format switcher (in header)", () => {
  it("shows a dash and no switcher when there is no content", () => {
    render(<TraceIOSection title="Input" content={null} />);
    expect(screen.getByText("-")).toBeDefined();
    expect(screen.queryByTitle("Change format")).toBeNull();
  });

  it("shows the switcher in the header, defaulting to Pretty", () => {
    render(<TraceIOSection title="Input" content={'{"a":1}'} />);
    const trigger = screen.getByTitle("Change format");
    expect(trigger.textContent).toContain("Pretty");
  });

  it("shows a loading state (and no switcher) while I/O is in flight", () => {
    render(<TraceIOSection title="Output" content={"x"} loading />);
    expect(screen.getByText("Loading…")).toBeDefined();
    expect(screen.queryByTitle("Change format")).toBeNull();
  });

  it("switches a JSON object to syntax-highlighted JSON", async () => {
    render(<TraceIOSection title="Input" content={'{"a":1}'} />);
    await pickFormat("JSON");
    // Pretty-printed and colored: the key and value are their own colored spans.
    const key = screen.getByText('"a"');
    expect(key.className).toContain("text-sky");
    const num = screen.getByText("1");
    expect(num.className).toContain("text-blue");
  });

  it("keeps a genuine string as-is in Text mode", async () => {
    render(<TraceIOSection title="Output" content={"hello world"} />);
    await pickFormat("Text");
    expect(screen.getByText("hello world")).toBeDefined();
  });

  it("renders YAML for an object", async () => {
    render(<TraceIOSection title="Metadata" content={'{"env":"prod","n":2}'} />);
    await pickFormat("YAML");
    expect(screen.getByText(/env: prod/)).toBeDefined();
    expect(screen.getByText(/n: 2/)).toBeDefined();
  });

  it("opens the format popover on Enter from the keyboard (not mouse-only)", () => {
    render(<TraceIOSection title="Input" content={'{"a":1}'} />);
    const trigger = screen.getByTitle("Change format");
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(screen.getByRole("button", { name: "JSON" })).toBeDefined();
  });

  it("truncates oversized content instead of running it through the real renderer", async () => {
    const big = JSON.stringify({ s: "x".repeat(300_000) });
    render(<TraceIOSection title="Output" content={big} />);
    await pickFormat("JSON");
    expect(screen.getByText(/Showing first/)).toBeDefined();
    expect(screen.getByText(/copy to see all/)).toBeDefined();
  });
});
