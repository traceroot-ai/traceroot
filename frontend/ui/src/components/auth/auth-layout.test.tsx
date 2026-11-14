// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { AuthBrandPanel, AuthError, AuthField, AuthLayout, PasswordInput } from "./auth-layout";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AuthBrandPanel", () => {
  it("names the product and shows the improvement loop in order", () => {
    render(<AuthBrandPanel />);
    expect(screen.getByRole("img", { name: "traceroot" })).toBeTruthy();
    const loop = screen.getByRole("list", { name: "The improvement loop" });
    expect(
      within(loop)
        .getAllByRole("listitem")
        .map((li) => li.textContent?.replace("->", "")),
    ).toEqual(["trace", "detect", "evaluate", "improve"]);
  });

  // Browsers without a 2D canvas context (and jsdom) get the static panel.
  it("renders without a canvas context", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(() => render(<AuthBrandPanel />)).not.toThrow();
    expect(screen.getByText("Backed by Y Combinator")).toBeTruthy();
  });
});

describe("AuthLayout", () => {
  it("renders the page content beside the brand panel", () => {
    render(
      <AuthLayout>
        <h1>Sign in to traceroot</h1>
      </AuthLayout>,
    );
    expect(screen.getByRole("main").textContent).toContain("Sign in to traceroot");
  });
});

describe("PasswordInput", () => {
  it("starts hidden and toggles the value's visibility", () => {
    render(<PasswordInput placeholder="pw" />);
    const input = screen.getByPlaceholderText("pw");
    expect(input.getAttribute("type")).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(input.getAttribute("type")).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(input.getAttribute("type")).toBe("password");
  });

  // react-hook-form's register() hands over a ref; a dropped ref means a form that never sees the value.
  it("forwards its ref to the input", () => {
    const ref = createRef<HTMLInputElement>();
    render(<PasswordInput ref={ref} placeholder="pw" />);
    expect(ref.current).toBe(screen.getByPlaceholderText("pw"));
  });
});

describe("AuthField", () => {
  it("labels its input, so the label focuses it and screen readers announce it", () => {
    render(
      <AuthField label="Password" error="Too short">
        <PasswordInput placeholder="pw" />
      </AuthField>,
    );
    expect(screen.getByLabelText("Password")).toBe(screen.getByPlaceholderText("pw"));
    expect(screen.getByText("Too short")).toBeTruthy();
  });
});

describe("AuthError", () => {
  it("announces the message and renders nothing without one", () => {
    const { rerender } = render(<AuthError message={null} />);
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(<AuthError message="Invalid credentials" />);
    expect(screen.getByRole("alert").textContent).toBe("Invalid credentials");
  });
});
