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
      wait={{ kind: "waiting" }}
      {...overrides}
    />,
  );
  return { container, onSetUpManually, onSkip };
}

afterEach(cleanup);

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

  it("says where the command has to be run", () => {
    // The one fact a reader cannot get from the command itself: it is run
    // against their checkout, not in the dashboard's terminal-shaped box. A
    // user who pastes it into the wrong directory gets a key written somewhere
    // their application will never read.
    renderStep();

    expect(screen.getByText(/Run this where your application lives/)).toBeDefined();
  });
});
