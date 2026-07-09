import { Daytona } from "@daytonaio/sdk";
import type { Sandbox } from "@daytonaio/sdk";
import type { Executor, ExecResult, ExecOptions } from "./interface.js";

export class DaytonaExecutor implements Executor {
  private daytona: Daytona | null = null;
  private sandbox: Sandbox | null = null;
  private workDir = "";

  async init(): Promise<void> {
    console.log("[DaytonaExecutor] Creating sandbox...");

    this.daytona = new Daytona({
      apiKey: process.env.DAYTONA_API_KEY,
      apiUrl: "https://app.daytona.io/api",
      target: "us",
    });

    // Plain ubuntu:24.04 — a tiny, near-always-warm base (no custom snapshot to
    // build or cold-pull). We install tools at runtime below; the cost lands once
    // per session (init is cached per session, guarded by isReady()).
    this.sandbox = await this.daytona.create(
      {
        image: "ubuntu:24.04",
        ephemeral: true,
        autoStopInterval: 15,
        labels: { "traceroot.session": "true" },
      },
      { timeout: 60 },
    );

    // Use /workspace consistently with DockerExecutor regardless of what Daytona reports
    this.workDir = "/workspace";
    await this.sandbox.process.executeCommand(
      "mkdir -p /workspace/repos /workspace/traces /workspace/notes",
    );

    // Install required tools. ca-certificates is essential: cloneRepo uses the
    // system `git` CLI (a fresh process that reads the on-disk trust store), so
    // certs must be present before any HTTPS clone. We intentionally do NOT rely
    // on Daytona's native go-git here — its daemon caches an empty cert pool at
    // boot on this image, so its in-process TLS can't be fixed by a later apt.
    await this.sandbox.process.executeCommand(
      "apt-get update -qq && apt-get install -y -qq ca-certificates git jq curl > /dev/null 2>&1 || true",
    );

    console.log(`[DaytonaExecutor] Sandbox ready, workDir: ${this.workDir}`);
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    if (!this.sandbox) throw new Error("Sandbox not initialized");

    const result = await this.sandbox.process.executeCommand(
      command,
      undefined,
      options?.env,
      options?.timeout,
    );

    return {
      stdout: result.result ?? "",
      stderr: result.exitCode !== 0 ? (result.result ?? "") : "",
      code: result.exitCode ?? 1,
    };
  }

  getWorkspacePath(): string {
    return this.workDir;
  }

  async writeFile(path: string, content: string): Promise<void> {
    if (!this.sandbox) throw new Error("Sandbox not initialized");
    await this.sandbox.fs.uploadFile(Buffer.from(content), path);
  }

  async readFile(path: string): Promise<string> {
    if (!this.sandbox) throw new Error("Sandbox not initialized");
    const buf = await this.sandbox.fs.downloadFile(path);
    return buf.toString();
  }

  isReady(): boolean {
    return this.sandbox !== null;
  }

  async destroy(): Promise<void> {
    if (!this.sandbox) return;
    console.log("[DaytonaExecutor] Destroying sandbox...");
    try {
      await this.sandbox.delete();
    } catch {
      // Ignore errors during cleanup
    }
    this.sandbox = null;
  }

  // Git Support
  //
  // The executor owns cloning (hasNativeGit=true), but deliberately uses the
  // system `git` CLI rather than Daytona's native `sandbox.git.clone()` (go-git):
  //   - go-git is a pure-Go reimplementation with no Git LFS support, weak
  //     submodule handling, and worse behavior on large repos / protocol v2 —
  //     bad properties for cloning arbitrary customer repos.
  //   - the CLI is a fresh process that reads the on-disk CA store, sidestepping
  //     the daemon's boot-cached trust store entirely.
  // The token is passed via GIT_ASKPASS + env (base64 out-of-band), so it never
  // lands in argv, the clone URL, or .git/config.

  hasNativeGit(): boolean {
    return true;
  }

  async cloneRepo(
    url: string,
    path: string,
    options?: { ref?: string; username?: string; password?: string },
  ): Promise<void> {
    if (!this.sandbox) throw new Error("Sandbox not initialized");

    const username = options?.username || "x-access-token";
    const password = options?.password ?? "";
    const ref = options?.ref;

    // Askpass helper: git calls this for credential prompts; it echoes the
    // creds we hand it via env. Keeps secrets out of argv and the URL.
    const askpassPath = "/tmp/git-askpass.sh";
    await this.writeFile(
      askpassPath,
      [
        "#!/bin/sh",
        'case "$1" in',
        '  Username*) printf "%s" "$GIT_USERNAME" ;;',
        '  Password*) printf "%s" "$GIT_PASSWORD" ;;',
        "esac",
        "",
      ].join("\n"),
    );
    await this.exec(`chmod +x ${askpassPath}`);

    // URL/ref/path flow through env and are referenced as quoted "$VARS", never
    // interpolated into the command string — so a hostile branch name or ref
    // (e.g. from a trace's git_ref) can't break quoting or inject shell. This is
    // the structured-arg safety go-git gave us, kept on the CLI path.
    // credential.helper= and core.hooksPath=/dev/null neutralize any inherited
    // credential helper / repo hooks (defense-in-depth, mirrors Daytona's daemon).
    const base = `git -c credential.helper= -c core.hooksPath=/dev/null`;
    const isCommitSha = ref !== undefined && /^[0-9a-f]{7,40}$/i.test(ref);

    let inner: string;
    if (!ref) {
      inner = `${base} clone --depth 1 -- "$GIT_URL" "$GIT_DEST"`;
    } else if (isCommitSha) {
      // A SHA isn't a fetchable ref name — full clone, then checkout.
      inner = `${base} clone -- "$GIT_URL" "$GIT_DEST" && ${base} -C "$GIT_DEST" checkout "$GIT_REF"`;
    } else {
      // Branch or tag.
      inner = `${base} clone --depth 1 --branch "$GIT_REF" -- "$GIT_URL" "$GIT_DEST"`;
    }

    // Merge stderr→stdout: Daytona's exec only surfaces stdout, and git writes
    // progress + errors to stderr.
    const result = await this.exec(`( ${inner} ) 2>&1`, {
      timeout: 180,
      env: {
        GIT_ASKPASS: askpassPath,
        GIT_TERMINAL_PROMPT: "0",
        GIT_USERNAME: username,
        GIT_PASSWORD: password,
        GIT_URL: url,
        GIT_DEST: path,
        ...(ref ? { GIT_REF: ref } : {}),
      },
    });

    if (result.code !== 0) {
      const output = result.stderr || result.stdout || "";
      const sanitized = password ? output.replaceAll(password, "[REDACTED]") : output;
      throw new Error(`git clone failed (exit ${result.code}): ${sanitized.trim()}`);
    }
  }
}

/**
 * Set up gh CLI in a Daytona sandbox and authenticate with a GitHub token.
 * Uses native file upload instead of shell-based file writing.
 */
export async function setupGhCliDaytona(
  executor: Executor,
  githubToken: string,
  githubUsername?: string,
): Promise<void> {
  // Install gh CLI if not present
  await executor.exec(
    `
    type gh >/dev/null 2>&1 || {
      apt-get update -qq
      apt-get install -y -qq curl
      curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null
      chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        | tee /etc/apt/sources.list.d/github-cli.list >/dev/null
      apt-get update -qq
      apt-get install -y -qq gh
    }
  `,
    { timeout: 120 },
  );

  // Authenticate gh CLI via native file upload (avoids shell escaping issues with tokens)
  await executor.writeFile("/tmp/.gh_token", githubToken);
  await executor.exec("gh auth login --with-token < /tmp/.gh_token; rm -f /tmp/.gh_token");

  // Configure git identity
  const name = githubUsername || "TraceRoot Agent";
  const email = githubUsername
    ? `${githubUsername}@users.noreply.github.com`
    : "agent@traceroot.ai";
  await executor.exec(`git config --global user.name "${name}"`);
  await executor.exec(`git config --global user.email "${email}"`);
}
