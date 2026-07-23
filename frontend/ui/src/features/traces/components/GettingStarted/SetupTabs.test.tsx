// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { SetupTabs } from "./SetupTabs";

afterEach(() => {
  cleanup();
});

describe("SetupTabs", () => {
  it("defaults to the CLI tab showing the shipped commands", () => {
    const { container } = render(<SetupTabs />);
    const text = container.textContent ?? "";
    expect(text).toContain("npm install -g traceroot-cli");
    expect(text).toContain("traceroot login");
    expect(text).toContain("traceroot traces list");
    expect(text).toContain("https://app.traceroot.ai");
  });

  it("switches to the Prompt tab", () => {
    const { container } = render(<SetupTabs />);
    fireEvent.click(screen.getByText("Prompt"));
    const text = container.textContent ?? "";
    expect(text).toContain("Install the TraceRoot AI skill");
    expect(text).toContain("Claude Code, Codex, Cursor");
    // CLI command no longer rendered once the tab switches.
    expect(text).not.toContain("npm install -g traceroot-cli");
  });

  it("switches to the Skills tab", () => {
    const { container } = render(<SetupTabs />);
    fireEvent.click(screen.getByText("Skills"));
    const text = container.textContent ?? "";
    expect(text).toContain("npx skills add traceroot-ai/traceroot-skills");
  });
});
