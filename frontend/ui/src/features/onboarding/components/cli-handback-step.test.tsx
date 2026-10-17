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

// Shaped like the mint answers it: `trh_` and 43 base64url characters.
const CODE = "trh_abcdefghijklmnopqrstuvwxyz0123456789-_ABCXY";

type StepProps = Partial<Parameters<typeof CliHandbackStep>[0]>;

function renderStep(overrides: StepProps = {}) {
  const onSetUpManually = vi.fn();
  const onSkip = vi.fn();
  // One element for both the first render and any re-render, so a prop added to
  // the step is declared here once. `handoff: null` by default, which is both
  // the first-render case (the mint is a round trip) and the failed-mint case.
  const step = (next: StepProps = {}) => (
    <CliHandbackStep
      projectId="proj-1"
      projectName="my-llm-project"
      handoff={null}
      onSetUpManually={onSetUpManually}
      onSkip={onSkip}
      wait={{ kind: "waiting" }}
      {...overrides}
      {...next}
    />
  );
  const { container, rerender } = render(step());
  return {
    container,
    onSetUpManually,
    onSkip,
    renderAgain: (next: StepProps) => rerender(step(next)),
  };
}

/**
 * The command, read off the `<pre>` rather than matched as one string in the
 * document: the snippet box splits the line into spans to colour `npx`, so no
 * single text node holds the whole command even though `textContent`
 * reassembles it.
 */
function shownCommand(container: HTMLElement): string {
  return container.querySelector("pre")?.textContent ?? "";
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
      handoff={null}
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

    // A user with two projects who is handed the command without `--project`
    // answers "which project?" from memory, and a wrong answer sends their
    // first traces somewhere they will not look.
    const command = shownCommand(container);
    expect(command).toContain("npx -y traceroot-cli@0.6.1 setup");
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
    // The line is shared with the device page, which says it "opens it"; this
    // step's approved sentence says the page updates, and stays that way.
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

  it("carries the handoff code, so the terminal needs no browser page", () => {
    // The whole point of the step as it now stands: the terminal this line is
    // pasted into holds no credential, and without a code `setup` would sign
    // in by opening a second browser page that waits for the same first trace
    // this page is already watching.
    const { container } = renderStep({ handoff: CODE });

    const command = shownCommand(container);
    expect(command).toContain(`--handoff ${CODE}`);
    // Bare, not quoted: base64url behind a `trh_` prefix holds no character a
    // shell treats specially.
    expect(command).not.toContain(`'${CODE}'`);
    expect(command).not.toContain(`"${CODE}"`);
    // And `--project` is still there. It is what makes an expired code cheap:
    // the CLI falls back to the device flow and resolves the project from the
    // flag instead of asking.
    expect(command).toContain("--project proj-1");
  });

  it("prints the command that works anyway when there is no code", () => {
    // A failed mint degrades to the status quo and says nothing. Today's
    // command — no `--handoff` — is what this step printed before handoffs
    // existed, and it works, by way of the second page.
    const { container } = renderStep({ handoff: null });

    const command = shownCommand(container);
    expect(command).not.toContain("--handoff");
    expect(command).toContain("npx -y traceroot-cli@0.6.1 setup");
    expect(command).toContain("--project proj-1");
    // Nothing is said about it: no error, no warning, no second line.
    expect(screen.queryByText(/handoff/i)).toBeNull();
    expect(screen.getByText(/Run this where your application lives/)).toBeDefined();
  });

  it("swaps in the replacement code the page mints before expiry", () => {
    // A tab left open outlives any one code, so the page re-mints and hands
    // down a new value. What must not happen is the line keeping the stale one
    // — the old code is invalidated by the new one, so a user who copies after
    // the swap has to get what is on screen.
    const replacement = `${CODE.slice(0, -3)}XYZ`;
    const { container, renderAgain } = renderStep({ handoff: CODE });
    expect(shownCommand(container)).toContain(`--handoff ${CODE}`);

    renderAgain({ handoff: replacement });

    expect(shownCommand(container)).toContain(`--handoff ${replacement}`);
    expect(shownCommand(container)).not.toContain(CODE);
    expect(shownCommand(container)).toContain("--project proj-1");
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
      "npx -y traceroot-cli@0.6.1 setup --project proj-1",
    );
    expect(text).not.toContain("NEXT_PUBLIC_API_URL");
  });
});
