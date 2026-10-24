import { afterEach, describe, expect, it, vi } from "vitest";

import { cliHostFlags, type SetupCommand } from "./commands";

/**
 * The two flags, for a configuration this file can resolve.
 *
 * Narrows the discriminated result so the assertions below stay about the
 * flags, and fails loudly rather than silently reading `undefined` off the
 * other arm if a case that used to resolve stops resolving.
 */
function hostFlagsOf(input: { apiUrl: string; appUrl?: string }) {
  const flags = cliHostFlags({ apiUrl: input.apiUrl, appUrl: input.appUrl });
  if (flags.kind !== "resolved") {
    throw new Error(`expected a resolved deployment, got ${flags.kind} (${flags.variable})`);
  }
  return { host: flags.host, authHost: flags.authHost };
}

/** The rendered line, for a deployment that has one. */
function lineOf(result: SetupCommand): string {
  if (result.kind !== "command") {
    throw new Error(`expected a command, got ${result.kind} (${result.variable})`);
  }
  return result.command;
}

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
    expect(hostFlagsOf({ apiUrl: "/api/v1", appUrl: "https://app.traceroot.ai" })).toEqual({
      host: null,
      authHost: null,
    });
    expect(
      hostFlagsOf({
        apiUrl: "https://app.traceroot.ai/api/v1",
        appUrl: "https://app.traceroot.ai",
      }),
    ).toEqual({ host: null, authHost: null });
  });

  it("reduces an absolute API URL to its origin", () => {
    // The CLI appends `/api/v1/...` to whatever `--host` is given, so passing
    // the browser's own API path through would request it twice.
    expect(
      hostFlagsOf({ apiUrl: "http://localhost:8000/api/v1", appUrl: "http://localhost:3000" }).host,
    ).toBe("http://localhost:8000");
  });

  it("resolves a same-origin API path against the app's own URL", () => {
    // `/api/v1` is the default, and on a self-hosted deployment served behind
    // one origin it is that origin the CLI has to be pointed at.
    expect(hostFlagsOf({ apiUrl: "/api/v1", appUrl: "https://traceroot.internal" })).toEqual({
      host: "https://traceroot.internal",
      // One origin serves both, so sign-in needs no separate host.
      authHost: null,
    });
  });

  it("names the app origin separately when the API is on another one", () => {
    // The device flow and the token mint are web-app routes and do not exist on
    // the API, so `--host` alone would stop setup at sign-in.
    expect(
      hostFlagsOf({ apiUrl: "http://localhost:8000/api/v1", appUrl: "http://localhost:3000" }),
    ).toEqual({ host: "http://localhost:8000", authHost: "http://localhost:3000" });
  });

  it("falls back to the origin the rest of the app assumes when none is set", () => {
    // `lib/auth-client.ts` points better-auth at localhost:3000 when the app
    // URL is unset, so that is the deployment this one is configured for —
    // naming it beats omitting the flag and pointing the reader at Cloud.
    for (const appUrl of [undefined, "", "   "]) {
      expect(hostFlagsOf({ apiUrl: "/api/v1", appUrl })).toEqual({
        host: "http://localhost:3000",
        authHost: null,
      });
    }
  });

  it.each(["not-a-url", "mailto:ops@example.com"])(
    "reports the variable when the app URL is set to something that is not an origin (%s)",
    (appUrl) => {
      // Unset means localhost:3000 everywhere in the app; a set value that is
      // not an origin says nothing about where this deployment is, so pointing
      // the command at localhost:3000 would be a guess.
      expect(cliHostFlags({ apiUrl: "/api/v1", appUrl })).toEqual({
        kind: "unresolved",
        variable: "NEXT_PUBLIC_APP_URL",
        value: appUrl,
      });
    },
  );

  it.each(["http://", "http://[", "//", "http://:8000", "http://%zz.com"])(
    "reports the variable when the API URL is malformed outright (%s)",
    (apiUrl) => {
      // A relative or empty value resolves against the base, so reaching here
      // means the value is broken. Substituting the app origin would point API
      // traffic at the UI host on a split deployment — and reporting it as
      // two nulls is indistinguishable from the deployment that needs no flags.
      expect(cliHostFlags({ apiUrl, appUrl: "http://localhost:3000" })).toEqual({
        kind: "unresolved",
        variable: "NEXT_PUBLIC_API_URL",
        value: apiUrl,
      });
    },
  );

  it("names a deployment whose hosts carry an underscore", () => {
    // `_` is legal in a URL host and ordinary in container and internal DNS
    // names, and it is special to no shell. When the class that vets these
    // origins excluded it, such a deployment lost both flags and the bare
    // command this file then rendered sent the CLI to TraceRoot Cloud.
    expect(
      hostFlagsOf({ apiUrl: "http://app_internal:8000/api/v1", appUrl: "http://web_1:3000" }),
    ).toEqual({ host: "http://app_internal:8000", authHost: "http://web_1:3000" });
    // And on the same-origin default, where the app URL is the only input.
    expect(hostFlagsOf({ apiUrl: "/api/v1", appUrl: "http://app_internal:3000" })).toEqual({
      host: "http://app_internal:3000",
      authHost: null,
    });
  });

  it("drops both flags rather than render an origin a shell would mangle", () => {
    // A hostname can carry a quote (`http://%27.com` parses to `http://'.com`),
    // which would escape the quoting around it. Half a deployment is worse than
    // none: `--auth-host` beside an omitted `--host` leaves the API on Cloud.
    for (const appUrl of [
      "http://%27.com",
      "http://a`b.com",
      "http://a;b.com",
      "http://a$b.com",
      // Admitting `_` must not have admitted the rest of what the parser lets
      // through; none of these names a deployment, so a flag carrying one is
      // noise, and `*` and `&` would not survive the paste in any case.
      "http://a*b.com",
      "http://a&b.com",
      "http://a!b.com",
      "http://a~b.com",
      "http://a+b.com",
      "http://a,b.com",
      "http://a(b.com",
      "http://a{b.com",
      'http://a"b.com',
    ]) {
      expect(cliHostFlags({ apiUrl: "/api/v1", appUrl })).toEqual({
        kind: "unresolved",
        // The API URL here is the relative default, so `api` is resolved
        // against the app origin: it is this variable that is unusable, and
        // naming the other one would send the reader to a correct value.
        variable: "NEXT_PUBLIC_APP_URL",
        value: appUrl,
      });
    }
  });

  it("blames the API URL when that is the half of the deployment at fault", () => {
    // The mirror of the case above: an absolute API URL that parses but cannot
    // be put in a command, beside an app origin that is perfectly usable.
    expect(
      cliHostFlags({ apiUrl: "http://a;b.com/api/v1", appUrl: "http://localhost:3000" }),
    ).toEqual({
      kind: "unresolved",
      variable: "NEXT_PUBLIC_API_URL",
      value: "http://a;b.com/api/v1",
    });
  });

  it("renders nothing a double-quoted word would leave live", () => {
    // The flags go into the line inside double quotes, which cmd.exe,
    // PowerShell, bash and zsh all strip. That only holds while the origin
    // cannot carry a character those shells still act on inside one, so the
    // class is checked against every printable ASCII character rather than the
    // handful anyone thought to list. Each is percent-encoded into the host,
    // where the URL parser decodes it back the way `http://%27.com` yields
    // `http://'.com`.
    const stillLiveInsideDoubleQuotes = ['"', "$", "`", "\\", "%", "!"];
    let rendered = 0;

    for (let code = 0x20; code < 0x7f; code += 1) {
      const encoded = `%${code.toString(16).padStart(2, "0")}`;
      const flags = cliHostFlags({ apiUrl: "/api/v1", appUrl: `http://a${encoded}b.example` });
      if (flags.kind !== "resolved") continue;
      for (const flag of [flags.host, flags.authHost]) {
        if (flag === null) continue;
        rendered += 1;
        for (const live of stillLiveInsideDoubleQuotes) {
          expect(flag).not.toContain(live);
        }
      }
    }

    // The characters the class does admit still have to reach the line, or the
    // loop above would pass on a `cliHostFlags` that had stopped rendering
    // anything at all.
    expect(rendered).toBeGreaterThan(0);
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

    const invocation = lineOf(setupCommand({ projectId: "proj_1" })).split(" ")[2];
    expect(invocation).toMatch(/^traceroot-cli@\d+\.\d+\.\d+$/);
  });

  it("names the project the caller already has in hand", async () => {
    const setupCommand = await setupCommandWith({ appUrl: "https://app.traceroot.ai" });

    expect(lineOf(setupCommand({ projectId: "proj_1" }))).toBe(
      "npx -y traceroot-cli@0.6.0 setup --project proj_1",
    );
  });

  it("omits the project flag when there is no usable id", async () => {
    // The id arrives from the URL and the output is pasted into a shell, so an
    // id no real project has is dropped rather than quoted into the line.
    const setupCommand = await setupCommandWith({ appUrl: "https://app.traceroot.ai" });

    expect(lineOf(setupCommand({ projectId: "" }))).toBe("npx -y traceroot-cli@0.6.0 setup");
    expect(lineOf(setupCommand({ projectId: "proj 1; rm -rf ~" }))).toBe(
      "npx -y traceroot-cli@0.6.0 setup",
    );
  });

  it("leaves both hosts out on TraceRoot Cloud", async () => {
    // Cloud serves the dashboard and the API behind one origin, and it is the
    // origin the CLI defaults to, so the bare command is already right.
    const setupCommand = await setupCommandWith({ appUrl: "https://app.traceroot.ai" });

    expect(lineOf(setupCommand({ projectId: "proj_1" }))).toBe(
      "npx -y traceroot-cli@0.6.0 setup --project proj_1",
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

    expect(lineOf(setupCommand({ projectId: "proj_1" }))).toBe(
      "npx -y traceroot-cli@0.6.0 setup --project proj_1 " +
        '--host "http://localhost:8000" --auth-host "http://localhost:3000"',
    );
  });

  it("names this deployment rather than Cloud when only the API default is set", async () => {
    // The relative `/api/v1` default with no app URL: previously no flag at
    // all, which silently ran setup against TraceRoot Cloud from a local
    // deployment. One origin serves both, so `--auth-host` is not needed.
    const setupCommand = await setupCommandWith({});

    expect(lineOf(setupCommand({ projectId: "proj_1" }))).toBe(
      'npx -y traceroot-cli@0.6.0 setup --project proj_1 --host "http://localhost:3000"',
    );
  });

  it("quotes an IPv6 origin so the line survives zsh", async () => {
    // Unquoted, zsh reads `[::1]` as a glob and the paste dies with "no matches
    // found" before setup runs. These brackets are the only characters the
    // origin class admits that any shell acts on, so this is the one shape
    // quoting exists for.
    const setupCommand = await setupCommandWith({
      apiUrl: "http://[::1]:8000/api/v1",
      appUrl: "http://[::1]:3000",
    });

    expect(lineOf(setupCommand({ projectId: "proj_1" }))).toBe(
      "npx -y traceroot-cli@0.6.0 setup --project proj_1 " +
        '--host "http://[::1]:8000" --auth-host "http://[::1]:3000"',
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

    expect(lineOf(setupCommand({ projectId: "proj_1" }))).toBe(
      "npx -y traceroot-cli@0.6.0 setup --project proj_1 " +
        '--host "http://app_internal:8000" --auth-host "http://web_1:3000"',
    );
  });

  it("never lets a quote reach the line", async () => {
    // The host parser hands back either quote — `http://%27.com` parses to
    // `http://'.com` and `http://%22.com` to `http://".com` — and a quoted word
    // cannot carry the quote that ends it, so no quoting makes such an origin
    // safe. There is then no line at all rather than one without the flags.
    for (const appUrl of ["http://%22.com", "http://%27.com"]) {
      const setupCommand = await setupCommandWith({ appUrl });
      const result = setupCommand({ projectId: "proj_1" });

      expect(result).toEqual({
        kind: "unavailable",
        variable: "NEXT_PUBLIC_APP_URL",
        value: appUrl,
      });
    }
  });

  it("shows no command at all when the deployment cannot be identified", async () => {
    // The line this would otherwise return is the bare command, and the bare
    // command is not a weaker version of the right one: the CLI defaults to
    // TraceRoot Cloud, so a self-hosted reader pasting it signs in against
    // someone else's deployment and sends their first traces there. The result
    // says so instead, and names the value to correct.
    const setupCommand = await setupCommandWith({ apiUrl: "http://:8000" });
    const result = setupCommand({ projectId: "proj_1" });

    expect(result).toEqual({
      kind: "unavailable",
      variable: "NEXT_PUBLIC_API_URL",
      value: "http://:8000",
    });
    // Nothing a caller could mistake for a runnable line.
    expect(JSON.stringify(result)).not.toContain("npx");
  });

  it("still renders the bare command when the CLI's default already is this deployment", async () => {
    // The other reason both flags come back empty, and it has to stay a
    // command: Cloud serves the dashboard and the API behind the origin the CLI
    // defaults to, so the unflagged line is the correct one there. The same
    // holds for a self-hosted install whose API happens to be that origin.
    const setupCommand = await setupCommandWith({ appUrl: "https://app.traceroot.ai" });

    expect(setupCommand({ projectId: "proj_1" })).toEqual({
      kind: "command",
      command: "npx -y traceroot-cli@0.6.0 setup --project proj_1",
    });
  });

  it("quotes with the character cmd.exe also strips, not just the POSIX shells", async () => {
    // cmd.exe does not treat `'` as a quote, and neither does the argv parsing
    // behind `npx` on Windows, so single quotes reached the CLI inside the
    // value and `setup` stopped with an invalid host — a self-hosted operator
    // pasting the line into cmd.exe could not start at all. Double quotes are
    // stripped by cmd.exe, PowerShell, bash and zsh alike.
    const setupCommand = await setupCommandWith({
      apiUrl: "http://[::1]:8000/api/v1",
      appUrl: "http://[::1]:3000",
    });
    const line = lineOf(setupCommand({ projectId: "proj_1" }));

    expect(line).toContain('--host "http://[::1]:8000"');
    expect(line).toContain('--auth-host "http://[::1]:3000"');
    expect(line).not.toContain("'");
  });
});
