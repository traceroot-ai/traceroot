// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

import { CliHandbackStep } from "./cli-handback-step";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

function renderStep(overrides: Partial<Parameters<typeof CliHandbackStep>[0]> = {}) {
  const onSetUpManually = vi.fn();
  const onSkip = vi.fn();
  const { container } = render(
    <CliHandbackStep
      projectId="proj-1"
      projectName="my-llm-project"
      onSetUpManually={onSetUpManually}
      onSkip={onSkip}
      {...overrides}
    />,
  );
  return { container, onSetUpManually, onSkip };
}

/** Document order, so "above" is asserted rather than read off the markup. */
function isAbove(first: Element, second: Element): boolean {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

/**
 * Renders the step against a stated deployment.
 *
 * Both env vars are stubbed on every call, never left to the machine running
 * the suite. `NEXT_PUBLIC_API_URL` is read through `@/env.client`, which parses
 * it once at module load, so the stub has to be followed by a fresh import of
 * the step as well.
 */
async function renderStepWith(env: { apiUrl?: string; appUrl?: string }) {
  // `/api/v1` is the API URL's own schema default, i.e. the same-origin case.
  vi.stubEnv("NEXT_PUBLIC_API_URL", env.apiUrl ?? "/api/v1");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", env.appUrl ?? "");
  vi.resetModules();
  const { CliHandbackStep: Reloaded } = await import("./cli-handback-step");
  return render(
    <Reloaded
      projectId="proj-1"
      projectName="my-llm-project"
      onSetUpManually={vi.fn()}
      onSkip={vi.fn()}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("CliHandbackStep", () => {
  it("shows the setup command, pointed at the project just created", () => {
    const { container } = renderStep();

    // Read off the `<pre>` rather than matched as one string in the document:
    // the snippet box splits the line into spans to colour `npx`, so no single
    // text node holds the whole command even though `textContent` reassembles
    // it. A user with two projects who is handed the command without
    // `--project` answers "which project?" from memory, and a wrong answer
    // sends their first traces somewhere they will not look.
    const command = container.querySelector("pre")?.textContent ?? "";
    expect(command).toContain("npx -y traceroot-cli@0.6.0 setup");
    expect(command).toContain("--project proj-1");
  });

  it("offers the manual path and the way out without running the command", () => {
    // A user who will not paste a CLI invocation into their shell still has to
    // be able to leave this step — it is the last page of signing up.
    const { onSetUpManually, onSkip } = renderStep();

    fireEvent.click(screen.getByRole("button", { name: "Set up manually" }));
    expect(onSetUpManually).toHaveBeenCalledTimes(1);
    expect(onSkip).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onSetUpManually).toHaveBeenCalledTimes(1);
  });

  it("names the project so the id in the command is checkable", () => {
    renderStep({ projectName: "checkout-agent" });

    expect(screen.getByText(/checkout-agent's code lives/)).toBeDefined();
  });

  it("leaves the first-trace line to the page", () => {
    // The page renders it once, in the header above the card, so that it stays
    // in one place across both steps. A copy here would be a second one on
    // screen and would move with the step. What the line says, and that it is
    // announced, is pinned where it now lives: page.first-trace.test.tsx.
    renderStep();

    expect(screen.queryByText(/Waiting for your first trace/)).toBeNull();
    expect(screen.queryByText(/Your first trace arrived/)).toBeNull();
    expect(screen.queryByText(/Still no trace/)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps the command under the line that names the project", () => {
    const { container } = renderStep();

    expect(isAbove(screen.getByText(/code lives/), container.querySelector("pre")!)).toBe(true);
  });

  it("says what the command does, and where it has to be run", () => {
    // Two facts a reader cannot get from a command they have not run. That it
    // edits their repository is the one that decides whether they paste it at
    // all, and the step used to print the command without saying it. That it
    // runs against their checkout rather than in the dashboard's
    // terminal-shaped box is the other: pasted in the wrong directory it
    // writes a key somewhere the application will never read it.
    renderStep();

    const line = screen.getByText(/Writes the API key into your repository/);
    expect(line.textContent).toContain("waits for the first trace");
    expect(line.textContent).toContain("Run it where my-llm-project's code lives");
    expect(screen.getByRole("link", { name: "View the tracing docs" }).getAttribute("href")).toBe(
      "https://traceroot.ai/docs/tracing/get-started",
    );
  });

  it("does not say setup always instruments the repository itself", () => {
    // Setup asks how to instrument: run an agent, write the task for the
    // reader's own agent, or print the steps. Unattended, it writes the task,
    // and on that route it changes no code, so only the agent route waits for
    // the first trace. The traces panel says so in the same words.
    renderStep();

    const line = screen.getByText(/Writes the API key into your repository/);
    expect(line.textContent).toContain(
      "either has a coding agent instrument it and waits for the first trace, or hands you the task to run yourself.",
    );
    expect(line.textContent).not.toContain("yourself, and waits for the first trace");
    expect(line.textContent).not.toContain("Instruments your repository");
  });

  it("says what setup asks before it edits, and where it asks", () => {
    // The consent the traces panel states, because this is the same command.
    // Only an interactive terminal gets the questions; unattended, setup asks
    // nothing, writes the task rather than launching an agent, and carries on
    // over uncommitted changes.
    renderStep();

    expect(screen.getByText(/Writes the API key into your repository/).textContent).toContain(
      "In an interactive terminal, asks before editing your code and before continuing over uncommitted changes.",
    );
  });

  it("names the Node version setup needs", () => {
    // `setup` refuses a Node older than 20.12, though the rest of the CLI runs
    // on 20.3, so a working CLI is no sign this command will start.
    renderStep();

    expect(screen.getByText(/Writes the API key into your repository/).textContent).toContain(
      "Needs Node.js 20.12 or later.",
    );
  });

  it("shows no runnable command when this deployment's own origin is unresolvable", async () => {
    // `NEXT_PUBLIC_API_URL` is `z.string()` with no URL validation, so a value
    // like this reaches the step. The command it renders carries no `--host`,
    // and that line is the TraceRoot Cloud one — so a self-hosted operator
    // pasting it would sign this machine in against someone else's deployment
    // and send their first traces there, on the last page of signing up.
    const { container } = await renderStepWith({ apiUrl: "http://:8000" });
    const text = container.textContent ?? "";

    expect(text).not.toContain("npx -y traceroot-cli@");
    // No code block and so no copy button: a command in that frame reads as one
    // to paste whatever the surrounding text says.
    expect(container.querySelector("pre")).toBeNull();
    expect(screen.queryByText("Finish setting up in your terminal")).toBeNull();
  });

  it("names the variable and its value, which is what the reader can act on", async () => {
    // The person finishing a self-hosted first run is usually the person who
    // sets this, and the value is already public — it is inlined into this
    // bundle — so showing it discloses nothing new and saves a hunt.
    const { container } = await renderStepWith({ apiUrl: "http://:8000" });
    const text = container.textContent ?? "";

    expect(text).toContain("NEXT_PUBLIC_API_URL");
    expect(text).toContain("http://:8000");
    // The doors out of the step are the half of it that still works.
    expect(screen.getByRole("button", { name: "Set up manually" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeDefined();
  });

  it("keeps the command for a deployment the CLI's own default already serves", async () => {
    // The contrasting case: both flags come back empty because none are needed,
    // which still has to render the bare command rather than withhold it.
    const { container } = await renderStepWith({
      apiUrl: "https://app.traceroot.ai/api/v1",
      appUrl: "https://app.traceroot.ai",
    });
    const text = container.textContent ?? "";

    // The whole line, not a prefix of it: on Cloud the unflagged command is the
    // correct one, so a stray `--host` here would be the error in reverse.
    expect(container.querySelector("pre")?.textContent).toBe(
      "npx -y traceroot-cli@0.6.0 setup --project proj-1",
    );
    expect(text).not.toContain("NEXT_PUBLIC_API_URL");
  });
});
