// Single source of truth for the onboarding snippets, so the getting-started
// panel and anything else that shows a command cannot drift apart.

import { clientEnv } from "@/env.client";

/** The invocation, before the flags this page is able to fill in. */
const SETUP_BASE = "npx -y traceroot-cli@latest setup";

/**
 * The API host `traceroot setup` assumes when it is passed no `--host`.
 *
 * Mirrors `DEFAULT_HOST` in the CLI. Kept here so the panel can tell "this is
 * the deployment the CLI would have picked anyway" from "this is somewhere
 * else", and omit the flag in the first case rather than restate the default.
 */
const CLI_DEFAULT_HOST = "https://app.traceroot.ai";

/**
 * Project ids the command may carry unquoted.
 *
 * The id reaches this panel from the URL, and the output is a line someone
 * pastes into their own shell. Quoting it would be the obvious alternative, but
 * a quote cannot survive a value that contains one; omitting the flag for an id
 * no real project has costs a prompt the user can still answer.
 */
const PLAIN_PROJECT_ID = /^[A-Za-z0-9._-]+$/;

/**
 * The absolute API origin to pass as `--host`, or null when the CLI's own
 * default is already right — or when nothing available here can say.
 *
 * `--host` is an origin, not the path the browser calls: the CLI appends
 * `/api/v1/...` to whatever it is given, so passing `NEXT_PUBLIC_API_URL`
 * verbatim would request `/api/v1/api/v1/...`.
 *
 * Both inputs are inlined at build time, which is why this never reads
 * `window`: a value that differed between the server render and the client
 * would rewrite the command after hydration, under a copy button.
 */
export function cliHostFlag(input: { apiUrl: string; appUrl: string | undefined }): string | null {
  // `NEXT_PUBLIC_API_URL` is relative on a same-origin deployment (`/api/v1`,
  // its default), so it is resolved against the app's own URL rather than
  // parsed alone. An unset app URL leaves a relative value unresolvable, which
  // is reported as "cannot say" rather than guessed at.
  const base = input.appUrl === undefined || input.appUrl === "" ? undefined : input.appUrl;
  let origin: string;
  try {
    origin = new URL(input.apiUrl, base).origin;
  } catch {
    return null;
  }
  return origin === new URL(CLI_DEFAULT_HOST).origin ? null : origin;
}

/**
 * The whole of setup, as one command, carrying what this page already knows.
 *
 * `npx -y` rather than a global install: someone reading this has not decided
 * to keep a CLI yet, and asking them to install one before they have seen a
 * trace is a commitment ahead of the payoff. It authenticates in the browser,
 * creates the key, instruments the service with a coding agent, runs the
 * application and waits for the first trace — which is why none of those are
 * separate steps in the panel any more.
 *
 * The two flags are what the panel has and the bare command does not. The
 * project, because the panel is already showing one: without it a user with
 * more than one project answers "which project?" from memory, and a wrong
 * answer sends their first traces somewhere they will not look for them. The
 * deployment, because the CLI defaults to TraceRoot Cloud — so on a
 * self-hosted install the unflagged command signs in against the wrong host
 * entirely.
 *
 * Both are declared on the program rather than on `setup`, and commander
 * accepts a program option after the subcommand name, so they read as part of
 * the one line a user pastes.
 */
export function setupCommand(input: { projectId: string }): string {
  const parts = [SETUP_BASE];

  if (PLAIN_PROJECT_ID.test(input.projectId)) {
    parts.push(`--project ${input.projectId}`);
  }

  const host = cliHostFlag({
    // Validated, and with the `/api/v1` default that means "same origin".
    apiUrl: clientEnv.NEXT_PUBLIC_API_URL,
    // Read straight from the environment, as `lib/auth-client.ts` and
    // `lib/eval/run-link.ts` do: the client schema does not carry it, and an
    // unset value has to stay unset here rather than pick up the server
    // schema's localhost default, which would name a host nobody asked for.
    appUrl: process.env.NEXT_PUBLIC_APP_URL,
  });
  if (host !== null) {
    parts.push(`--host ${host}`);
  }

  return parts.join(" ");
}
