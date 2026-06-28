// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { CliVerifyCard } from "./CliVerifyCard";

afterEach(() => {
  cleanup();
});

describe("CliVerifyCard", () => {
  it("renders the heading with the provided step number", () => {
    render(<CliVerifyCard step={5} />);
    expect(screen.getByText("5. Verify your traces from the terminal (optional)")).toBeDefined();
  });

  it("shows the three shipped CLI commands", () => {
    const { container } = render(<CliVerifyCard step={1} />);
    const text = container.textContent ?? "";
    expect(text).toContain("npm install -g traceroot-cli");
    expect(text).toContain("traceroot login");
    expect(text).toContain("traceroot traces list");
  });

  it("clarifies the CLI is for verifying traces and uses the public host default", () => {
    const { container } = render(<CliVerifyCard step={1} />);
    const text = container.textContent ?? "";
    expect(text).toContain("read-only CLI");
    expect(text).toContain("doesn't add instrumentation");
    expect(text).toContain("https://app.traceroot.ai");
  });
});
