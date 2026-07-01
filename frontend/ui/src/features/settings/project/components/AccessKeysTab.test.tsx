// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  getAccessKeys: vi.fn().mockResolvedValue({ access_keys: [] }),
  createAccessKey: vi.fn(),
  updateAccessKey: vi.fn(),
  deleteAccessKey: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  getAccessKeys: (...args: unknown[]) => mocks.getAccessKeys(...args),
  createAccessKey: (...args: unknown[]) => mocks.createAccessKey(...args),
  updateAccessKey: (...args: unknown[]) => mocks.updateAccessKey(...args),
  deleteAccessKey: (...args: unknown[]) => mocks.deleteAccessKey(...args),
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div role="tooltip">{children}</div>,
}));

import { AccessKeysTab } from "./AccessKeysTab";

function renderAccessKeysTab() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <AccessKeysTab projectId="proj_123" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  mocks.getAccessKeys.mockReset().mockResolvedValue({ access_keys: [] });
  mocks.createAccessKey.mockReset();
  mocks.updateAccessKey.mockReset();
  mocks.deleteAccessKey.mockReset();
});

describe("AccessKeysTab", () => {
  it("explains what the Project API Keys info icon means", () => {
    renderAccessKeysTab();

    const trigger = screen.getByRole("button", { name: /about project api keys/i });
    expect(trigger).toBeDefined();
    expect(trigger.getAttribute("title")).toMatch(/authenticate traceroot sdk and api requests/i);

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toMatch(/authenticate traceroot sdk and api requests/i);
    expect(tooltip.textContent).toMatch(/full secret is shown only once/i);
  });
});
