import { afterEach, describe, expect, it, vi } from "vitest";

import { cliHostFlags } from "./commands";

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

describe("cliHostFlags", () => {
  it("returns nothing for the host the CLI already defaults to", () => {
    // Restating the default only adds a flag a reader has to evaluate.
    expect(cliHostFlags({ apiUrl: "/api/v1", appUrl: "https://app.traceroot.ai" })).toEqual({
      host: null,
      authHost: null,
    });
    expect(
      cliHostFlags({
        apiUrl: "https://app.traceroot.ai/api/v1",
        appUrl: "https://app.traceroot.ai",
      }),
    ).toEqual({ host: null, authHost: null });
  });

  it("reduces an absolute API URL to its origin", () => {
    // The CLI appends `/api/v1/...` to whatever `--host` is given, so passing
    // the browser's own API path through would request it twice.
    expect(
      cliHostFlags({ apiUrl: "http://localhost:8000/api/v1", appUrl: "http://localhost:3000" })
        .host,
    ).toBe("http://localhost:8000");
  });

  it("resolves a same-origin API path against the app's own URL", () => {
    // `/api/v1` is the default, and on a self-hosted deployment served behind
    // one origin it is that origin the CLI has to be pointed at.
    expect(cliHostFlags({ apiUrl: "/api/v1", appUrl: "https://traceroot.internal" })).toEqual({
      host: "https://traceroot.internal",
      // One origin serves both, so sign-in needs no separate host.
      authHost: null,
    });
  });

  it("names the app origin separately when the API is on another one", () => {
    // The device flow and the token mint are web-app routes and do not exist on
    // the API, so `--host` alone would stop setup at sign-in.
    expect(
      cliHostFlags({ apiUrl: "http://localhost:8000/api/v1", appUrl: "http://localhost:3000" }),
    ).toEqual({ host: "http://localhost:8000", authHost: "http://localhost:3000" });
  });

  it("falls back to the origin the rest of the app assumes when none is set", () => {
    // `lib/auth-client.ts` points better-auth at localhost:3000 when the app
    // URL is unset, so that is the deployment this one is configured for —
    // naming it beats omitting the flag and pointing the reader at Cloud.
    for (const appUrl of [undefined, "", "   ", "not-a-url", "mailto:ops@example.com"]) {
      expect(cliHostFlags({ apiUrl: "/api/v1", appUrl })).toEqual({
        host: "http://localhost:3000",
        authHost: null,
      });
    }
  });

  it.each(["http://", "http://[", "//", "http://:8000", "http://%zz.com"])(
    "says nothing when the API URL is malformed outright (%s)",
    (apiUrl) => {
      // A relative or empty value resolves against the base, so reaching here
      // means the value is broken. Substituting the app origin would point API
      // traffic at the UI host on a split deployment.
      expect(cliHostFlags({ apiUrl, appUrl: "http://localhost:3000" })).toEqual({
        host: null,
        authHost: null,
      });
    },
  );

  it("drops both flags rather than render an origin a shell would mangle", () => {
    // A hostname can carry a quote (`http://%27.com` parses to `http://'.com`),
    // which would escape the quoting around it. Half a deployment is worse than
    // none: `--auth-host` beside an omitted `--host` leaves the API on Cloud.
    for (const appUrl of ["http://%27.com", "http://a`b.com", "http://a;b.com", "http://a$b.com"]) {
      expect(cliHostFlags({ apiUrl: "/api/v1", appUrl })).toEqual({ host: null, authHost: null });
    }
  });
});

describe("setupCommand", () => {
  it("resolves to one exact published CLI, never a tag or a range", async () => {
    // Three failures in one assertion, and each has happened or is one edit
    // away. `@latest` is 0.5.0, which has no `setup` subcommand — the line dies
    // with "unknown command 'setup'" — and is resolved per machine against
    // npx's cache besides. A `^` range would be the obvious compromise and is
    // not safe either: `^` is an escape character in Windows `cmd.exe`. And an
    // exact pin is what makes the flags below printable at all, because an
    // option a published CLI does not declare is a fatal usage error rather
    // than something it ignores.
    const setupCommand = await setupCommandWith({ appUrl: "https://app.traceroot.ai" });

    const invocation = setupCommand({ projectId: "proj_1" }).split(" ")[2];
    expect(invocation).toMatch(/^traceroot-cli@\d+\.\d+\.\d+$/);
  });

  it("names the project the caller already has in hand", async () => {
    const setupCommand = await setupCommandWith({ appUrl: "https://app.traceroot.ai" });

    expect(setupCommand({ projectId: "proj_1" })).toBe(
      "npx -y traceroot-cli@0.6.1 setup --project proj_1",
    );
  });

  it("omits the project flag when there is no usable id", async () => {
    // The id arrives from the URL and the output is pasted into a shell, so an
    // id no real project has is dropped rather than quoted into the line.
    const setupCommand = await setupCommandWith({ appUrl: "https://app.traceroot.ai" });

    expect(setupCommand({ projectId: "" })).toBe("npx -y traceroot-cli@0.6.1 setup");
    expect(setupCommand({ projectId: "proj 1; rm -rf ~" })).toBe(
      "npx -y traceroot-cli@0.6.1 setup",
    );
  });

  it("leaves both hosts out on TraceRoot Cloud", async () => {
    // Cloud serves the dashboard and the API behind one origin, and it is the
    // origin the CLI defaults to, so the bare command is already right.
    const setupCommand = await setupCommandWith({ appUrl: "https://app.traceroot.ai" });

    expect(setupCommand({ projectId: "proj_1" })).toBe(
      "npx -y traceroot-cli@0.6.1 setup --project proj_1",
    );
  });

  it("points setup at both halves of the documented self-hosted setup", async () => {
    // `.env.example` and `docker-compose.prod.yml` put the API on :8000 and the
    // app on :3000. Without `--auth-host` the device-code request goes to the
    // API port, where that route does not exist, and setup stops at sign-in.
    const setupCommand = await setupCommandWith({
      apiUrl: "http://localhost:8000/api/v1",
      appUrl: "http://localhost:3000",
    });

    expect(setupCommand({ projectId: "proj_1" })).toBe(
      "npx -y traceroot-cli@0.6.1 setup --project proj_1 " +
        "--host 'http://localhost:8000' --auth-host 'http://localhost:3000'",
    );
  });

  it("names this deployment rather than Cloud when only the API default is set", async () => {
    // The relative `/api/v1` default with no app URL: previously no flag at
    // all, which silently ran setup against TraceRoot Cloud from a local
    // deployment. One origin serves both, so `--auth-host` is not needed.
    const setupCommand = await setupCommandWith({});

    expect(setupCommand({ projectId: "proj_1" })).toBe(
      "npx -y traceroot-cli@0.6.1 setup --project proj_1 --host 'http://localhost:3000'",
    );
  });

  it("quotes an IPv6 origin so the line survives zsh", async () => {
    // Unquoted, zsh reads `[::1]` as a glob and the paste dies with "no matches
    // found" before setup runs.
    const setupCommand = await setupCommandWith({
      apiUrl: "http://[::1]:8000/api/v1",
      appUrl: "http://[::1]:3000",
    });

    expect(setupCommand({ projectId: "proj_1" })).toBe(
      "npx -y traceroot-cli@0.6.1 setup --project proj_1 " +
        "--host 'http://[::1]:8000' --auth-host 'http://[::1]:3000'",
    );
  });
});
