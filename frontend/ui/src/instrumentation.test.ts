import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({ AUTH_TRUSTED_PROXY_CIDRS: "" }));
vi.mock("@/env", () => ({ env: envMock }));

/**
 * The startup line is the only place an operator can see what the app
 * resolved from AUTH_TRUSTED_PROXY_CIDRS. Without it, a misconfigured or
 * absent range silently collapses multi-hop callers into one shared
 * rate-limit bucket and nothing says so.
 */
describe("instrumentation register", () => {
  let info: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.resetModules();
    info = vi.spyOn(console, "info").mockImplementation(() => {});
    process.env.NEXT_RUNTIME = "nodejs";
  });
  afterEach(() => {
    info.mockRestore();
    delete process.env.NEXT_RUNTIME;
  });

  it("logs the resolved trusted-proxy ranges at server start", async () => {
    envMock.AUTH_TRUSTED_PROXY_CIDRS = "10.0.0.0/8, 172.16.0.0/12";
    const { register } = await import("./instrumentation");
    await register();
    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(/trusted proxies: 10\.0\.0\.0\/8, 172\.16\.0\.0\/12/),
    );
  });

  it("says plainly when none are configured and what that means for chains", async () => {
    envMock.AUTH_TRUSTED_PROXY_CIDRS = "";
    const { register } = await import("./instrumentation");
    await register();
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/trusted proxies: none/));
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/single-entry/));
  });

  it("does nothing on the edge runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";
    const { register } = await import("./instrumentation");
    await register();
    expect(info).not.toHaveBeenCalled();
  });
});
