// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const api = vi.hoisted(() => ({ getProjectNextSteps: vi.fn() }));
vi.mock("@/lib/api", () => api);
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { EVALS_DOCS_URL, NextStepsChecklist, nextStepsStorageKey } from "./next-steps-checklist";

type Done = { first_trace: boolean; detector: boolean; signal: boolean; eval_run: boolean };
const NONE: Done = { first_trace: false, detector: false, signal: false, eval_run: false };

let client: QueryClient;
function renderChecklist(done: Done | Error, { projectId = "proj_1", readOnly = false } = {}) {
  if (done instanceof Error) api.getProjectNextSteps.mockRejectedValue(done);
  else api.getProjectNextSteps.mockResolvedValue(done);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextStepsChecklist projectId={projectId} readOnly={readOnly} />
    </QueryClientProvider>,
  );
}

const card = () => screen.findByRole("region", { name: "Next steps" });
const row = (id: string) => document.querySelector(`[data-step="${id}"]`) as HTMLElement;
const count = () => screen.getByText(/of 4 done$/).textContent;

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  api.getProjectNextSteps.mockReset();
});

describe("Next steps, as figure 14 draws it", () => {
  it("is four rows in order, the first done, with the count of done steps", async () => {
    renderChecklist({ ...NONE, first_trace: true });
    await card();

    expect(count()).toBe("1 of 4 done");
    const rows = Array.from(document.querySelectorAll("[data-step]"));
    expect(rows.map((r) => r.getAttribute("data-step"))).toEqual([
      "first_trace",
      "detector",
      "signal",
      "eval_run",
    ]);
    expect(row("first_trace").dataset.state).toBe("done");
    expect(within(row("first_trace")).getByText("Done")).toBeDefined();
    expect(within(row("first_trace")).getByText("Send your first trace").className).toContain(
      "line-through",
    );
  });

  it("offers each step's way forward", async () => {
    renderChecklist({ ...NONE, first_trace: true });
    await card();

    const detector = within(row("detector"));
    expect(detector.getByText("Optional")).toBeDefined();
    expect(detector.getByText("Flag runs that miss the mark")).toBeDefined();
    expect(detector.getByRole("link", { name: "Create" }).getAttribute("href")).toBe(
      "/projects/proj_1/detectors/new",
    );
    expect(
      detector.getByRole("button", { name: 'Skip "Create your first detector"' }),
    ).toBeDefined();

    // Renamed from "Review": the step is done when the project receives one.
    const signal = within(row("signal"));
    expect(
      signal.getByRole("link", { name: "Receive your first signal" }).getAttribute("href"),
    ).toBe("/projects/proj_1/signals");
    expect(signal.getByText("Shows up once a detector finds a pattern")).toBeDefined();
    expect(signal.getByRole("button", { name: 'Skip "Receive your first signal"' })).toBeDefined();

    const evals = within(row("eval_run"));
    const getStarted = evals.getByRole("link", { name: "Get started" });
    expect(getStarted.getAttribute("href")).toBe(EVALS_DOCS_URL);
    expect(getStarted.getAttribute("target")).toBe("_blank");
    // Not optional, so it cannot be skipped.
    expect(evals.queryByRole("button", { name: /^Skip/ })).toBeNull();
  });
});

describe("before the first trace", () => {
  it("leads to the project's setup instructions and counts nothing", async () => {
    renderChecklist(NONE);
    await card();

    expect(count()).toBe("0 of 4 done");
    const first = within(row("first_trace"));
    expect(first.getByRole("link", { name: "Send your first trace" }).getAttribute("href")).toBe(
      "/projects/proj_1/traces",
    );
    expect(first.queryByText("Done")).toBeNull();
    expect(first.queryByRole("button", { name: /^Skip/ })).toBeNull();
  });
});

describe("skipping", () => {
  it("grays the row, offers an undo, and does not count it", async () => {
    renderChecklist({ ...NONE, first_trace: true });
    await card();

    fireEvent.click(screen.getByRole("button", { name: 'Skip "Create your first detector"' }));

    expect(row("detector").dataset.state).toBe("skipped");
    expect(within(row("detector")).getByText("Skipped")).toBeDefined();
    expect(within(row("detector")).queryByRole("link", { name: "Create" })).toBeNull();
    expect(count()).toBe("1 of 4 done");

    fireEvent.click(
      screen.getByRole("button", { name: 'Undo skipping "Create your first detector"' }),
    );
    expect(row("detector").dataset.state).toBe("todo");
  });

  it("is remembered in this browser for this project only", async () => {
    const { unmount } = renderChecklist({ ...NONE, first_trace: true });
    await card();
    fireEvent.click(screen.getByRole("button", { name: 'Skip "Receive your first signal"' }));
    unmount();

    renderChecklist({ ...NONE, first_trace: true });
    await card();
    await waitFor(() => expect(row("signal").dataset.state).toBe("skipped"));
    cleanup();

    renderChecklist({ ...NONE, first_trace: true }, { projectId: "proj_2" });
    await card();
    expect(row("signal").dataset.state).toBe("todo");
    expect(JSON.parse(window.localStorage.getItem(nextStepsStorageKey("proj_1"))!)).toMatchObject({
      skipped: ["signal"],
    });
  });

  it("gives way to the step being done", async () => {
    window.localStorage.setItem(
      nextStepsStorageKey("proj_1"),
      JSON.stringify({ skipped: ["detector"] }),
    );
    renderChecklist({ ...NONE, first_trace: true, detector: true });
    await card();

    await waitFor(() => expect(row("detector").dataset.state).toBe("done"));
    expect(count()).toBe("2 of 4 done");
  });
});

describe("hiding", () => {
  it("folds the card to one line and opens it again, remembered per project", async () => {
    const { unmount } = renderChecklist({ ...NONE, first_trace: true });
    await card();

    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(document.querySelectorAll("[data-step]")).toHaveLength(0);
    expect(count()).toBe("1 of 4 done");
    unmount();

    renderChecklist({ ...NONE, first_trace: true });
    await card();
    await waitFor(() => expect(document.querySelectorAll("[data-step]")).toHaveLength(0));

    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(document.querySelectorAll("[data-step]")).toHaveLength(4);
  });
});

describe("the signal step, once a signal has arrived", () => {
  it("is done and still leads to the signals", async () => {
    renderChecklist({ ...NONE, first_trace: true, detector: true, signal: true });
    await card();

    expect(row("signal").dataset.state).toBe("done");
    const title = within(row("signal")).getByRole("link", { name: "Receive your first signal" });
    expect(title.getAttribute("href")).toBe("/projects/proj_1/signals");
    expect(title.className).toContain("line-through");
    // The other done steps stay plain text.
    expect(within(row("first_trace")).queryByRole("link")).toBeNull();
  });
});

describe("hidden and reopened, then the optional steps skipped and the last required one done", () => {
  it("folds, and still opens to undo a skip", async () => {
    renderChecklist({ ...NONE, first_trace: true });
    await card();

    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(document.querySelectorAll("[data-step]")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(document.querySelectorAll("[data-step]")).toHaveLength(4);

    fireEvent.click(screen.getByRole("button", { name: 'Skip "Create your first detector"' }));
    fireEvent.click(screen.getByRole("button", { name: 'Skip "Receive your first signal"' }));
    // The eval is still to do, so the card stays open.
    expect(document.querySelectorAll("[data-step]")).toHaveLength(4);

    // The project runs its first eval.
    api.getProjectNextSteps.mockResolvedValue({ ...NONE, first_trace: true, eval_run: true });
    await client.invalidateQueries({ queryKey: ["project-next-steps", "proj_1"] });

    await waitFor(() => expect(count()).toBe("2 of 4 done"));
    expect(document.querySelectorAll("[data-step]")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(document.querySelectorAll("[data-step]")).toHaveLength(4);
    fireEvent.click(
      screen.getByRole("button", { name: 'Undo skipping "Create your first detector"' }),
    );
    expect(row("detector").dataset.state).toBe("todo");
    expect(screen.getByRole("button", { name: "Hide" })).toBeDefined();
  });
});

describe("the end of the list", () => {
  it("removes the card once all four steps are done", async () => {
    const { container } = renderChecklist({
      first_trace: true,
      detector: true,
      signal: true,
      eval_run: true,
    });
    await waitFor(() => expect(api.getProjectNextSteps).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container.innerHTML).toBe("");
  });

  it("folds to one line when every step left is skipped, and opens to undo a skip", async () => {
    renderChecklist({ ...NONE, first_trace: true, eval_run: true });
    await card();

    fireEvent.click(screen.getByRole("button", { name: 'Skip "Create your first detector"' }));
    expect(document.querySelectorAll("[data-step]")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: 'Skip "Receive your first signal"' }));

    // Not removed: two steps were skipped, not done.
    expect(document.querySelectorAll("[data-step]")).toHaveLength(0);
    expect(count()).toBe("2 of 4 done");

    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    fireEvent.click(
      screen.getByRole("button", { name: 'Undo skipping "Receive your first signal"' }),
    );
    expect(row("signal").dataset.state).toBe("todo");
    expect(screen.getByRole("button", { name: "Hide" })).toBeDefined();
  });

  it("opens folded on a later visit when every step left was skipped", async () => {
    window.localStorage.setItem(
      nextStepsStorageKey("proj_1"),
      JSON.stringify({ skipped: ["detector", "signal"] }),
    );
    renderChecklist({ ...NONE, first_trace: true, eval_run: true });
    await card();

    await waitFor(() => expect(document.querySelectorAll("[data-step]")).toHaveLength(0));
    expect(screen.getByRole("button", { name: "Show" })).toBeDefined();
  });
});

describe("when not to show it", () => {
  it("shows nothing to a read-only demo visitor, and reads nothing", async () => {
    const { container } = renderChecklist(NONE, { readOnly: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container.innerHTML).toBe("");
    expect(api.getProjectNextSteps).not.toHaveBeenCalled();
  });

  it("shows nothing when the steps cannot be read", async () => {
    const { container } = renderChecklist(new Error("502"));
    await waitFor(() => expect(api.getProjectNextSteps).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container.innerHTML).toBe("");
  });
});
