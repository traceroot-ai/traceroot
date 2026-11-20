// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OnboardingAnswers } from "@/lib/onboarding-questions";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
  finish: vi.fn(),
}));
vi.mock("@/lib/api/onboarding-questions", () => ({
  getOnboardingAnswers: api.get,
  saveOnboardingAnswers: api.save,
  finishOnboardingQuestions: api.finish,
}));

import { QuestionsStep } from "./questions-step";

const EMPTY: OnboardingAnswers = {
  role: null,
  company: null,
  uses: [],
  source: null,
  sourceOther: null,
  companyAsked: false,
  done: false,
};
const onDone = vi.fn();

function renderStep(answers: Partial<OnboardingAnswers> = {}) {
  api.get.mockResolvedValue({ ...EMPTY, ...answers });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <QuestionsStep onDone={onDone} />
    </QueryClientProvider>,
  );
}

const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const saved = () => api.save.mock.calls.map(([patch]) => patch);

beforeEach(() => {
  api.save.mockResolvedValue({ saved: true });
  api.finish.mockResolvedValue({ finished: true });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("a work-email sign-up", () => {
  it("asks three questions, saving each, and finishes once", async () => {
    renderStep();
    await screen.findByText("Step 1 of 3");
    expect(screen.getByRole("heading", { name: "What best describes you?" })).toBeDefined();
    fireEvent.click(screen.getByRole("radio", { name: "Founder" }));
    click("Continue");

    await screen.findByText("Step 2 of 3");
    expect(screen.queryByPlaceholderText("acme.com")).toBeNull();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Agents that plan and act on their own" }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Watching what my coding agents do" }));
    expect(screen.getByText("2 of 3")).toBeDefined();
    click("Continue");

    await screen.findByText("Step 3 of 3");
    fireEvent.click(screen.getByRole("radio", { name: "GitHub" }));
    click("Continue");

    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(saved()).toEqual([
      { role: "founder" },
      { uses: ["autonomous_agents", "coding_agents"] },
      { source: "github", sourceOther: null },
    ]);
    expect(api.finish).toHaveBeenCalledOnce();
  });

  it("can skip every question", async () => {
    renderStep();
    await screen.findByText("Step 1 of 3");
    click("Skip");
    await screen.findByText("Step 2 of 3");
    click("Skip");
    await screen.findByText("Step 3 of 3");
    click("Skip");

    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(saved()).toEqual([{ role: null }, { uses: [] }, { source: null, sourceOther: null }]);
    expect(api.finish).toHaveBeenCalledOnce();
  });
});

describe("a personal-email sign-up", () => {
  it("is also asked for the company, as step 2 of 4", async () => {
    renderStep({ companyAsked: true });
    await screen.findByText("Step 1 of 4");
    click("Continue");
    await screen.findByText("Step 2 of 4");
    fireEvent.change(screen.getByPlaceholderText("acme.com"), {
      target: { value: "  acme.dev " },
    });
    click("Continue");
    await screen.findByText("Step 3 of 4");
    expect(saved()[1]).toEqual({ company: "acme.dev" });
  });

  it("keeps the typed answers out of analytics capture", async () => {
    renderStep({ companyAsked: true });
    await screen.findByText("Step 1 of 4");
    click("Continue");
    expect((await screen.findByPlaceholderText("acme.com")).className).toContain("ph-no-capture");
    click("Continue");
    await screen.findByText("Step 3 of 4");
    click("Continue");
    expect((await screen.findByPlaceholderText("Somewhere else? Tell us")).className).toContain(
      "ph-no-capture",
    );
  });
});

describe("answering", () => {
  it("allows up to three uses, and a pick to be let go", async () => {
    renderStep();
    await screen.findByText("Step 1 of 3");
    click("Continue");
    await screen.findByText("Step 2 of 3");
    for (const name of [
      "A support bot or chat assistant",
      "Answering questions from our own documents",
      "Just looking around for now",
    ])
      fireEvent.click(screen.getByRole("checkbox", { name }));
    const fourth = screen.getByRole("checkbox", { name: "Something else" });
    expect(fourth.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Just looking around for now" }));
    expect(fourth.hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("2 of 3")).toBeDefined();
  });

  it("takes a typed source with no button picked", async () => {
    renderStep();
    await screen.findByText("Step 1 of 3");
    click("Continue");
    await screen.findByText("Step 2 of 3");
    click("Continue");
    fireEvent.change(await screen.findByPlaceholderText("Somewhere else? Tell us"), {
      target: { value: "a meetup" },
    });
    click("Continue");
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(saved().at(-1)).toEqual({ source: null, sourceOther: "a meetup" });
  });

  it("goes back with the earlier answer still picked", async () => {
    renderStep();
    await screen.findByText("Step 1 of 3");
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Student" }));
    click("Continue");
    await screen.findByText("Step 2 of 3");
    click("Back");
    await screen.findByText("Step 1 of 3");
    expect(screen.getByRole("radio", { name: "Student" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("starts from what was saved, after a refresh part way through", async () => {
    renderStep({ role: "data", uses: ["rag"] });
    await screen.findByText("Step 1 of 3");
    expect(screen.getByRole("radio", { name: "Data or ML" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("finishes after the last answer is saved", async () => {
    let saveDone = false;
    api.save.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => ((saveDone = true), resolve({})), 10)),
    );
    api.finish.mockImplementation(async () => {
      expect(saveDone).toBe(true);
      return { finished: true };
    });
    renderStep();
    await screen.findByText("Step 1 of 3");
    click("Skip");
    click("Skip");
    click("Skip");
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  });
});

describe("saving", () => {
  it("finishes only after every answer is saved, not just the last", async () => {
    // A quick Continue through the last screens: the third screen's save is
    // still in flight when the fourth finishes.
    const pending: (() => void)[] = [];
    let inFlight = 0;
    api.save.mockImplementation(
      () =>
        new Promise((resolve) => {
          inFlight += 1;
          pending.push(() => {
            inFlight -= 1;
            resolve({});
          });
        }),
    );
    let savesInFlightAtFinish = -1;
    api.finish.mockImplementation(async () => {
      savesInFlightAtFinish = inFlight;
      return { finished: true };
    });
    renderStep();
    await screen.findByText("Step 1 of 3");
    click("Skip");
    click("Skip");
    click("Skip");
    // Answer the saves last to first.
    await waitFor(() => expect(pending).toHaveLength(api.save.mock.calls.length));
    while (pending.length) {
      pending.pop()!();
      await new Promise((r) => setTimeout(r, 5));
    }
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(savesInFlightAtFinish).toBe(0);
  });

  it("saves in the order the answers were given", async () => {
    renderStep();
    await screen.findByText("Step 1 of 3");
    fireEvent.click(screen.getByRole("radio", { name: "Student" }));
    click("Continue");
    await screen.findByText("Step 2 of 3");
    click("Back");
    fireEvent.click(screen.getByRole("radio", { name: "Founder" }));
    click("Continue");
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(2));
    expect(saved()).toEqual([{ role: "student" }, { role: "founder" }]);
  });
});

describe("switching account", () => {
  it("names the account, and hands over the answers still being saved", async () => {
    let finishSave!: () => void;
    api.save.mockImplementation(() => new Promise((resolve) => (finishSave = () => resolve({}))));
    const onSwitch = vi.fn();
    api.get.mockResolvedValue(EMPTY);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <QuestionsStep
          onDone={onDone}
          account={{ email: "kai@acme.dev", switching: false, onSwitch }}
        />
      </QueryClientProvider>,
    );
    await screen.findByText("Step 1 of 3");
    expect(screen.getByText("as kai@acme.dev")).toBeDefined();

    fireEvent.click(screen.getByRole("radio", { name: "Founder" }));
    click("Continue");
    click("Not you? Sign out");

    const saved: Promise<unknown> = onSwitch.mock.calls[0][0];
    let settled = false;
    void saved.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    finishSave();
    await waitFor(() => expect(settled).toBe(true));
    expect(saved).toBeInstanceOf(Promise);
    expect(api.save).toHaveBeenCalledWith({ role: "founder" });
  });
});

describe("asked once", () => {
  it("goes straight on for someone who has been through them", async () => {
    renderStep({ done: true });
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(screen.queryByText(/Step 1 of/)).toBeNull();
  });

  it("does not hold up a sign-up whose answers cannot be read", async () => {
    api.get.mockRejectedValue(new Error("down"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <QuestionsStep onDone={onDone} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce(), { timeout: 3000 });
  });

  it("goes on when saving or finishing fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    api.save.mockRejectedValue(new Error("down"));
    api.finish.mockRejectedValue(new Error("down"));
    renderStep();
    await screen.findByText("Step 1 of 3");
    click("Continue");
    click("Continue");
    click("Continue");
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  });
});
