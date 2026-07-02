// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { getTemplate } from "../templates";
import type { LLMModelsResponse } from "@/lib/api";

const mocks = vi.hoisted(() => {
  const defaultModels: LLMModelsResponse = {
    byokProviders: [],
    systemModels: [
      {
        provider: "Anthropic",
        adapter: "anthropic",
        source: "system" as const,
        models: [{ id: "claude-haiku-4-5", label: "Claude Haiku 4.5" }],
      },
    ],
  };

  return {
    mutateAsync: vi.fn(),
    defaultModels,
    models: defaultModels as LLMModelsResponse | undefined,
    isLoading: false,
    isError: false,
  };
});

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: mocks.models,
    isLoading: mocks.isLoading,
    isError: mocks.isError,
  }),
}));

vi.mock("@/lib/api", () => ({
  getAvailableLLMModels: vi.fn(),
}));

vi.mock("../hooks/use-detectors", () => ({
  useCreateDetector: () => ({ mutateAsync: mocks.mutateAsync }),
}));

import { AddDetectorsStep } from "./add-detectors-step";

function renderStep() {
  const onDone = vi.fn();
  render(
    <AddDetectorsStep
      projectId="proj-1"
      projectName="checkout-agent"
      workspaceId="workspace-1"
      onDone={onDone}
    />,
  );
  return { onDone };
}

const pill = (label: string) => screen.getByRole("button", { name: label });
const continueButton = () => screen.getByRole("button", { name: "Continue" });

afterEach(() => {
  cleanup();
  mocks.mutateAsync.mockReset();
  mocks.models = mocks.defaultModels;
  mocks.isLoading = false;
  mocks.isError = false;
});

describe("AddDetectorsStep", () => {
  it("renders the five quick-add templates and no Blank pill", () => {
    renderStep();
    for (const label of ["Failure", "Hallucination", "Logic Error", "Task Completion", "Safety"]) {
      expect(pill(label)).toBeDefined();
    }
    expect(screen.queryByRole("button", { name: "Blank" })).toBeNull();
    expect(screen.getByText("checkout-agent")).toBeDefined();
  });

  it("shows the description of the hovered template", () => {
    renderStep();
    fireEvent.mouseEnter(pill("Safety"));
    expect(screen.getByText(getTemplate("safety")!.description)).toBeDefined();
    fireEvent.mouseEnter(pill("Failure"));
    expect(screen.getByText(getTemplate("failure")!.description)).toBeDefined();
    // clicking selects but does not move the description
    fireEvent.click(pill("Safety"));
    expect(screen.getByText(getTemplate("failure")!.description)).toBeDefined();
  });

  it("calls onDone without posting when continuing with nothing selected", () => {
    const { onDone } = renderStep();
    fireEvent.click(continueButton());
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("calls onDone on skip", () => {
    const { onDone } = renderStep();
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("blocks selected quick-add templates before posting when no detector model is available", () => {
    mocks.models = { byokProviders: [], systemModels: [] };
    renderStep();

    fireEvent.click(pill("Failure"));

    expect(screen.getByText("No supported detector model is configured yet.")).toBeDefined();
    expect(screen.getByText(/Self-hosted deployments need an admin/).textContent).toContain(
      "OPENAI_API_KEY",
    );
    expect(
      screen.getByRole("link", { name: "Configure BYOK providers" }).getAttribute("href"),
    ).toBe("/workspaces/workspace-1/settings/model-providers");
    expect((continueButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(continueButton());
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
  });

  it("blocks selected quick-add templates while detector models are loading", () => {
    mocks.models = undefined;
    mocks.isLoading = true;
    renderStep();

    fireEvent.click(pill("Failure"));

    expect(
      screen.getByText("Loading detector models before quick-add can continue."),
    ).toBeDefined();
    expect((continueButton() as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
  });

  it("blocks selected quick-add templates when detector models cannot be loaded", () => {
    mocks.models = undefined;
    mocks.isError = true;
    renderStep();

    fireEvent.click(pill("Failure"));

    expect(
      screen.getByText(
        "Unable to load workspace models. Refresh this page before adding detectors.",
      ),
    ).toBeDefined();
    expect(screen.queryByText(/Self-hosted deployments need an admin/)).toBeNull();
    expect(screen.queryByRole("link", { name: "Configure BYOK providers" })).toBeNull();
    expect((continueButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(continueButton());
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
  });

  it("blocks selected quick-add templates when only unsupported BYOK models are configured", () => {
    mocks.models = {
      systemModels: [],
      byokProviders: [
        {
          provider: "legacy-provider",
          adapter: "openai",
          source: "byok",
          models: [{ id: "legacy-local", label: "Legacy Local", supported: false }],
        },
      ],
    };
    renderStep();

    fireEvent.click(pill("Failure"));

    expect(
      screen.getByText("Configured providers only expose unsupported detector models."),
    ).toBeDefined();
    expect(
      screen.getByText(/A provider is configured, but its models are not supported/),
    ).toBeDefined();
    expect(screen.queryByText(/Self-hosted deployments need an admin/)).toBeNull();
    expect(
      screen.getByRole("link", { name: "Configure BYOK providers" }).getAttribute("href"),
    ).toBe("/workspaces/workspace-1/settings/model-providers");
    expect((continueButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(continueButton());
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
  });

  it("allows quick-add templates when a supported BYOK detector model is configured", async () => {
    mocks.models = {
      systemModels: [],
      byokProviders: [
        {
          provider: "workspace-openai",
          adapter: "openai",
          source: "byok",
          models: [{ id: "gpt-5.4-mini", label: "GPT 5.4 mini", supported: true }],
        },
      ],
    };
    mocks.mutateAsync.mockResolvedValue({ id: "det-1" });
    const { onDone } = renderStep();

    fireEvent.click(pill("Failure"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect((continueButton() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(continueButton());

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(mocks.mutateAsync).toHaveBeenCalledTimes(1);
    expect(mocks.mutateAsync.mock.calls[0][0]).toMatchObject({ template: "failure" });
  });

  it("creates one detector per selected template with the shared defaults", async () => {
    mocks.mutateAsync.mockResolvedValue({ id: "det-1" });
    const { onDone } = renderStep();
    fireEvent.click(pill("Failure"));
    fireEvent.click(pill("Safety"));
    fireEvent.click(continueButton());

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(mocks.mutateAsync).toHaveBeenCalledTimes(2);
    const payloads = mocks.mutateAsync.mock.calls.map((c) => c[0]);
    expect(payloads).toContainEqual(
      expect.objectContaining({
        template: "failure",
        name: "Failure Detector",
        sampleRate: 25,
        enableRca: true,
      }),
    );
    expect(payloads).toContainEqual(expect.objectContaining({ template: "safety" }));
  });

  it("deselecting a pill removes it from the submission", async () => {
    mocks.mutateAsync.mockResolvedValue({ id: "det-1" });
    const { onDone } = renderStep();
    fireEvent.click(pill("Failure"));
    fireEvent.click(pill("Safety"));
    fireEvent.click(pill("Failure")); // toggle back off
    fireEvent.click(continueButton());

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(mocks.mutateAsync).toHaveBeenCalledTimes(1);
    expect(mocks.mutateAsync.mock.calls[0][0]).toMatchObject({ template: "safety" });
  });

  it("keeps failed templates selected with an inline error, and retries only those", async () => {
    mocks.mutateAsync.mockImplementation((input: { template: string }) =>
      input.template === "safety"
        ? Promise.reject(new Error("Failed to create detector: 500"))
        : Promise.resolve({ id: "det-1" }),
    );
    const { onDone } = renderStep();
    fireEvent.click(pill("Failure"));
    fireEvent.click(pill("Safety"));
    fireEvent.click(continueButton());

    await waitFor(() => expect(screen.getByText(/Couldn't create: Safety/)).toBeDefined());
    expect(onDone).not.toHaveBeenCalled();

    // Retry: only the failed template is re-posted
    mocks.mutateAsync.mockClear();
    mocks.mutateAsync.mockResolvedValue({ id: "det-2" });
    fireEvent.click(continueButton());

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(mocks.mutateAsync).toHaveBeenCalledTimes(1);
    expect(mocks.mutateAsync.mock.calls[0][0]).toMatchObject({ template: "safety" });
  });

  it("shows model-configuration guidance when quick-add fails on missing providers", async () => {
    mocks.mutateAsync.mockRejectedValue(
      new Error(
        "Detector model selection is required. Choose a configured system model or BYOK provider.",
      ),
    );
    renderStep();
    fireEvent.click(pill("Failure"));
    fireEvent.click(continueButton());

    await waitFor(() =>
      expect(
        screen.getByText(
          "Detector model selection is required. Choose a configured system model or BYOK provider.",
        ),
      ).toBeDefined(),
    );
    expect(screen.getByText(/No supported detector model is configured yet/).textContent).toContain(
      "ANTHROPIC_API_KEY",
    );
    expect(
      screen.getByRole("link", { name: "Configure BYOK providers" }).getAttribute("href"),
    ).toBe("/workspaces/workspace-1/settings/model-providers");
  });
});
