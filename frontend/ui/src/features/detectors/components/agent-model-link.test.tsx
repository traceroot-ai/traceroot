// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  data: undefined as
    | {
        systemModels: Array<{ provider: string; adapter: string; models: unknown[] }>;
        byokProviders: Array<{
          provider: string;
          adapter: string;
          models: Array<{ id: string; label: string; supported?: boolean }>;
        }>;
      }
    | undefined,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: mocks.data, isPending: false }),
}));
vi.mock("@/lib/api", () => ({ getAvailableLLMModels: vi.fn() }));

import { AgentModelLink } from "./agent-model-link";

const openAIRow = (ids: string[]) => ({
  systemModels: [],
  byokProviders: [
    {
      provider: "my-openai",
      adapter: "openai",
      models: ids.map((id) => ({ id, label: id, supported: true })),
    },
  ],
});

beforeEach(() => {
  mocks.data = undefined;
});
afterEach(cleanup);

describe("AgentModelLink", () => {
  it("labels an unset RCA model with the default chat model, not the decision alias", () => {
    mocks.data = openAIRow(["gpt-6-luna-decisions", "gpt-6-luna"]);
    render(<AgentModelLink projectId="proj-1" workspaceId="ws-1" />);
    expect(screen.getByRole("link").textContent).toBe("gpt-6-luna");
  });

  it("falls back to Default when only a decision model is configured", () => {
    mocks.data = openAIRow(["gpt-6-luna-decisions"]);
    render(<AgentModelLink projectId="proj-1" workspaceId="ws-1" />);
    expect(screen.getByRole("link").textContent).toBe("Default");
  });

  it("labels a set RCA model by its catalog label", () => {
    mocks.data = openAIRow(["gpt-6-luna"]);
    render(<AgentModelLink projectId="proj-1" rcaModel="gpt-6-luna" workspaceId="ws-1" />);
    expect(screen.getByRole("link").textContent).toBe("gpt-6-luna");
    expect(screen.getByRole("link").getAttribute("href")).toBe(
      "/projects/proj-1/settings/detectors",
    );
  });
});
