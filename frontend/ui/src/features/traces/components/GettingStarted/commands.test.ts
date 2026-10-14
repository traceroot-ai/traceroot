import { afterEach, describe, expect, it, vi } from "vitest";

import { cliHostFlag } from "./commands";

/**
 * Imports `setupCommand` against a stated environment.
 *
 * Both env vars are stubbed on every call, never left to the machine running
 * the suite: they are read through `@/env.client`, which parses them once at
 * module load, so the module has to be re-imported after the stub as well.
 */
async function setupCommandWith(env: { apiUrl?: string; appUrl?: string }) {
  // `/api/v1` is the API URL's own schema default, i.e. the same-origin case.
  vi.stubEnv("NEXT_PUBLIC_API_URL", env.apiUrl ?? "/api/v1");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", env.appUrl ?? "");
  vi.resetModules();
  return (await import("./commands")).setupCommand;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("cliHostFlag", () => {
  it("returns nothing for the host the CLI already defaults to", () => {
    // Restating the default only adds a flag a reader has to evaluate.
    expect(cliHostFlag({ apiUrl: "/api/v1", appUrl: "https://app.traceroot.ai" })).toBeNull();
    expect(
      cliHostFlag({ apiUrl: "https://app.traceroot.ai/api/v1", appUrl: undefined }),
    ).toBeNull();
  });

  it("reduces an absolute API URL to its origin", () => {
    // The CLI appends `/api/v1/...` to whatever `--host` is given, so passing
    // the browser's own API path through would request it twice.
    expect(cliHostFlag({ apiUrl: "http://localhost:8000/api/v1", appUrl: undefined })).toBe(
      "http://localhost:8000",
    );
  });

  it("resolves a same-origin API path against the app's own URL", () => {
    // `/api/v1` is the default, and on a self-hosted deployment served behind
    // one origin it is that origin the CLI has to be pointed at.
    expect(cliHostFlag({ apiUrl: "/api/v1", appUrl: "https://traceroot.internal" })).toBe(
      "https://traceroot.internal",
    );
  });

  it("says nothing rather than guessing when the app URL is unknown", () => {
    // A relative API path with no base cannot be resolved. Naming a host here
    // would be inventing one, and the CLI's own default is the better answer.
    expect(cliHostFlag({ apiUrl: "/api/v1", appUrl: undefined })).toBeNull();
    expect(cliHostFlag({ apiUrl: "/api/v1", appUrl: "" })).toBeNull();
    expect(cliHostFlag({ apiUrl: "/api/v1", appUrl: "not-a-url" })).toBeNull();
  });
});

describe("setupCommand", () => {
  it("names the project the panel is already showing", async () => {
    const setupCommand = await setupCommandWith({});

    expect(setupCommand({ projectId: "proj_1" })).toBe(
      "npx -y traceroot-cli@latest setup --project proj_1",
    );
  });

  it("omits the project flag when there is no usable id", async () => {
    // The id arrives from the URL and the output is pasted into a shell, so an
    // id no real project has is dropped rather than quoted into the line.
    const setupCommand = await setupCommandWith({});

    expect(setupCommand({ projectId: "" })).toBe("npx -y traceroot-cli@latest setup");
    expect(setupCommand({ projectId: "proj 1; rm -rf ~" })).toBe(
      "npx -y traceroot-cli@latest setup",
    );
  });

  it("points the CLI at this deployment when it is not the default host", async () => {
    // Without this the command signs in against TraceRoot Cloud on a
    // self-hosted install, which is a different deployment entirely.
    const setupCommand = await setupCommandWith({ apiUrl: "http://localhost:8000/api/v1" });

    expect(setupCommand({ projectId: "proj_1" })).toBe(
      "npx -y traceroot-cli@latest setup --project proj_1 --host http://localhost:8000",
    );
  });

  it("leaves the host out on the deployment the CLI already defaults to", async () => {
    const setupCommand = await setupCommandWith({ appUrl: "https://app.traceroot.ai" });

    expect(setupCommand({ projectId: "proj_1" })).toBe(
      "npx -y traceroot-cli@latest setup --project proj_1",
    );
  });
});
