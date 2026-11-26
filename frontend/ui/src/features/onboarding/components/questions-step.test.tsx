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

import { ApiError } from "@/lib/api/errors";
import { QuestionsStep } from "./questions-step";

const EMPTY: OnboardingAnswers = {
  userId: "u1",
  role: null,
  roleOther: null,
  company: null,
  uses: [],
  usesOther: null,
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
// Every save names the account the answers were read for.
const saved = () =>
  api.save.mock.calls.map(([userId, patch]) => {
    expect(userId).toBe("u1");
    return patch;
  });

beforeEach(() => {
  window.sessionStorage.clear();
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
    expect(api.finish).toHaveBeenCalledWith("u1");
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
    click("Skip");
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
    click("Skip");
    expect((await screen.findByPlaceholderText("acme.com")).className).toContain("ph-no-capture");
    click("Skip");
    await screen.findByText("Step 3 of 4");
    click("Skip");
    expect((await screen.findByPlaceholderText("Somewhere else? Tell us")).className).toContain(
      "ph-no-capture",
    );
  });
});

describe("answering", () => {
  it("allows up to three uses, and a pick to be let go", async () => {
    renderStep();
    await screen.findByText("Step 1 of 3");
    click("Skip");
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

  it("shows optional private details only for selected Other options", async () => {
    renderStep();
    await screen.findByText("Step 1 of 3");
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Something else" }));
    const role = screen.getByRole("textbox", { name: "Describe your role (optional)" });
    expect(role.getAttribute("maxlength")).toBe("200");
    expect(role.className).toContain("ph-no-capture");
    fireEvent.change(role, { target: { value: "  Research librarian  " } });
    click("Continue");
    await screen.findByText("Step 2 of 3");
    expect(saved()[0]).toEqual({ role: "other", roleOther: "Research librarian" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Something else" }));
    const uses = screen.getByRole("textbox", { name: "Describe your use case (optional)" });
    expect(uses.className).toContain("ph-no-capture");
    fireEvent.change(uses, { target: { value: "Classify citations" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "A support bot or chat assistant" }));
    click("Continue");
    await screen.findByText("Step 3 of 3");
    expect(saved()[1]).toEqual({
      uses: ["other", "chat_support"],
      usesOther: "Classify citations",
    });
    click("Back");
    fireEvent.click(screen.getByRole("checkbox", { name: "Something else" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Something else" }));
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("");
    click("Continue");
    await screen.findByText("Step 3 of 3");
    expect(saved()[2]).toEqual({ uses: ["chat_support", "other"], usesOther: null });
  });

  it("restores submitted details and clears them on explicit skip", async () => {
    renderStep({
      role: "other",
      roleOther: "Research librarian",
      uses: ["other"],
      usesOther: "Classify citations",
    });
    await screen.findByText("Step 1 of 3");
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Research librarian");
    click("Skip");
    await screen.findByText("Step 2 of 3");
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Classify citations");
    click("Skip");
    await screen.findByText("Step 3 of 3");
    click("Back");
    expect(screen.queryByRole("textbox")).toBeNull();
    click("Back");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(saved()).toEqual([{ role: null }, { uses: [] }]);
  });

  it("takes a typed source with no button picked", async () => {
    renderStep();
    await screen.findByText("Step 1 of 3");
    click("Skip");
    await screen.findByText("Step 2 of 3");
    click("Skip");
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

  it("restores the screen and its saved answers after refresh, including after Skip and Back", async () => {
    const answers: Partial<OnboardingAnswers> = { role: "data", uses: ["rag"] };
    let view = renderStep(answers);
    await screen.findByText("Step 1 of 3");
    click("Continue");
    await screen.findByText("Step 2 of 3");
    click("Continue");
    await screen.findByText("Step 3 of 3");
    view.unmount();
    view = renderStep(answers);
    await screen.findByText("Step 3 of 3");
    click("Back");
    view.unmount();
    view = renderStep(answers);
    await screen.findByText("Step 2 of 3");
    expect(
      screen
        .getByRole("checkbox", { name: "Answering questions from our own documents" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    click("Back");
    expect(screen.getByRole("radio", { name: "Data or ML" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    click("Skip");
    await screen.findByText("Step 2 of 3");
    view.unmount();
    renderStep({ uses: ["rag"] });
    await screen.findByText("Step 2 of 3");
  });

  it("keeps the last acknowledged question when refreshed during a pending save", async () => {
    let settle!: () => void;
    api.save.mockImplementationOnce(
      () => new Promise((resolve) => (settle = () => resolve({ saved: true }))),
    );
    const view = renderStep();
    await screen.findByText("Step 1 of 3");
    fireEvent.click(screen.getByRole("radio", { name: "Founder" }));
    click("Continue");
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
    view.unmount();
    renderStep();
    await screen.findByText("Step 1 of 3");
    settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessionStorage.getItem("onboarding:question:u1")).toBeNull();
  });

  it("uses Skip for blank answers and Continue for a selection or nonblank text", async () => {
    renderStep({ companyAsked: true });
    await screen.findByText("Step 1 of 4");
    const next = () => screen.getByRole("button", { name: "Continue" });
    expect(next().hasAttribute("disabled")).toBe(true);
    click("Continue");
    expect(api.save).not.toHaveBeenCalled();
    click("Skip");
    await screen.findByText("Step 2 of 4");
    fireEvent.change(screen.getByPlaceholderText("acme.com"), { target: { value: "  " } });
    expect(next().hasAttribute("disabled")).toBe(true);
    click("Skip");
    await screen.findByText("Step 3 of 4");
    expect(next().hasAttribute("disabled")).toBe(true);
    const other = screen.getByRole("checkbox", { name: "Something else" });
    fireEvent.click(other);
    expect(next().hasAttribute("disabled")).toBe(false);
    fireEvent.click(other);
    expect(next().hasAttribute("disabled")).toBe(true);
    click("Skip");
    await screen.findByText("Step 4 of 4");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  " } });
    expect(next().hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "a meetup" } });
    expect(next().hasAttribute("disabled")).toBe(false);
    click("Continue");
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
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
    await screen.findByText("Step 2 of 3");
    click("Skip");
    await screen.findByText("Step 3 of 3");
    click("Skip");
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  });
});

describe("saving", () => {
  it("keeps signup moving after a failed save while refresh reopens the missed answer", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    api.save.mockRejectedValueOnce(new Error("down"));
    const view = renderStep();
    await screen.findByText("Step 1 of 3");
    fireEvent.click(screen.getByRole("radio", { name: "Founder" }));
    click("Continue");
    await screen.findByText("Step 2 of 3");
    view.unmount();
    renderStep();
    await screen.findByText("Step 1 of 3");
    expect(screen.getByRole("radio", { name: "Founder" }).getAttribute("aria-checked")).toBe(
      "false",
    );
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
    expect(api.save).toHaveBeenCalledWith("u1", { role: "founder" });
  });
});

describe("another tab signs this browser in as someone else", () => {
  it("stops when a save is refused for the account, and does not move on", async () => {
    api.save.mockRejectedValue(new ApiError(409, "Signed in as a different account"));
    renderStep();
    await screen.findByText("Step 1 of 3");
    fireEvent.click(screen.getByRole("radio", { name: "Founder" }));
    click("Continue");
    await screen.findByText(/now signed in as a different account/);
    expect(screen.getByRole("button", { name: "Reload" })).toBeDefined();
    expect(api.finish).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("starts the new account on its own answers, not the old draft", async () => {
    api.get.mockImplementation(async () => ({ ...EMPTY, userId: "u1" }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <QuestionsStep onDone={onDone} userId="u1" />
      </QueryClientProvider>,
    );
    await screen.findByText("Step 1 of 3");
    fireEvent.click(screen.getByRole("radio", { name: "Founder" }));
    expect(screen.getByRole("radio", { name: "Founder" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    click("Continue");
    await screen.findByText("Step 2 of 3");

    // The session now names another account, whose saved answer is different.
    api.get.mockImplementation(async () => ({ ...EMPTY, userId: "u2", role: "student" }));
    view.rerender(
      <QueryClientProvider client={client}>
        <QuestionsStep onDone={onDone} userId="u2" />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Student" }).getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
    expect(screen.getByRole("radio", { name: "Founder" }).getAttribute("aria-checked")).toBe(
      "false",
    );
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
    click("Skip");
    await screen.findByText("Step 2 of 3");
    click("Skip");
    await screen.findByText("Step 3 of 3");
    click("Skip");
    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  });
});

describe("option layout", () => {
  // jsdom has no layout, so this pins the classes the measured layout comes
  // from: two columns once the options are 20rem wide, a whole row for long
  // choices, and one column for the uses.
  const options = (group: string) => screen.getByRole("group", { name: group });
  const twoColumns = (group: string) => options(group).className.includes("@[20rem]:grid-cols-2");
  const wholeRow = (name: string) =>
    screen.getByRole("radio", { name }).className.includes("@[20rem]:col-span-2");

  it("lays out each question's choices in order, long ones on their own rows", async () => {
    renderStep();
    await screen.findByText("Step 1 of 3");
    expect(twoColumns("What best describes you?")).toBe(true);
    expect(
      screen
        .getAllByRole("radio")
        .map((option) => [option.textContent, wholeRow(option.textContent!)]),
    ).toEqual([
      ["Software engineering", false],
      ["Data or ML", false],
      ["Product management", false],
      ["Founder", false],
      ["Engineering or company leadership", true],
      ["Student", false],
      ["Something else", false],
    ]);

    click("Skip");
    await screen.findByText("Step 2 of 3");
    expect(twoColumns("What will you use traceroot for?")).toBe(false);

    click("Skip");
    await screen.findByText("Step 3 of 3");
    expect(twoColumns("Where did you hear about us?")).toBe(true);
    expect(
      screen
        .getAllByRole("radio")
        .filter((o) => wholeRow(o.textContent!))
        .map((o) => o.textContent),
    ).toEqual(["A friend or coworker", "A search engine or AI assistant"]);
  });
});
