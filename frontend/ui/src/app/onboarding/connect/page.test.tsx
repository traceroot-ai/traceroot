// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  search: "projectId=proj_1",
  getProject: vi.fn(),
  stepProps: null as null | Record<string, unknown>,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams(mocks.search),
}));
vi.mock("@/lib/api", () => ({ getProject: mocks.getProject }));
vi.mock("@/features/onboarding/components/connect-step", () => ({
  ConnectStep: (
    props: Record<string, unknown> & { onContinue: () => void; onSkip: () => void },
  ) => {
    mocks.stepProps = props;
    return (
      <div>
        <button onClick={props.onContinue}>Continue</button>
        <button onClick={props.onSkip}>Skip for now</button>
      </div>
    );
  },
}));

import ConnectStepPage from "./page";

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ConnectStepPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  mocks.push.mockReset();
  mocks.getProject.mockReset();
  mocks.search = "projectId=proj_1";
  mocks.stepProps = null;
});

describe("the connect step page", () => {
  it("connects the project's workspace, coming back to this step with the project", async () => {
    mocks.search = "projectId=proj_1&slack=error&reason=access_denied";
    mocks.getProject.mockResolvedValue({ id: "proj_1", name: "p", workspace_id: "ws_1" });
    renderPage();

    await screen.findByRole("button", { name: "Continue" });
    expect(screen.getByRole("heading", { name: "Connect GitHub and Slack" })).toBeDefined();
    expect(screen.getByText(/To connect later, go to/).textContent).toContain(
      "Workspace settings → Integrations",
    );
    expect(mocks.stepProps).toMatchObject({
      workspaceId: "ws_1",
      returnTo: "/onboarding/connect?projectId=proj_1",
      slackOutcome: { result: "error", reason: "access_denied" },
    });
  });

  it.each([
    ["projectId=proj_1", "/onboarding/setup?projectId=proj_1"],
    ["projectId=proj_1&created=project", "/onboarding/setup?projectId=proj_1&created=project"],
  ])("goes on to the setup step from Continue and Skip (%s)", async (search, setup) => {
    mocks.search = search;
    mocks.getProject.mockResolvedValue({ id: "proj_1", name: "p", workspace_id: "ws_1" });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(mocks.push.mock.calls).toEqual([[setup], [setup]]);
  });

  it("says the step is unavailable without a project", () => {
    mocks.search = "";
    renderPage();
    expect(screen.getByText("This step isn't available")).toBeDefined();
    expect(mocks.getProject).not.toHaveBeenCalled();
  });
});
