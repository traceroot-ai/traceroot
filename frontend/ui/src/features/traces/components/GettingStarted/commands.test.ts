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
  it("names a deployment whose hosts carry an underscore", () => {
    // `_` is legal in a URL host and ordinary in container and internal DNS
    // names, and it is special to no shell. When the class that vets these
    // origins excluded it, such a deployment lost both flags and the bare
    // command the panel then rendered sent the CLI to TraceRoot Cloud.
    expect(
      cliHostFlags({ apiUrl: "http://app_internal:8000/api/v1", appUrl: "http://web_1:3000" }),
    ).toEqual({ host: "http://app_internal:8000", authHost: "http://web_1:3000" });
    // And on the same-origin default, where the app URL is the only input.
    expect(cliHostFlags({ apiUrl: "/api/v1", appUrl: "http://app_internal:3000" })).toEqual({
      host: "http://app_internal:3000",
      authHost: null,
    });
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

describe("setupCommand with a handoff", () => {
  // Shaped like the mint answers it: `trh_` and 43 base64url characters,
  // including both of the alphabet's non-alphanumerics.
  const CODE = "trh_abcdefghijklmnopqrstuvwxyz0123456789-_ABC";

  it("carries the code as a bare word, after the project", async () => {
    // Unquoted on purpose, and the whole line is asserted so the position is
    // pinned too: base64url is `[A-Za-z0-9_-]`, a strict subset of the class
    // this file already certifies as safe to print unquoted for the project id,
    // and none of those characters is special to a shell.
    const setupCommand = await setupCommandWith({ appUrl: "https://app.traceroot.ai" });

    expect(setupCommand({ projectId: "proj_1", handoff: CODE })).toBe(
      `npx -y traceroot-cli@0.6.1 setup --project proj_1 --handoff ${CODE}`,
    );
  });

  it("prints today's working command when there is no code", async () => {
    // The mint failing must degrade to the status quo, not to a blank step: the
    // command below is exactly what this page printed before handoffs existed.
    // It still works — `setup` falls into the device flow and the user approves
    // it in a second browser page, which is the page this flag exists to avoid
    // rather than a thing the flow needs.
    const setupCommand = await setupCommandWith({ appUrl: "https://app.traceroot.ai" });
    const unaided = "npx -y traceroot-cli@0.6.1 setup --project proj_1";

    expect(setupCommand({ projectId: "proj_1" })).toBe(unaided);
    expect(setupCommand({ projectId: "proj_1", handoff: null })).toBe(unaided);
    expect(setupCommand({ projectId: "proj_1", handoff: "" })).toBe(unaided);
  });

  it("keeps the project flag on the line in both cases", async () => {
    // Not redundant with the two above: `--project` is what makes the *expired*
    // handoff cheap. The CLI falls back to the device flow and `chooseProject`
    // resolves from this flag, so dropping it would give the degraded path a
    // prompt the undegraded path never shows.
    const setupCommand = await setupCommandWith({ appUrl: "https://app.traceroot.ai" });

    expect(setupCommand({ projectId: "proj_1", handoff: CODE })).toContain("--project proj_1");
    expect(setupCommand({ projectId: "proj_1", handoff: null })).toContain("--project proj_1");
  });

  it("drops a code a shell would not read as one word", async () => {
    // Nothing the mint returns should look like this, which is the point: a
    // value that is not a bare word is not a code this page can print, and the
    // command without it already works. Quoting it instead would be guessing at
    // a value whose shape the contract says is impossible.
    const setupCommand = await setupCommandWith({ appUrl: "https://app.traceroot.ai" });

    for (const handoff of ["trh_a b", "trh_a;rm -rf ~", "trh_a'b", "trh_$(id)", "trh_a`b`"]) {
      expect(setupCommand({ projectId: "proj_1", handoff })).toBe(
        "npx -y traceroot-cli@0.6.1 setup --project proj_1",
      );
    }
  });

  it("stays before the host flags on a self-hosted deployment", async () => {
    // Both halves of the line at once: a deployment that needs `--host` and
    // `--auth-host` is also the one where the handoff is redeemed against the
    // auth host, so the flags have to coexist rather than one replacing the
    // other.
    const setupCommand = await setupCommandWith({
      apiUrl: "http://localhost:8000/api/v1",
      appUrl: "http://localhost:3000",
    });

    expect(setupCommand({ projectId: "proj_1", handoff: CODE })).toBe(
      `npx -y traceroot-cli@0.6.1 setup --project proj_1 --handoff ${CODE} ` +
        "--host 'http://localhost:8000' --auth-host 'http://localhost:3000'",
    );
  });
  it("points setup at a deployment named the way a container network names it", async () => {
    // The whole harm in one line: an underscore in the host used to cost both
    // flags, and the bare command that was left defaults to TraceRoot Cloud,
    // so a self-hosted operator's sign-in and first traces left their network.
    const setupCommand = await setupCommandWith({
      apiUrl: "http://app_internal:8000/api/v1",
      appUrl: "http://web_1:3000",
    });

    expect(setupCommand({ projectId: "proj_1" })).toBe(
      "npx -y traceroot-cli@0.6.1 setup --project proj_1 " +
        "--host 'http://app_internal:8000' --auth-host 'http://web_1:3000'",
    );
  });

  it("never lets a quote reach the line", async () => {
    // `http://%27.com` parses to `http://'.com`, and a single-quoted word
    // cannot carry a single quote, so there is no quoting that would make this
    // origin safe. Dropping the flags keeps it out of the line entirely.
    const setupCommand = await setupCommandWith({ appUrl: "http://%27.com" });
    const line = setupCommand({ projectId: "proj_1" });

    expect(line).toBe("npx -y traceroot-cli@0.6.1 setup --project proj_1");
    expect(line).not.toContain("'");
  });
});
