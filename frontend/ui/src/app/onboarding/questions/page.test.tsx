// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";

const nav = vi.hoisted(() => ({ push: vi.fn(), params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push }),
  useSearchParams: () => nav.params,
}));
// The questions themselves are tested in questions-step.test.tsx; here, only
// where finishing them goes.
vi.mock("@/features/onboarding/components/questions-step", () => ({
  QuestionsStep: ({ onDone }: { onDone: () => void }) => (
    <button type="button" onClick={onDone}>
      finish
    </button>
  ),
}));

import QuestionsStepPage from "./page";

afterEach(() => {
  cleanup();
  nav.push.mockReset();
});

function finishAt(query: string) {
  nav.params = new URLSearchParams(query);
  render(<QuestionsStepPage />);
  fireEvent.click(screen.getByRole("button", { name: "finish" }));
  return nav.push.mock.calls.at(-1)?.[0];
}

describe("after the questions", () => {
  it("a browser sign-up goes on to connect GitHub and Slack, with its project", () => {
    expect(finishAt("projectId=proj-1")).toBe("/onboarding/connect?projectId=proj-1");
  });

  it("an account that only needed a project says so on the next step too", () => {
    expect(finishAt("projectId=proj-1&created=project")).toBe(
      "/onboarding/connect?projectId=proj-1&created=project",
    );
  });

  it("a sign-up from the terminal goes back to it", () => {
    expect(
      finishAt(`projectId=proj-1&callbackUrl=${encodeURIComponent("/device?user_code=ABCD1234")}`),
    ).toBe("/device?user_code=ABCD1234");
  });

  it("an off-site hand-back is ignored", () => {
    expect(
      finishAt(`projectId=proj-1&callbackUrl=${encodeURIComponent("https://evil.example/x")}`),
    ).toBe("/onboarding/connect?projectId=proj-1");
  });

  it("without a project there is nothing to continue", () => {
    nav.params = new URLSearchParams();
    render(<QuestionsStepPage />);
    expect(screen.getByText("This step isn't available")).toBeDefined();
  });
});
