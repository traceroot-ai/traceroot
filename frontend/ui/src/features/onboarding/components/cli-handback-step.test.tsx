// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

import type { TraceWait } from "@/lib/hooks/use-trace-wait";
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
      wait={{ kind: "waiting" }}
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
      wait={{ kind: "waiting" }}
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

    expect(screen.getByText(/checkout-agent is ready/)).toBeDefined();
  });

  it("says it is watching for the trace the command will produce", () => {
    // Without this the step gives no sign that anything is listening, so
    // running the command looks like it leads nowhere.
    renderStep();

    expect(screen.getByText(/Waiting for your first trace/)).toBeDefined();
    // And announced rather than merely shown. The whole premise is that nobody
    // is looking at this tab, so a state change that only paints is a state
    // change a screen-reader user never hears about.
    expect(screen.getByRole("status").textContent).toContain("Waiting for your first trace");
  });

  it("keeps the hand-back's own wording while it waits", () => {
    // This step's approved sentence says the page updates, and stays that way.
    renderStep();

    expect(
      screen.getByText("Waiting for your first trace. This page updates when it arrives."),
    ).toBeDefined();
  });

  it("announces the arrival from the same region it announced the wait from", () => {
    // One region for all three states, so the change is announced rather than
    // the region being mounted alongside its own text — which is not.
    renderStep({ wait: { kind: "found", found: { projectId: "proj-1", traceId: "t-1" } } });

    expect(screen.getByRole("status").textContent).toContain("Your first trace arrived");
  });

  it("shows the arrived trace without closing the step down", () => {
    // The page opens the trace; this step only reports it. Until that push
    // lands the link is the way through, and neither alternative below is
    // withdrawn — the arrival adds an exit, it does not remove any.
    const { onSetUpManually, onSkip } = renderStep({
      wait: { kind: "found", found: { projectId: "proj-1", traceId: "t-1" } },
    });

    expect(screen.getByText(/Your first trace arrived/)).toBeDefined();
    expect(screen.getByRole("link", { name: "View it" }).getAttribute("href")).toBe(
      "/projects/proj-1/traces?traceId=t-1",
    );
    // Nothing about the arrival closes the step down.
    expect(screen.getByRole("button", { name: "Set up manually" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeDefined();
    expect(onSetUpManually).not.toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();
  });

  it("says so, and still points somewhere, when no trace turns up", () => {
    // The outcome the spinner must never settle into. The run is still going
    // wherever the command was run; only this page has stopped watching.
    renderStep({ wait: { kind: "gave-up", fallbackUrl: "/projects/proj-1/traces" } });

    expect(screen.getByText(/Still no trace/)).toBeDefined();
    expect(screen.getByRole("link", { name: "Open your traces" }).getAttribute("href")).toBe(
      "/projects/proj-1/traces",
    );
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeDefined();
  });

  it("keeps the trace line above the command, in every state it has", () => {
    // The user's own ask, after watching a competitor: the waiting line goes up,
    // not at the bottom. It is the only line on the step that reports anything
    // happening, and someone who has pasted the command is watching their
    // terminal — so when they glance back at this tab it has to be in the part
    // they see first, not under the thing they have already run.
    const states: TraceWait[] = [
      { kind: "waiting" },
      { kind: "found", found: { projectId: "proj-1", traceId: "t-1" } },
      { kind: "gave-up", fallbackUrl: "/projects/proj-1/traces" },
    ];
    const said = [/Waiting for your first trace/, /Your first trace arrived/, /Still no trace/];

    states.forEach((wait, index) => {
      const { container } = renderStep({ wait });
      const line = screen.getByText(said[index]!);
      const command = container.querySelector("pre")!;

      expect(isAbove(screen.getByText(/is ready/), line)).toBe(true);
      expect(isAbove(line, command)).toBe(true);
      cleanup();
    });
  });

  it("says where the command has to be run", () => {
    // The one fact a reader cannot get from the command itself: it is run
    // against their checkout, not in the dashboard's terminal-shaped box. A
    // user who pastes it into the wrong directory gets a key written somewhere
    // their application will never read.
    renderStep();

    expect(screen.getByText(/Run this where your application lives/)).toBeDefined();
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
