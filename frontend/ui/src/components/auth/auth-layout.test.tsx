// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import {
  AgentIdNote,
  AuthBrandPanel,
  AuthError,
  AuthField,
  AuthLayout,
  AuthProviderButton,
  PasswordInput,
} from "./auth-layout";

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
        .map((li) => li.textContent),
    ).toEqual(["trace", "detect", "signals", "verify", "back to your agent in production"]);
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

  it("puts the top action outside the form, and nothing when there is none", () => {
    const { rerender } = render(
      <AuthLayout topAction={<a href="/auth/sign-in">Sign in</a>}>
        <h1>Create your account</h1>
      </AuthLayout>,
    );
    const link = screen.getByRole("link", { name: "Sign in" });
    expect(screen.getByRole("main").contains(link)).toBe(false);

    rerender(
      <AuthLayout>
        <h1>Create your account</h1>
      </AuthLayout>,
    );
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
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

describe("AuthProviderButton", () => {
  it("is disabled, with the reason as its tooltip, until it has a flow to start", () => {
    render(<AuthProviderButton icon={null} label="Continue with X" unavailableReason="Not yet" />);
    const button = screen.getByRole("button", { name: "Continue with X" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Not yet");
  });

  it("starts its flow once it has one", () => {
    const onClick = vi.fn();
    render(<AuthProviderButton icon={null} label="Continue with X" onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Continue with X" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.title).toBe("");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe("AgentIdNote", () => {
  it("keeps its action disabled without a flow and runs it once given one", () => {
    const { rerender } = render(<AgentIdNote />);
    const action = () =>
      screen.getByRole("button", { name: "Continue with AgentID" }) as HTMLButtonElement;
    expect(action().disabled).toBe(true);
    const onClick = vi.fn();
    rerender(<AgentIdNote onClick={onClick} />);
    expect(action().disabled).toBe(false);
    fireEvent.click(action());
    expect(onClick).toHaveBeenCalledOnce();
  });
});
