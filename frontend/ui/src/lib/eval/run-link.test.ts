import { afterEach, describe, expect, it, vi } from "vitest";
import { appBaseUrl, runLink } from "./run-link";

describe("runLink", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("builds the link on the configured web origin", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com");
    expect(runLink("p1", "r1")).toEqual({
      run_path: "/projects/p1/evaluations/r1",
      run_url: "https://app.example.com/projects/p1/evaluations/r1",
    });
  });

  it("falls back to the default origin when none is configured", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(appBaseUrl()).toBe("http://localhost:3000");
  });

  it.each([
    "not a url",
    "mailto:ops@example.com",
    "javascript:alert(1)",
    "ftp://files.example.com",
  ])("falls back instead of failing when the configured origin is %s", (configured) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("NEXT_PUBLIC_APP_URL", configured);
    expect(runLink("p1", "r1").run_url).toBe("http://localhost:3000/projects/p1/evaluations/r1");
  });
});
