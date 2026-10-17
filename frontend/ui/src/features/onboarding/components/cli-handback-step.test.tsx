// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

import { CliHandbackStep } from "./cli-handback-step";

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
    expect(command).toContain("npx -y traceroot-cli@latest setup");
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

    expect(screen.getByText(/checkout-agent is ready/)).toBeDefined();
  });

  it("shows no runnable command when this deployment's own origin is unresolvable", async () => {
    // `NEXT_PUBLIC_API_URL` is `z.string()` with no URL validation, so a value
    // like this reaches the step. The command it renders carries no `--host`,
    // and that line is the TraceRoot Cloud one — so a self-hosted operator
    // pasting it would sign this machine in against someone else's deployment
    // and send their first traces there, on the last page of signing up.
    const { container } = await renderStepWith({ apiUrl: "http://:8000" });
    const text = container.textContent ?? "";

    expect(text).not.toContain("npx -y traceroot-cli@latest setup");
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
      "npx -y traceroot-cli@latest setup --project proj-1",
    );
    expect(text).not.toContain("NEXT_PUBLIC_API_URL");
  });
});
