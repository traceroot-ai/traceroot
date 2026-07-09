// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { Providers } from "./providers";

beforeEach(() => {
  // jsdom has no matchMedia; next-themes' ThemeProvider needs it.
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: false,
      media: "",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Providers", () => {
  it("renders children inside the provider tree", () => {
    render(
      <Providers>
        <div data-testid="child">hello</div>
      </Providers>,
    );
    expect(screen.getByTestId("child")).toBeDefined();
  });
});
