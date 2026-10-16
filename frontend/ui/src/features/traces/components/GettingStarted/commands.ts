// Single source of truth for the onboarding setup snippets, shared by the AI-tab
// SetupTabs widget, the Manual-tab CliVerifyCard and the first-run hand-back
// page, so none of them can drift apart.

import { clientEnv } from "@/env.client";

/** Read-only CLI flow: install, authenticate, list traces. */
export const CLI_COMMANDS = [
  "npm install -g traceroot-cli",
  "traceroot login",
  "traceroot traces list",
].join("\n");

/** One-prompt instrumentation handoff for any AI coding agent. */
export const INSTRUMENT_PROMPT =
  "Install the TraceRoot AI skill from https://github.com/traceroot-ai/traceroot-skills and use it to add tracing to this application with TraceRoot following best practices.";

/** Install the first-party TraceRoot skills into a coding agent. */
export const SKILLS_COMMAND = "npx skills add traceroot-ai/traceroot-skills";

/** The invocation, before the flags this page is able to fill in. */
const SETUP_BASE = "npx -y traceroot-cli@latest setup";

/**
 * The API host `traceroot setup` assumes when it is passed no `--host`.
 *
 * Mirrors `DEFAULT_HOST` in the CLI. Kept here so a caller can tell "this is
 * the deployment the CLI would have picked anyway" from "this is somewhere
 * else", and omit the flag in the first case rather than restate the default.
 */
const CLI_DEFAULT_HOST = "https://app.traceroot.ai";

/**
 * The app origin to assume when `NEXT_PUBLIC_APP_URL` is unset.
 *
 * Not a guess, and not this file inventing a host: `lib/auth-client.ts` points
 * better-auth at this exact origin when the variable is unset, and
 * `lib/eval/run-link.ts` falls back to it too. A deployment that left it unset
 * and is served from somewhere else therefore already has a broken dashboard —
 * its own session calls go to localhost:3000 — so assuming it here describes
 * the deployment the rest of the app is configured for. The alternative is to
 * omit the flags and hand a self-hosted reader TraceRoot Cloud, which fails by
 * sending their first traces somewhere they will not look for them.
 */
const DEFAULT_APP_ORIGIN = "http://localhost:3000";

/**
 * Project ids the command may carry unquoted.
 *
 * The id reaches this panel from the URL, and the output is a line someone
 * pastes into their own shell. Quoting it would be the obvious alternative, but
 * a quote cannot survive a value that contains one; omitting the flag for an id
 * no real project has costs a prompt the user can still answer.
 *
 * None of `.`, `_` or `-` is special to a shell, so a matching id is safe as a
 * bare word and is rendered as one.
 */
const PLAIN_PROJECT_ID = /^[A-Za-z0-9._-]+$/;

/**
 * Origins this file is willing to put in the line.
 *
 * `new URL(...).origin` is not shell-safe on its own: a hostname may carry a
 * single quote (`http://%27.com` parses to `http://'.com`), and a backtick,
 * `$`, `;` or `*` survive parsing too. So the origin is held to a scheme, a
 * hostname or IPv6 literal, and an optional port — which excludes every one of
 * those, and in particular the one character single quotes cannot carry. With
 * that established, `quotedArg` is enough to make the value one word.
 */
const SHELL_SAFE_ORIGIN = /^https?:\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:\d+)?$/;

/**
 * A value as a single shell word.
 *
 * An origin can legitimately be an IPv6 literal — `http://[::1]:8000` — and zsh
 * reads the brackets as a glob: unquoted, the pasted line dies with "no matches
 * found" before `setup` ever runs. `SHELL_SAFE_ORIGIN` has already ruled out
 * the quote that would escape this, so wrapping is sound rather than hopeful.
 */
function quotedArg(value: string): string {
  return `'${value}'`;
}

/** The origin serving the dashboard, falling back to the app's own default. */
function appOrigin(appUrl: string | undefined): string {
  const configured = appUrl?.trim();
  if (!configured) return DEFAULT_APP_ORIGIN;
  try {
    const url = new URL(configured);
    // Only an http(s) origin can serve the dashboard and the browser sign-in.
    // A value like `mailto:` parses as a URL but cannot host either, so it is
    // treated as unset rather than passed on. Mirrors `lib/eval/run-link.ts`.
    if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
  } catch {
    // Unparseable: as good as unset.
  }
  return DEFAULT_APP_ORIGIN;
}

export interface CliHostFlags {
  /** `--host`, or null when the CLI's own default is already this deployment. */
  host: string | null;
  /** `--auth-host`, or null when sign-in belongs on the same origin as the API. */
  authHost: string | null;
}

/**
 * Which deployment to point `setup` at: the API origin, and where to sign in.
 *
 * Two flags rather than one, because the CLI uses them for two different
 * things. `--host` is where the API is; `--auth-host` is where the browser
 * sign-in and the token mint are, and it defaults to `--host` when it is not
 * passed. On the documented self-hosted setup those are not the same place:
 * `.env.example` and `docker-compose.prod.yml` put the API on `localhost:8000`
 * and the app on `localhost:3000`, while the device flow
 * (`/api/auth/device/code`, `/api/auth/device/token`) and the mint
 * (`/api/cli/token`) are routes of the web app and do not exist on the API at
 * all. So `--host` alone sends the device-code request to the API port and
 * `setup` stops at sign-in, having reached neither.
 *
 * `--host` is an origin, not the path the browser calls: the CLI appends
 * `/api/v1/...` to whatever it is given, so passing `NEXT_PUBLIC_API_URL`
 * verbatim would request `/api/v1/api/v1/...`.
 *
 * Both inputs are inlined at build time, which is why this never reads
 * `window`: a value that differed between the server render and the client
 * would rewrite the command after hydration, under a copy button.
 */
export function cliHostFlags(input: { apiUrl: string; appUrl: string | undefined }): CliHostFlags {
  const app = appOrigin(input.appUrl);
  let api: string;
  try {
    // `NEXT_PUBLIC_API_URL` is relative on a same-origin deployment (`/api/v1`,
    // its default), so it is resolved against the app's origin rather than
    // parsed alone — which also makes that case answerable instead of unknown.
    api = new URL(input.apiUrl, app).origin;
  } catch {
    // Not reached by a relative or empty value — those resolve against the base
    // — so this is a value that is malformed outright: `http://`, `http://[`,
    // `//`, `http://:8000`. That says nothing about where the API is, and the
    // app's origin is not a stand-in for it: on a split deployment it would
    // point the CLI's API traffic at the UI host. Saying nothing is the only
    // honest answer, and it leaves the operator a `.env` to fix rather than a
    // command that half works.
    return { host: null, authHost: null };
  }

  // Either both flags are renderable or neither is. A `--auth-host` beside a
  // silently-omitted `--host` would name one half of a deployment and leave the
  // CLI defaulting to Cloud for the other, which is worse than saying nothing.
  if (!SHELL_SAFE_ORIGIN.test(api) || !SHELL_SAFE_ORIGIN.test(app)) {
    return { host: null, authHost: null };
  }

  return {
    host: api === new URL(CLI_DEFAULT_HOST).origin ? null : api,
    // The CLI's `--auth-host` already defaults to the effective `--host`, which
    // is `api` whether or not the flag above was rendered. Restating it when it
    // matches would only add a flag a reader has to evaluate.
    authHost: app === api ? null : app,
  };
}

/**
 * The whole of setup, as one command, carrying what the caller already knows.
 *
 * `npx -y` rather than a global install: someone reading this has not decided
 * to keep a CLI yet, and asking them to install one before they have seen a
 * trace is a commitment ahead of the payoff. It authenticates in the browser,
 * creates the key, instruments the service with a coding agent, runs the
 * application and waits for the first trace — which is why none of those are
 * separate steps anywhere that shows this command.
 *
 * The flags are what the caller has and the bare command does not. The project,
 * because the caller already has one in hand: without it a user with more than
 * one project answers "which project?" from memory, and a wrong answer sends
 * their first traces somewhere they will not look for them. The deployment,
 * because the CLI defaults to TraceRoot Cloud — so on a self-hosted install the
 * unflagged command signs in against the wrong host entirely. See
 * `cliHostFlags` for why that takes two flags and not one.
 *
 * All three are declared on the program rather than on `setup`, and commander
 * accepts a program option after the subcommand name, so they read as part of
 * the one line a user pastes.
 */
export function setupCommand(input: { projectId: string }): string {
  const parts = [SETUP_BASE];

  if (PLAIN_PROJECT_ID.test(input.projectId)) {
    parts.push(`--project ${input.projectId}`);
  }

  const { host, authHost } = cliHostFlags({
    // Validated, and with the `/api/v1` default that means "same origin".
    apiUrl: clientEnv.NEXT_PUBLIC_API_URL,
    // Read straight from the environment, as `lib/auth-client.ts` and
    // `lib/eval/run-link.ts` do: the client schema does not carry it.
    appUrl: process.env.NEXT_PUBLIC_APP_URL,
  });
  if (host !== null) {
    parts.push(`--host ${quotedArg(host)}`);
  }
  if (authHost !== null) {
    parts.push(`--auth-host ${quotedArg(authHost)}`);
  }

  return parts.join(" ");
}
