import type { SandboxHandle, SandboxProvider } from "./sandbox.js";

/**
 * Reading one repository for an update, safely and within bounds.
 *
 * The clone is blobless (file contents are fetched only for what is read),
 * shallow since the start of the previous window (two windows of history, so
 * the comparison has something to compare), without a checkout until the paths
 * the window changed are known, and limited in time and size. When any limit
 * trips, or the repository cannot be reached, the outcome says so and the caller
 * falls back to the host's metadata; it is never silent.
 *
 * Nothing the repository holds is trusted. Values reach commands only through
 * the environment, hooks and credential helpers are switched off, and the
 * token lives only in the clone sandbox, which is destroyed after the copy.
 */

export interface RepoReadLimits {
  cloneTimeoutSec: number;
  /** Most the repository may weigh on disk in the clone sandbox, after the clone and after the checkout. */
  maxRepoBytes: number;
  /** Most the archive carried to the analysis sandbox may weigh. */
  maxArchiveBytes: number;
}

export const DEFAULT_REPO_LIMITS: RepoReadLimits = {
  cloneTimeoutSec: 180,
  maxRepoBytes: 25 * 1024 * 1024,
  maxArchiveBytes: 30 * 1024 * 1024,
};

export type RepoReadFailure = "timeout" | "oversize" | "unreachable" | "failed";

export type RepoReadOutcome =
  | { ok: true; reader: RepoReader; method: "blobless shallow clone" }
  | { ok: false; reason: RepoReadFailure; detail: string };

export interface ReadRepoInput {
  provider: SandboxProvider;
  cloneUrl: string;
  /** The per-run installation token; handed to the clone sandbox only. */
  token: string;
  /** The start of the previous window, as an ISO timestamp. */
  sinceIso: string;
  /** Paths the window's pull requests changed; only these are checked out. */
  changedPaths: string[];
  limits?: RepoReadLimits;
  /** Where things live inside a sandbox; the defaults suit a container, tests point them at a temporary directory. */
  layout?: { work: string; tmp: string };
}

// The script holds no secret: it prints what the environment hands it.
const ASKPASS_SCRIPT = [
  "#!/bin/sh",
  'case "$1" in',
  '  Username*) printf "%s" "$GIT_USERNAME" ;;',
  '  Password*) printf "%s" "$GIT_PASSWORD" ;;',
  "esac",
  "",
].join("\n");

const GIT = "git -c credential.helper= -c core.hooksPath=/dev/null -c protocol.ext.allow=never";
const MAX_CHANGED_PATHS = 200;
const SAFE_PATH = /^[A-Za-z0-9_@+=,.\-/ ]{1,300}$/;

function classify(output: string, timedOut: boolean): { reason: RepoReadFailure; detail: string } {
  if (timedOut) return { reason: "timeout", detail: "the clone did not finish in time" };
  const text = output.trim().slice(-300);
  if (
    /could not resolve host|connection refused|failed to connect|unable to access|network is unreachable|couldn't connect|connection timed out/i.test(
      output,
    )
  ) {
    return { reason: "unreachable", detail: text || "the repository could not be reached" };
  }
  return { reason: "failed", detail: text || "the clone failed" };
}

/** Every value a git command needs travels as "$NAME"; nothing from the repository is spliced into a command. */
export async function readRepo(input: ReadRepoInput): Promise<RepoReadOutcome> {
  const limits = input.limits ?? DEFAULT_REPO_LIMITS;
  const work = input.layout?.work ?? "/work";
  const tmp = input.layout?.tmp ?? "/tmp";
  const askpassPath = `${tmp}/askpass.sh`;
  const archivePath = `${tmp}/repo.tar`;
  const repoDir = `${work}/repo`;
  const paths = [...new Set(input.changedPaths)]
    .filter((p) => SAFE_PATH.test(p) && !p.split("/").includes("..") && !p.startsWith("-"))
    .slice(0, MAX_CHANGED_PATHS);

  let cloneBox: SandboxHandle | null = null;
  let archive: Buffer;
  try {
    cloneBox = await input.provider.create({ networkAccess: true });
    await cloneBox.upload(askpassPath, Buffer.from(ASKPASS_SCRIPT));
    await cloneBox.exec(`chmod +x "${askpassPath}" && mkdir -p "${work}"`);

    const env = {
      GIT_ASKPASS: askpassPath,
      GIT_TERMINAL_PROMPT: "0",
      GIT_USERNAME: "x-access-token",
      GIT_PASSWORD: input.token,
      GIT_URL: input.cloneUrl,
      GIT_DEST: repoDir,
      GIT_SINCE: input.sinceIso,
      GIT_PATHS: paths.join("\n"),
    };
    const redact = (text: string) =>
      input.token ? text.replaceAll(input.token, "[REDACTED]") : text;

    let cloned = await cloneBox.exec(
      `( ${GIT} clone --filter=blob:none --no-checkout --shallow-since="$GIT_SINCE" -- "$GIT_URL" "$GIT_DEST" ) 2>&1`,
      { env, timeoutSec: limits.cloneTimeoutSec },
    );
    if (cloned.code !== 0 && /no commits selected for shallow requests/i.test(cloned.stdout)) {
      // Nothing was committed since the previous window began: the tip alone is the history there is.
      await cloneBox.exec(`rm -rf "$GIT_DEST"`, { env });
      cloned = await cloneBox.exec(
        `( ${GIT} clone --filter=blob:none --no-checkout --depth 1 -- "$GIT_URL" "$GIT_DEST" ) 2>&1`,
        { env, timeoutSec: limits.cloneTimeoutSec },
      );
    }
    if (cloned.code !== 0) {
      const failure = classify(redact(cloned.stdout), cloned.timedOut);
      return { ok: false, ...failure, detail: redact(failure.detail) };
    }

    const sizeOf = async () => {
      const du = await cloneBox!.exec(`du -sk "$GIT_DEST" | cut -f1`, { env });
      return Number(du.stdout.trim().split("\n")[0]) * 1024;
    };
    if ((await sizeOf()) > limits.maxRepoBytes) {
      return {
        ok: false,
        reason: "oversize",
        detail: "the repository is larger than the size limit",
      };
    }

    if (paths.length > 0) {
      const checkout = await cloneBox.exec(
        `( printf '%s\\n' "$GIT_PATHS" | ${GIT} -C "$GIT_DEST" sparse-checkout set --no-cone --stdin && ${GIT} -C "$GIT_DEST" checkout ) 2>&1`,
        { env, timeoutSec: limits.cloneTimeoutSec },
      );
      if (checkout.code !== 0) {
        const failure = classify(redact(checkout.stdout), checkout.timedOut);
        return { ok: false, ...failure, detail: redact(failure.detail) };
      }
      if ((await sizeOf()) > limits.maxRepoBytes) {
        return {
          ok: false,
          reason: "oversize",
          detail: "the files the window changed are larger than the size limit",
        };
      }
    }

    const packed = await cloneBox.exec(
      `tar -C "$GIT_DEST" -cf "${archivePath}" . && wc -c < "${archivePath}"`,
      { env },
    );
    if (packed.code !== 0)
      return { ok: false, reason: "failed", detail: "the copy could not be packed" };
    if (Number(packed.stdout.trim().split("\n")[0]) > limits.maxArchiveBytes) {
      return { ok: false, reason: "oversize", detail: "the copy is larger than the size limit" };
    }
    archive = await cloneBox.download(archivePath);
  } catch (error) {
    return {
      ok: false,
      reason: "failed",
      detail: error instanceof Error ? error.message.slice(0, 300) : "the clone failed",
    };
  } finally {
    // The token goes with this sandbox, whatever happened.
    if (cloneBox) await cloneBox.destroy().catch(() => undefined);
  }

  let readBox: SandboxHandle | null = null;
  try {
    readBox = await input.provider.create({ networkAccess: false });
    await readBox.upload(archivePath, archive);
    const unpacked = await readBox.exec(
      `mkdir -p "$DEST" && tar -xf "${archivePath}" -C "$DEST" && rm -f "${archivePath}"`,
      {
        env: { DEST: repoDir },
      },
    );
    if (unpacked.code !== 0) throw new Error("the copy could not be unpacked");
    const reader = new RepoReader(readBox, input.token, repoDir, [work, tmp]);
    readBox = null; // now owned by the reader
    return { ok: true, reader, method: "blobless shallow clone" };
  } catch (error) {
    return {
      ok: false,
      reason: "failed",
      detail: error instanceof Error ? error.message.slice(0, 300) : "the copy failed",
    };
  } finally {
    if (readBox) await readBox.destroy().catch(() => undefined);
  }
}

export interface RepoCommit {
  sha: string;
  at: string;
  /** The commit message's first line: customer text, never an instruction. */
  subject: string;
  files: { status: string; path: string }[];
}

/** Read-only access to the analysis sandbox. Close it when done. */
export class RepoReader {
  constructor(
    private readonly box: SandboxHandle,
    private readonly token: string,
    private readonly repoDir: string,
    private readonly scanDirs: string[],
  ) {}

  get sandboxId(): string {
    return this.box.id;
  }

  private gitCmd(args: string): string {
    return `timeout 30 ${GIT} -C "${this.repoDir}" ${args}`;
  }

  private git(args: string, env: Record<string, string> = {}) {
    return this.box.exec(`( ${this.gitCmd(args)} ) 2>&1`, {
      env: { GIT_OPTIONAL_LOCKS: "0", ...env },
      timeoutSec: 40,
    });
  }

  /** Commits since a time, with the paths each touched. Needs no file contents. */
  async commitsSince(sinceIso: string, limit = 200): Promise<RepoCommit[]> {
    const out = await this.git(
      `log --since="$SINCE" --max-count="$LIMIT" --format="@@%H%x09%cI%x09%s" --name-status`,
      {
        SINCE: sinceIso,
        LIMIT: String(limit),
      },
    );
    if (out.code !== 0) throw new Error("the history could not be read");
    const commits: RepoCommit[] = [];
    for (const block of out.stdout.split("@@").slice(1)) {
      const [head, ...lines] = block.split("\n");
      const [sha, at, ...subject] = head.split("\t");
      commits.push({
        sha,
        at,
        subject: subject.join("\t").slice(0, 200),
        files: lines
          .filter((l) => l.trim() !== "")
          .map((l) => {
            const [status, ...rest] = l.split("\t");
            return { status, path: rest[rest.length - 1] };
          })
          .filter((f) => f.path),
      });
    }
    return commits;
  }

  /** The first lines of a file as the default branch has it. For the agent's reading only. */
  async readFile(path: string, maxLines = 120): Promise<string> {
    if (!SAFE_PATH.test(path) || path.split("/").includes("..") || path.startsWith("-")) {
      throw new Error("that path is not allowed");
    }
    const out = await this.box.exec(
      `( ${this.gitCmd('cat-file -e "HEAD:$FILE_PATH"')} && ${this.gitCmd('show "HEAD:$FILE_PATH"')} | head -n "$LINES" ) 2>&1`,
      {
        env: { GIT_OPTIONAL_LOCKS: "0", FILE_PATH: path, LINES: String(Math.min(maxLines, 300)) },
        timeoutSec: 40,
      },
    );
    if (out.code !== 0) throw new Error("that file is not in the read-only copy");
    return out.stdout;
  }

  /** What the analysis sandbox can and cannot do, checked by trying. Evidence for the safety claims. */
  async verifyIsolation(): Promise<{
    egressBlocked: boolean;
    tokenInEnvironment: boolean;
    tokenOnDisk: boolean;
  }> {
    const egress = await this.box.exec(
      `(wget -q -T 4 -O /dev/null http://example.com/ >/dev/null 2>&1 && echo open) || echo blocked`,
      { timeoutSec: 20 },
    );
    // The needle reaches these commands in their own environment, so it is left out of the environment count.
    const env = await this.box.exec(`env | grep -v '^NEEDLE=' | grep -cF -e "$NEEDLE" || true`, {
      env: { NEEDLE: this.token },
    });
    const dirs = [...this.scanDirs, "/root", "/etc"].map((d) => `"${d}"`).join(" ");
    const disk = await this.box.exec(
      `grep -rIlF -e "$NEEDLE" ${dirs} 2>/dev/null | head -n 3 | wc -l`,
      { env: { NEEDLE: this.token }, timeoutSec: 60 },
    );
    return {
      egressBlocked: egress.stdout.trim().endsWith("blocked"),
      tokenInEnvironment: Number(env.stdout.trim().split("\n").pop()) > 0,
      tokenOnDisk: Number(disk.stdout.trim().split("\n").pop()) > 0,
    };
  }

  async close(): Promise<void> {
    await this.box.destroy().catch(() => undefined);
  }
}
