// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";

const nav = vi.hoisted(() => ({ push: vi.fn(), params: new URLSearchParams(), signOut: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: { user: { id: "u1", email: "kai@acme.dev" } } }),
    signOut: nav.signOut,
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push }),
  useSearchParams: () => nav.params,
}));
// The questions themselves are tested in questions-step.test.tsx; here, only
// where finishing them goes.
vi.mock("@/features/onboarding/components/questions-step", () => ({
  QuestionsStep: ({
    onDone,
    account,
  }: {
    onDone: () => void;
    account: { email: string; onSwitch: (saved: Promise<unknown>) => void };
  }) => (
    <>
      <button type="button" onClick={onDone}>
        finish
      </button>
      <button type="button" onClick={() => account.onSwitch(Promise.resolve())}>
        switch as {account.email}
      </button>
    </>
  ),
}));

import { waitFor } from "@testing-library/react";
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

  it("switching account from a terminal sign-up keeps the way back to the terminal", async () => {
    nav.signOut.mockResolvedValue({ error: null });
    nav.params = new URLSearchParams(
      `projectId=proj-1&callbackUrl=${encodeURIComponent("/device?user_code=ABCD1234")}`,
    );
    render(<QuestionsStepPage />);
    fireEvent.click(screen.getByRole("button", { name: "switch as kai@acme.dev" }));

    await waitFor(() => expect(nav.push).toHaveBeenCalled());
    const signIn = new URL(nav.push.mock.calls[0][0], "http://x");
    expect(signIn.pathname).toBe("/auth/sign-in");
    const back = new URL(signIn.searchParams.get("callbackUrl")!, "http://x");
    expect(back.pathname).toBe("/onboarding");
    expect(back.searchParams.get("callbackUrl")).toBe("/device?user_code=ABCD1234");
    // Not the old project: the next account makes its own.
    expect(back.searchParams.get("projectId")).toBeNull();
  });

  it("without a project there is nothing to continue", () => {
    nav.params = new URLSearchParams();
    render(<QuestionsStepPage />);
    expect(screen.getByText(/The questionnaire opens during signup/)).toBeDefined();
    expect(screen.getByRole("link", { name: "Go to your workspaces" }).getAttribute("href")).toBe(
      "/workspaces",
    );
  });
});
