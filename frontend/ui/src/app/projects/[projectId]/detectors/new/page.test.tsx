// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getTemplate } from "@/features/detectors/templates";

type MockAvailableModels = {
  systemModels: Array<{
    provider: string;
    adapter: string;
    source: "system";
    models: Array<{ id: string; label: string; supported?: boolean }>;
  }>;
  byokProviders: Array<{
    provider: string;
    adapter: string;
    source: "byok";
    models: Array<{ id: string; label: string; supported?: boolean }>;
  }>;
};

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  mutateAsync: vi.fn().mockResolvedValue({ id: "det-1" }),
  project: undefined as { workspace_id: string } | undefined,
  availableModels: {
    byokProviders: [],
    systemModels: [
      {
        provider: "anthropic",
        adapter: "anthropic",
        source: "system",
        models: [{ id: "claude-4", label: "Claude 4" }],
      },
    ],
  } as MockAvailableModels,
  getAvailableLLMModels: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/features/detectors/hooks/use-detectors", () => ({
  useCreateDetector: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
}));
vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: mocks.project }),
}));
vi.mock("@/features/projects/components", () => ({
  ProjectBreadcrumb: () => null,
}));
vi.mock("@/lib/api", () => ({
  getAvailableLLMModels: mocks.getAvailableLLMModels,
}));
vi.mock("@/features/detectors/components/trigger-editor", () => ({
  TriggerEditor: () => null,
}));
vi.mock("@/features/detectors/components/agent-model-link", () => ({
  AgentModelLink: () => null,
}));
vi.mock("@/features/detectors/components/rca-toggle", () => ({
  RcaToggle: () => null,
}));

import NewDetectorPage from "./page";

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <NewDetectorPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.project = { workspace_id: "workspace-1" };
  mocks.availableModels = {
    byokProviders: [],
    systemModels: [
      {
        provider: "anthropic",
        adapter: "anthropic",
        source: "system",
        models: [{ id: "claude-4", label: "Claude 4" }],
      },
    ],
  };
  mocks.getAvailableLLMModels.mockImplementation(async () => mocks.availableModels);
});

afterEach(() => {
  cleanup();
  mocks.mutateAsync.mockClear();
  mocks.push.mockClear();
  mocks.getAvailableLLMModels.mockReset();
});

describe("NewDetectorPage", () => {
  it("submits the selected template's defaults", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create Detector" })).not.toHaveProperty(
        "disabled",
        true,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Detector" }));

    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(1));
    const failure = getTemplate("failure")!;
    expect(mocks.mutateAsync).toHaveBeenCalledWith({
      name: "Failure Detector",
      template: "failure",
      prompt: failure.prompt,
      outputSchema: failure.outputSchema,
      triggerConditions: failure.defaultConditions,
      sampleRate: 25,
      enabled: true,
      enableRca: true,
      detectionModel: "claude-4",
      detectionProvider: "anthropic",
      detectionSource: "system",
    });
    expect(mocks.push).toHaveBeenCalledWith("/projects/proj-1/detectors");
  });

  it("submits user-edited name and prompt over the template defaults", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create Detector" })).not.toHaveProperty(
        "disabled",
        true,
      ),
    );

    fireEvent.change(screen.getByDisplayValue("Failure Detector"), {
      target: { value: "My detector" },
    });
    fireEvent.change(document.querySelector("textarea")!, {
      target: { value: "my prompt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Detector" }));

    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledTimes(1));
    expect(mocks.mutateAsync.mock.calls[0][0]).toMatchObject({
      name: "My detector",
      prompt: "my prompt",
      template: "failure",
    });
  });

  it("shows server model-validation errors inline without navigating", async () => {
    mocks.mutateAsync.mockRejectedValueOnce(
      new Error("Selected system provider is not available for this workspace"),
    );
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create Detector" })).not.toHaveProperty(
        "disabled",
        true,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Detector" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Selected system provider is not available for this workspace",
    );
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("keeps Create Detector disabled while workspace models are loading", async () => {
    mocks.getAvailableLLMModels.mockImplementation(
      () => new Promise<MockAvailableModels>(() => {}),
    );

    renderPage();

    await waitFor(() => expect(mocks.getAvailableLLMModels).toHaveBeenCalledWith("workspace-1"));
    expect(screen.getByText(/Loading workspace models before detector creation/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Create Detector" })).toHaveProperty(
      "disabled",
      true,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Detector" }));
    fireEvent.submit(document.querySelector("form")!);

    expect(mocks.mutateAsync).not.toHaveBeenCalled();
  });

  it("keeps Create Detector disabled when workspace models cannot be loaded", async () => {
    mocks.getAvailableLLMModels.mockRejectedValue(new Error("model lookup failed"));

    renderPage();

    expect(await screen.findByText("Models unavailable")).toBeDefined();
    expect(screen.getByText(/Unable to load workspace models/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Create Detector" })).toHaveProperty(
      "disabled",
      true,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Detector" }));
    fireEvent.submit(document.querySelector("form")!);

    expect(mocks.mutateAsync).not.toHaveBeenCalled();
  });

  it("does not default the detector model when the workspace has no available models", async () => {
    mocks.availableModels = {
      byokProviders: [],
      systemModels: [],
    };

    renderPage();

    expect(await screen.findByText("No model configured")).toBeDefined();
    expect(mocks.getAvailableLLMModels).toHaveBeenCalledWith("workspace-1");
    expect(screen.getByText(/No supported model is configured/)).toBeDefined();
    expect(screen.getByText(/ANTHROPIC_API_KEY/)).toBeDefined();
    expect(
      screen.getByRole("link", { name: "Configure model providers" }).getAttribute("href"),
    ).toBe("/workspaces/workspace-1/settings/model-providers");
    expect(screen.getByRole("button", { name: "Create Detector" })).toHaveProperty(
      "disabled",
      true,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Detector" }));
    fireEvent.submit(document.querySelector("form")!);

    expect(mocks.mutateAsync).not.toHaveBeenCalled();
  });

  it("does not allow detector creation when only unsupported BYOK models are configured", async () => {
    mocks.availableModels = {
      systemModels: [],
      byokProviders: [
        {
          provider: "openai-compatible",
          adapter: "openai",
          source: "byok",
          models: [{ id: "legacy-local", label: "Legacy Local", supported: false }],
        },
      ],
    };

    renderPage();

    expect(await screen.findByText("No supported models")).toBeDefined();
    expect(screen.getByText(/none expose Traceroot-supported models/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Create Detector" })).toHaveProperty(
      "disabled",
      true,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create Detector" }));
    fireEvent.submit(document.querySelector("form")!);

    expect(mocks.mutateAsync).not.toHaveBeenCalled();
    expect(screen.queryByText("Legacy Local")).toBeNull();
  });
});
