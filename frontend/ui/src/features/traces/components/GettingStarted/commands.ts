// Single source of truth for the onboarding setup snippets, so the places that
// show them cannot drift apart: `SetupTabs` takes `CLI_COMMANDS`,
// `INSTRUMENT_PROMPT` and `SKILLS_COMMAND`, and onboarding's hand-back step
// takes `setupCommand`. (This header used to name a Manual-tab `CliVerifyCard`
// as a third reader; no such component exists in the tree.)

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

/**
 * The published CLI the printed command resolves to.
 *
 * An exact pin, and the ordering it encodes is the point: **the version named
 * here must already be published to npm carrying every flag this file puts on
 * the line, before this constant names it.** `setupCommand` renders
 * `--handoff`, and an option the resolved CLI does not declare is not ignored —
 * commander reports it as a usage error and exits — so a pin that runs ahead of
 * a release ends someone's sign-up on "unknown option". Bumping this is
 * therefore the last step of a CLI release, never the first.
 *
 * Not `@latest`, which is what this was: `npm view traceroot-cli dist-tags`
 * answers 0.5.0, a version with no `setup` subcommand at all, so the line this
 * file prints dies with "unknown command 'setup'" on Cloud today. `@latest` is
 * also resolved per machine against npx's cache, so even once a good version is
 * published a warm cache can still hand back an older one, and a rollback
 * silently re-breaks the page.
 *
 * Not a `^` range either, which would otherwise be the compromise: `^` is an
 * escape character in Windows `cmd.exe`, and this line has to survive being
 * pasted into whatever shell the reader happens to have open.
 */
const SETUP_CLI_VERSION = "0.6.1";

/** The invocation, before the flags this page is able to fill in. */
const SETUP_BASE = `npx -y traceroot-cli@${SETUP_CLI_VERSION} setup`;

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
 * Values the command may carry unquoted.
 *
 * Two of the flags below carry a value this file did not author: the project
 * id, which reaches the panel from the URL, and the handoff code, which reaches
 * it from the mint. Both end up on a line someone pastes into their own shell.
 * Quoting would be the obvious alternative, but a quote cannot survive a value
 * that contains one; omitting a flag whose value is not a bare word costs at
 * most a prompt the user can still answer, or — for the handoff — the browser
 * page they would have had anyway.
 *
 * None of `.`, `_` or `-` is special to a shell, so a matching value is safe as
 * a bare word and is rendered as one. That covers the handoff code without a
 * second rule: its alphabet is base64url, `[A-Za-z0-9_-]`, which is a strict
 * subset of this class, and its `trh_` prefix is in the class too.
 */
const PLAIN_ARG = /^[A-Za-z0-9._-]+$/;

/**
 * Origins this file is willing to put in the line.
 *
 * `new URL(...).origin` is not shell-safe on its own: a hostname may carry a
 * quote of either kind (`http://%27.com` parses to `http://'.com`,
 * `http://%22.com` to `http://".com`), and a backtick, `$`, `;` or `*` survive
 * parsing too. So the origin is held to a scheme, a hostname or IPv6 literal,
 * and an optional port — which excludes every one of those, and with them every
 * character that would still be live inside the quoting `quotedArg` applies.
 * With that established, `quotedArg` is enough to make the value one word.
 *
 * The host class admits `_` alongside the letters, digits, `.` and `-` of a
 * public domain. It is legal in a URL host, ordinary in container and internal
 * DNS names (`http://app_internal:3000`), and special to no shell — and
 * rejecting it is the one thing this check must not do, because a deployment
 * served under such a name would lose both flags and the bare command would
 * send its operator to TraceRoot Cloud, which is what this file exists to
 * prevent.
 *
 * It stops there rather than admitting everything quoting happens to survive,
 * because the check also answers "could this be a host at all". The other
 * characters the parser lets through — `&`, `!`, `~`, `+`, `,`, `(` and `{`
 * among them — reach an origin only by percent-decoding, never by naming a
 * deployment, so a flag carrying one is noise better dropped. Nothing
 * excludes whitespace or control characters because nothing has to: the URL
 * parser refuses a host containing them, so they arrive as a malformed URL.
 */
const SHELL_SAFE_ORIGIN = /^https?:\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(:\d+)?$/;

/**
 * A value as a single shell word, quoted the one way every shell this line may
 * be pasted into agrees on.
 *
 * Quoting is needed at all for one shape: an origin can legitimately be an IPv6
 * literal — `http://[::1]:8000` — and zsh reads the brackets as a glob, so
 * unquoted the pasted line dies with "no matches found" before `setup` ever
 * runs. Those brackets are also the only characters `SHELL_SAFE_ORIGIN` admits
 * that any shell acts on, which is why nothing else here has to be escaped.
 *
 * Double quotes rather than single, because cmd.exe does not treat `'` as a
 * quote character and neither does the argv parsing behind `npx` on Windows: a
 * single-quoted value arrives with the quotes inside it and `setup` stops on an
 * invalid host, so a self-hosted operator pasting the line into cmd.exe could
 * not start at all. Double quotes are stripped by cmd.exe, PowerShell, bash and
 * zsh alike, and what stays live inside them — `"`, `$`, a backtick, `\`, and
 * `%` or `!` under cmd.exe — is exactly what `SHELL_SAFE_ORIGIN` excludes.
 */
function quotedArg(value: string): string {
  return `"${value}"`;
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

/**
 * A deployment variable this file was given a value it cannot put in a command.
 *
 * Carried out of here rather than swallowed, because the person finishing a
 * first run on a self-hosted install is usually the person who sets these, and
 * the value is already public: `NEXT_PUBLIC_*` is inlined into the client
 * bundle, so naming it on screen discloses nothing a reader could not already
 * read out of the page they are on.
 */
export interface UnusableOrigin {
  /** The variable to fix, spelled the way a deployment sets it. */
  variable: "NEXT_PUBLIC_API_URL" | "NEXT_PUBLIC_APP_URL";
  /** What it is set to, so the reader can see what this file saw. */
  value: string;
}

/**
 * Which deployment to point `setup` at, or why that cannot be answered.
 *
 * Discriminated rather than two nullable fields, because `host: null` has two
 * unrelated meanings that a caller holding only the nulls cannot tell apart:
 * the API genuinely *is* the host the CLI defaults to, so the flag would be
 * noise, or the configured value is unusable and this file has nothing to say.
 * The first renders a correct bare command; the second must not render one at
 * all, because the bare command targets TraceRoot Cloud and a self-hosted
 * reader pasting it signs in against someone else's deployment. Collapsing
 * both into nulls is what let that happen, so the type now forces the caller
 * to separate them.
 */
export type CliHostFlags =
  | {
      kind: "resolved";
      /** `--host`, or null when the CLI's own default is already this deployment. */
      host: string | null;
      /** `--auth-host`, or null when sign-in belongs on the same origin as the API. */
      authHost: string | null;
    }
  | ({ kind: "unresolved" } & UnusableOrigin);

/** The one command, or the reason this deployment has none to show. */
export type SetupCommand =
  | { kind: "command"; command: string }
  | ({ kind: "unavailable" } & UnusableOrigin);

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
    // point the CLI's API traffic at the UI host. So the variable is reported
    // back instead of guessed at, and the caller shows no command rather than
    // one that runs against the wrong deployment.
    return { kind: "unresolved", variable: "NEXT_PUBLIC_API_URL", value: input.apiUrl };
  }

  // Either both flags are renderable or neither is. A `--auth-host` beside a
  // silently-omitted `--host` would name one half of a deployment and leave the
  // CLI defaulting to Cloud for the other, which is worse than showing nothing.
  //
  // The app origin is tested first because `api` is resolved against it
  // whenever `NEXT_PUBLIC_API_URL` is relative — which its own default is — so
  // an unusable `api` in that case is this variable's doing, and reporting the
  // other one would send the reader to a value that is already correct.
  if (!SHELL_SAFE_ORIGIN.test(app)) {
    // `appOrigin`'s own fallback is `DEFAULT_APP_ORIGIN`, which passes, so
    // reaching here means this variable was set to something that parsed.
    return { kind: "unresolved", variable: "NEXT_PUBLIC_APP_URL", value: input.appUrl ?? app };
  }
  if (!SHELL_SAFE_ORIGIN.test(api)) {
    return { kind: "unresolved", variable: "NEXT_PUBLIC_API_URL", value: input.apiUrl };
  }

  return {
    kind: "resolved",
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
 * The host flags are declared on the program rather than on `setup`, and
 * commander accepts a program option after the subcommand name, so they read as
 * part of the one line a user pastes. `--handoff` is declared on `setup`
 * itself, because a one-shot onboarding credential has no business appearing in
 * every other subcommand's help.
 *
 * It can also answer that there is no command to show. When the deployment is
 * unresolvable the line this function would otherwise return is the bare
 * command, and the bare command is not a weaker version of the right one — it
 * is the Cloud one, which is why that case comes back as `unavailable` rather
 * than as a string the caller cannot tell apart from a correct bare command.
 */
export function setupCommand(input: {
  projectId: string;
  /**
   * A one-time code that signs the terminal in without opening a browser.
   *
   * Optional, and null when the mint failed, because the command without it is
   * the command this page printed before handoffs existed: `setup` finds no
   * credential, runs the device flow, and the user approves it in a second
   * browser page. That is a worse flow, not a broken one — which is why a
   * failure here degrades to it silently rather than reporting anything.
   */
  handoff?: string | null;
}): SetupCommand {
  const flags = cliHostFlags({
    // Validated as a string, not as a URL: `NEXT_PUBLIC_API_URL` is
    // `z.string()` with the `/api/v1` default, so a value that is not an origin
    // at all reaches here rather than failing the schema.
    apiUrl: clientEnv.NEXT_PUBLIC_API_URL,
    // Read straight from the environment, as `lib/auth-client.ts` and
    // `lib/eval/run-link.ts` do: the client schema does not carry it.
    appUrl: process.env.NEXT_PUBLIC_APP_URL,
  });
  if (flags.kind === "unresolved") {
    return { kind: "unavailable", variable: flags.variable, value: flags.value };
  }

  const parts = [SETUP_BASE];

  if (PLAIN_ARG.test(input.projectId)) {
    parts.push(`--project ${input.projectId}`);
  }

  // After `--project`, which stays on the line whether or not this one is
  // there: the fallback for an expired code is the device flow, and
  // `chooseProject` reads the flag to resolve without prompting. Dropping it
  // would give the degraded path a question the undegraded path does not ask.
  //
  // Printed bare. The value is base64url behind a `trh_` prefix, which
  // `PLAIN_ARG` already certifies as shell-safe — and a value that somehow is
  // not is dropped rather than quoted, leaving the working command above.
  if (input.handoff && PLAIN_ARG.test(input.handoff)) {
    parts.push(`--handoff ${input.handoff}`);
  }

  if (flags.host !== null) {
    parts.push(`--host ${quotedArg(flags.host)}`);
  }
  if (flags.authHost !== null) {
    parts.push(`--auth-host ${quotedArg(flags.authHost)}`);
  }

  return { kind: "command", command: parts.join(" ") };
}
