// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

import { CliHandbackStep } from "./cli-handback-step";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// Shaped like the mint answers it: `trh_` and 43 base64url characters.
const CODE = "trh_abcdefghijklmnopqrstuvwxyz0123456789-_ABC";

function renderStep(overrides: Partial<Parameters<typeof CliHandbackStep>[0]> = {}) {
  const onSetUpManually = vi.fn();
  const onSkip = vi.fn();
  // `handoff: null` by default, which is both the first-render case (the mint
  // is a round trip) and the failed-mint case.
  const { container, rerender } = render(
    <CliHandbackStep
      projectId="proj-1"
      projectName="my-llm-project"
      handoff={null}
      onSetUpManually={onSetUpManually}
      onSkip={onSkip}
      {...overrides}
    />,
  );
  function renderAgain(next: Partial<Parameters<typeof CliHandbackStep>[0]>) {
    rerender(
      <CliHandbackStep
        projectId="proj-1"
        projectName="my-llm-project"
        handoff={null}
        onSetUpManually={onSetUpManually}
        onSkip={onSkip}
        {...overrides}
        {...next}
      />,
    );
  }
  return { container, onSetUpManually, onSkip, renderAgain };
}

/** The command, read off the `<pre>` the snippet box splits into spans. */
function shownCommand(container: HTMLElement): string {
  return container.querySelector("pre")?.textContent ?? "";
}

/** Document order, so "above" is asserted rather than read off the markup. */
function isAbove(first: Element, second: Element): boolean {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
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

  it("leaves the first-trace line to the page", () => {
    // The page renders it once, in the header above the card, so that it stays
    // in one place across both steps. A copy here would be a second one on
    // screen and would move with the step.
    renderStep();

    expect(screen.queryByText(/Waiting for your first trace/)).toBeNull();
    expect(screen.queryByText(/Your first trace arrived/)).toBeNull();
    expect(screen.queryByText(/Still no trace/)).toBeNull();
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

  it("keeps the command under the line that names the project", () => {
    const { container } = renderStep();

    expect(isAbove(screen.getByText(/is ready/), container.querySelector("pre")!)).toBe(true);
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
